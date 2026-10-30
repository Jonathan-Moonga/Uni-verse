import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { referenceSeedSql } from "../server/seed.mjs";

const target = resolve(import.meta.dirname, "..", "supabase", "seed.sql");
await writeFile(target, referenceSeedSql());
console.log(`Wrote ${target}`);
