import { createServer } from "node:http";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { createApp } from "./app.mjs";
import { defaultDataDir, openDatabase } from "./db.mjs";
import { openPostgresDatabase } from "./db-postgres.mjs";
import { createLocalAuth } from "./auth-local.mjs";
import { createSupabaseAuth } from "./auth-supabase.mjs";
import { createMailer } from "./mailer.mjs";

try {
  loadEnvFile(resolve(import.meta.dirname, "..", ".env"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const publicUrl = process.env.PUBLIC_URL || `http://${host}:${port}`;
const devMode = process.env.NODE_ENV !== "production";
const useSupabase = Boolean(process.env.DATABASE_URL);
const dataDir = useSupabase ? null : defaultDataDir();
const db = useSupabase
  ? await openPostgresDatabase({ connectionString: process.env.DATABASE_URL })
  : await openDatabase({ dataDir, demo: devMode });
const mailer = createMailer({
  resendApiKey: process.env.RESEND_API_KEY,
  from: process.env.MAIL_FROM,
  log: devMode
});
const auth = useSupabase
  ? createSupabaseAuth({
      url: process.env.SUPABASE_URL,
      anonKey: process.env.SUPABASE_ANON_KEY,
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      redirectUrl: publicUrl
    })
  : createLocalAuth({ db, mailer, publicUrl });
const handler = createApp({ db, auth, mailer, publicUrl, devMode: devMode && !useSupabase });

const sweep = async () => {
  try {
    await db.asService(async (tx) => {
      await tx.query("select public.expire_lapsed_access()");
      await tx.query("delete from server_private.sessions where expires_at < now()");
    });
  } catch (error) {
    console.error("Expiry sweep failed", error);
  }
};
await sweep();
setInterval(sweep, 10 * 60_000).unref();

const server = createServer(handler).listen(port, host, () => {
  console.log(`Tiger Ops running at ${publicUrl}`);
  console.log(`Database: ${useSupabase ? "Supabase PostgreSQL" : dataDir}`);
  console.log(`Auth: ${auth.kind}`);
  if (devMode && !useSupabase) console.log(`Dev mailbox: ${publicUrl}/?mailbox`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await db.close();
    process.exit(0);
  });
}
