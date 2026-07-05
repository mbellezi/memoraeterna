import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyBaselineSeed } from "../seed.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");

const plan = await verifyBaselineSeed(migrationsFolder, seedFolder);

console.info(
  `Verified baseline seed ${plan.seedFile} with ${plan.includedMigrations.length} migration(s).`
);
