import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { referenceSeedSql } from "./seed.mjs";
import { seedDemo } from "./demo.mjs";
import { hashPassword } from "./auth.mjs";

const root = resolve(import.meta.dirname, "..");
const migrationsDir = resolve(root, "supabase", "migrations");

// Kept outside the project folder so OneDrive doesn't sync a live database.
export function defaultDataDir() {
  return process.env.TIGER_OPS_DATA_DIR || resolve(process.env.LOCALAPPDATA || resolve(homedir(), ".local", "share"), "tiger-ops", "pglite");
}

async function applied(pg, name) {
  const { rows } = await pg.query("select 1 from local.migrations where name = $1", [name]);
  return rows.length > 0;
}

async function record(pg, name) {
  await pg.query("insert into local.migrations (name) values ($1)", [name]);
}

// Same order Supabase uses: platform (shim locally) → migrations → seed.
async function migrate(pg, { demo }) {
  const { rows } = await pg.query("select to_regclass('local.migrations') as t");
  if (!rows[0].t) {
    await pg.exec(await readFile(resolve(root, "supabase", "local", "auth_shim.sql"), "utf8"));
  }

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    if (await applied(pg, file)) continue;
    await pg.exec(await readFile(resolve(migrationsDir, file), "utf8"));
    await record(pg, file);
  }

  // Reference data is idempotent, so it is refreshed on every boot.
  await pg.exec(referenceSeedSql());

  if (demo && !(await applied(pg, "seed:demo"))) {
    const auth = {
      async adminCreateUser({ email, password, metadata = {} }) {
        const { rows } = await pg.query(
          `insert into auth.users (email, encrypted_password, email_confirmed_at, raw_user_meta_data)
           values ($1, $2, now(), $3) returning id`,
          [String(email).toLowerCase(), await hashPassword(password), JSON.stringify(metadata)]
        );
        return rows[0].id;
      }
    };
    await seedDemo(pg, auth);
    await record(pg, "seed:demo");
  }
}

export async function openDatabase({ dataDir = null, demo = true } = {}) {
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  // This direct connection owns auth/session work. User requests temporarily
  // override the claim inside `asUser` transactions, then revert to service.
  await pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "service_role" })]);
  await migrate(pg, { demo });

  return {
    kind: "local",
    pg,
    // Runs as Supabase's `authenticated` role with the user's id in the JWT
    // claims, exactly how PostgREST executes requests, so RLS applies.
    async asUser(userId, fn) {
      return pg.transaction(async (tx) => {
        await tx.query("set local role authenticated");
        await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
        return fn(tx);
      });
    },
    async asAnon(fn) {
      return pg.transaction(async (tx) => {
        await tx.query("set local role anon");
        await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
        return fn(tx);
      });
    },
    // Owner privileges for the auth service only (sign-up, sessions, outbox).
    async asService(fn) {
      return pg.transaction(fn);
    },
    async close() {
      await pg.close();
    }
  };
}
