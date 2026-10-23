// A scratch PostgreSQL cluster from an APFS clone of a measurement profile's database (F4 T79, C3;
// gate M). The profile is only read: `cp -cR` makes a copy-on-write clone, and the cluster that
// runs on the clone is the one measured or migrated, never the profile.
//
//   npx tsx scripts/ask/scratch-cluster.ts start --from <profile>/database --to <scratch dir> --port <n>
//   npx tsx scripts/ask/scratch-cluster.ts stop --to <scratch dir>
//
// `start` clones `--from` to `--to` (refusing a `--to` that exists), starts the clone on the loopback
// port with the sidecar's own PostgreSQL, and writes `<scratch dir>/scratch-connection.json`
// ({ connectionString, slug, port, status }), the file `--db` of `scripts/ask/candidates-bench.ts`,
// `scripts/ask/migrate-timed.ts` and `npm run db:ask-text:verify` take. The password is the
// profile's own development credential and is never printed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { resolvePostgresSidecarPaths } from "@app/db";

const root = resolve(import.meta.dirname, "../..");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { from: { type: "string" }, to: { type: "string" }, port: { type: "string" } },
  strict: true
});
const command = positionals[0];
if ((command !== "start" && command !== "stop") || !values.to) {
  console.error(
    "Usage: scratch-cluster.ts start --from <profile>/database --to <dir> --port <n> | stop --to <dir>"
  );
  process.exit(2);
}
const scratch = resolve(values.to);
const bin = join(resolvePostgresSidecarPaths({ cwd: root, env: process.env }).binDir, "pg_ctl");
const data = join(scratch, "postgres-data");

if (command === "stop") {
  execFileSync(bin, ["-D", data, "-m", "fast", "-w", "stop"], { stdio: "inherit" });
  process.exit(0);
}

const port = Number(values.port);
if (!values.from || !Number.isInteger(port) || port < 1024 || port > 65_535) {
  console.error("start needs --from <profile>/database and --port <1024-65535>.");
  process.exit(2);
}
if (existsSync(scratch)) {
  console.error(`${scratch} exists: clone into a new directory.`);
  process.exit(2);
}
if (existsSync(join(resolve(values.from), "postgres-data/postmaster.pid"))) {
  console.error("The profile's cluster is running: stop it (or use a copy) before cloning.");
  process.exit(2);
}
// `cp -c` is the APFS clone: no data is copied until a page is written.
execFileSync("cp", ["-cR", resolve(values.from), scratch], { stdio: "inherit" });
const dev = JSON.parse(readFileSync(join(scratch, "dev-connection.json"), "utf8"));
const url = new URL(dev.connectionString);
url.port = String(port);
writeFileSync(
  join(scratch, "scratch-connection.json"),
  `${JSON.stringify({ connectionString: url.toString(), slug: `scratch-${port}`, port, status: "running" })}\n`,
  { mode: 0o600 }
);
execFileSync(
  bin,
  [
    "-D",
    data,
    "-l",
    join(scratch, "scratch-pg.log"),
    "-o",
    `-c listen_addresses=127.0.0.1 -c port=${port} -c password_encryption=scram-sha-256 -c unix_socket_directories=`,
    "-w",
    "start"
  ],
  { stdio: "inherit" }
);
console.info(`Scratch cluster on port ${port}: ${join(scratch, "scratch-connection.json")}`);
