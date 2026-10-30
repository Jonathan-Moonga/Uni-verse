import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { createSupabaseAuth } from "../server/auth-supabase.mjs";

loadEnvFile(resolve(import.meta.dirname, "..", ".env"));

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) throw new Error("Supabase environment variables are incomplete");

const auth = createSupabaseAuth({ url, anonKey, serviceKey });
const settings = await auth.settings();
if (!settings.ok) throw new Error(`Supabase Auth readiness failed (${settings.status})`);

const response = await fetch(`${url}/rest/v1/buildings?select=id&limit=1`, {
  headers: { apikey: anonKey }
});
if (!response.ok) throw new Error(`Supabase Data API readiness failed (${response.status})`);
const buildings = await response.json();
if (!Array.isArray(buildings) || buildings.length !== 1) throw new Error("Supabase reference data is missing");

console.log("Supabase Auth, Data API, schema permissions, and reference data are ready.");
