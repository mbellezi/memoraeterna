import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const rootDir = process.cwd();
const force = process.argv.includes("--force");
const rootEnvPath = resolve(rootDir, ".env");
const desktopEnvPath = resolve(rootDir, "apps/desktop/.env");

const existing = force ? new Map() : await readExistingEnv(rootEnvPath);
const suffix = existing.get("MEMORA_DATABASE_NAME")?.replace(/^memora_dev_/, "") || randomHex(8);
const databaseName = existing.get("MEMORA_DATABASE_NAME") || `memora_dev_${suffix}`;
const databaseUser = existing.get("MEMORA_DATABASE_USER") || `memora_dev_${suffix}`;
const databasePassword = existing.get("MEMORA_DATABASE_PASSWORD") || randomHex(24);
const postgresPassword = existing.get("MEMORA_POSTGRES_SUPERUSER_PASSWORD") || randomHex(24);
const host = existing.get("MEMORA_DATABASE_HOST") || "127.0.0.1";
const port = existing.get("MEMORA_DATABASE_PORT") || "55432";
const postgresUser = existing.get("MEMORA_POSTGRES_SUPERUSER") || "postgres";
const databaseUrl = buildDatabaseUrl({
  user: databaseUser,
  password: databasePassword,
  host,
  port,
  database: databaseName
});

const env = [
  ["MEMORA_APP_ENV", existing.get("MEMORA_APP_ENV") || "development"],
  ["MEMORA_DATABASE_HOST", host],
  ["MEMORA_DATABASE_PORT", port],
  ["MEMORA_DATABASE_NAME", databaseName],
  ["MEMORA_DATABASE_USER", databaseUser],
  ["MEMORA_DATABASE_PASSWORD", databasePassword],
  ["MEMORA_DATABASE_URL", databaseUrl],
  ["MEMORA_POSTGRES_SUPERUSER", postgresUser],
  ["MEMORA_POSTGRES_SUPERUSER_PASSWORD", postgresPassword]
];

const content = `${env.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;

await writeEnv(rootEnvPath, content);
await writeEnv(desktopEnvPath, content);

console.info(
  [
    `Wrote ${relative(rootEnvPath)}`,
    `Wrote ${relative(desktopEnvPath)}`,
    force ? "Random database credentials were regenerated." : "Existing database credentials were preserved when present."
  ].join("\n")
);

function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function buildDatabaseUrl({ user, password, host, port, database }) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

async function readExistingEnv(path) {
  try {
    const raw = await readFile(path, "utf8");
    return new Map(
      raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const separator = line.indexOf("=");
          if (separator === -1) {
            return [line, ""];
          }
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );
  } catch {
    return new Map();
  }
}

async function writeEnv(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o600 });
}

function relative(path) {
  return path.replace(`${rootDir}/`, "");
}
