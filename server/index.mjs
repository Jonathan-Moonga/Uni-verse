import { createServer } from "node:http";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { createApp } from "./app.mjs";
import { defaultDataDir, openDatabase } from "./db.mjs";

try {
  loadEnvFile(resolve(import.meta.dirname, "..", ".env"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const publicUrl = process.env.PUBLIC_URL || `http://${host}:${port}`;
const devMode = process.env.NODE_ENV !== "production";
const dataDir = defaultDataDir();

const db = await openDatabase({ dataDir, demo: devMode });
const handler = createApp({ db, publicUrl, devMode });

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
  console.log(`Database: ${dataDir}`);
  if (devMode) console.log(`Dev mailbox: ${publicUrl}/?mailbox`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await db.close();
    process.exit(0);
  });
}
