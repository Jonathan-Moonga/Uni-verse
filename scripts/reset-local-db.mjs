import { rm } from "node:fs/promises";
import { defaultDataDir } from "../server/db.mjs";

const dir = defaultDataDir();
await rm(dir, { recursive: true, force: true });
console.log(`Deleted local database at ${dir}. It will be recreated with demo data on the next npm run dev.`);
