// Vercel serverless entry point. Every /api/* request is rewritten here
// (see vercel.json) and handed to the same handler `npm run dev` uses.
// The static frontend in dist/ is served by Vercel's CDN.
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.mjs";
import { openDatabase } from "../server/db.mjs";
import { openPostgresDatabase } from "../server/db-postgres.mjs";
import { createLocalAuth } from "../server/auth-local.mjs";
import { createSupabaseAuth } from "../server/auth-supabase.mjs";
import { createMailer } from "../server/mailer.mjs";

let ready;

async function build() {
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const publicUrl = process.env.PUBLIC_URL && !process.env.PUBLIC_URL.includes("127.0.0.1")
    ? process.env.PUBLIC_URL
    : vercelUrl ? `https://${vercelUrl}` : "http://localhost:3000";
  const useSupabase = Boolean(process.env.DATABASE_URL);

  // Without DATABASE_URL, fall back to the in-memory demo database. Vercel's
  // filesystem is read-only except /tmp, and data there doesn't persist.
  const db = useSupabase
    ? await openPostgresDatabase({ connectionString: process.env.DATABASE_URL })
    : await openDatabase({ dataDir: resolve(tmpdir(), "tiger-ops-pglite"), demo: true });

  const mailer = createMailer({
    resendApiKey: process.env.RESEND_API_KEY,
    from: process.env.MAIL_FROM,
    log: !useSupabase
  });
  const auth = useSupabase
    ? createSupabaseAuth({
        url: process.env.SUPABASE_URL,
        anonKey: process.env.SUPABASE_ANON_KEY,
        serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        redirectUrl: publicUrl
      })
    : createLocalAuth({ db, mailer, publicUrl });

  // Serverless has no long-lived timer, so run the expiry sweep on cold start.
  try {
    await db.asService(async (tx) => {
      await tx.query("select public.expire_lapsed_access()");
      await tx.query("delete from server_private.sessions where expires_at < now()");
    });
  } catch (error) {
    console.error("Expiry sweep failed", error);
  }

  return createApp({ db, auth, mailer, publicUrl, devMode: !useSupabase });
}

export default async function handler(request, response) {
  // Vercel serves over HTTPS, but the app's cross-origin check only treats
  // http://<host> as same-origin. A same-host HTTPS origin is same-origin too.
  const { origin, host } = request.headers;
  if (origin && host && origin === `https://${host}`) delete request.headers.origin;

  // Vercel requests have no socket, but the sign-in rate limiter keys on the
  // client IP. Use the address Vercel forwards instead.
  if (!request.socket) {
    const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const remoteAddress = request.headers["x-real-ip"] || forwarded || "unknown";
    Object.defineProperty(request, "socket", { value: { remoteAddress }, configurable: true });
  }

  try {
    ready ??= build();
    const app = await ready;
    return app(request, response);
  } catch (error) {
    ready = undefined; // retry setup on the next request
    console.error("Tiger Ops failed to start", error);
    response.statusCode = 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "Server failed to start. Check the deployment's environment variables." }));
  }
}
