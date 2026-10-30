import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRef = process.argv[2];
if (!/^[a-z]{20}$/.test(projectRef || "")) {
  throw new Error("Usage: node scripts/configure-supabase-env.mjs <project-ref>");
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const raw = Buffer.concat(chunks).toString("utf8");
const start = raw.indexOf("[");
const end = raw.lastIndexOf("]");
if (start < 0 || end < start) throw new Error("Supabase CLI did not return API-key JSON");

const keys = JSON.parse(raw.slice(start, end + 1));
const publishable = keys.find((key) => key.type === "publishable")?.api_key
  ?? keys.find((key) => key.id === "anon")?.api_key;
const secret = keys.find((key) => key.type === "secret" && !key.api_key.includes("·"))?.api_key
  ?? keys.find((key) => key.id === "service_role")?.api_key;

if (!publishable || !secret) throw new Error("Required Supabase API keys were not returned");

const envPath = resolve(import.meta.dirname, "..", ".env");
let source = "";
try {
  source = await readFile(envPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const values = new Map();
for (const line of source.split(/\r?\n/)) {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match) values.set(match[1], match[2]);
}

values.set("SUPABASE_PROJECT_REF", projectRef);
values.set("SUPABASE_URL", `https://${projectRef}.supabase.co`);
values.set("SUPABASE_ANON_KEY", publishable);
values.set("SUPABASE_SERVICE_ROLE_KEY", secret);

const preferredOrder = [
  "SUPABASE_PROJECT_REF",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "OLLAMA_TIMEOUT_MS",
  "RESEND_API_KEY",
  "MAIL_FROM"
];

const ordered = [];
for (const key of preferredOrder) {
  if (values.has(key) && values.get(key) !== "") ordered.push(`${key}=${values.get(key)}`);
  values.delete(key);
}
for (const [key, value] of values) ordered.push(`${key}=${value}`);

await writeFile(envPath, `${ordered.join("\n")}\n`, { mode: 0o600 });
console.log("Configured SUPABASE_PROJECT_REF, SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY in .env");
