// `npm run topics:export -- --db <dev-connection.json | scratch-<slug>.json | postgres url> --name <name>`
//
// Exports a profile's topic tree (tree, names, placements, gate log, change-sets, audit) and the
// replay store of its note vectors (T22a, D21). Read only: the session is opened with
// default_transaction_read_only, so it can be pointed at a running DEV profile (its
// `database/dev-connection.json`) or a scratch cluster without any risk to the data. The profile
// must be running (a stopped sidecar has nothing to connect to). Progress goes to stderr, a count-only
// summary to stdout; the connection string and its password are never printed or written.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import pg from "pg";

import { describeConnectionString, resolveConnection } from "../kpi/connection.js";
import { cacheRoot } from "./datasets.js";
import { assertExportName, createSqlTopicExportSource, exportTopicTree } from "./export-tree.js";

export const exportUsage = `Usage: npm run topics:export -- --db <value> --name <name> [options]

  --db <value>        DEV connection file (database/dev-connection.json), a scratch connection file
                      (.cache/f0/scratch-<name>.json) or a postgres:// URL. Read-only.
  --name <name>       Dataset name: lower case letters, digits and dashes (for example env-f).
  --label <text>      Free text for the export header.
  --tree <uuid>       Export this tree instead of the active one.
  --cache <folder>    Folder that holds topics/exports and topics/vectors (default: the repository
                      .cache, or MEMORA_TOPICS_CACHE).
  --no-vectors        Skip the replay store (the JSON export only).
  --force             Replace an export of the same name.
  --help              Show this text.

Writes <cache>/topics/exports/<name>/export.json and the replay store
<cache>/topics/vectors/<name>.{f32,index.jsonl,meta.json}, which \`npm run topics:replay\` loads.`;

export interface ExportArgs {
  db: string;
  name: string;
  label: string | null;
  treeId: string | null;
  cache: string;
  vectors: boolean;
  force: boolean;
}

export type ExportCommand = { kind: "help" } | ({ kind: "run" } & ExportArgs);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseExportArgs(argv: readonly string[]): ExportCommand {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      db: { type: "string" },
      name: { type: "string" },
      label: { type: "string" },
      tree: { type: "string" },
      cache: { type: "string" },
      "no-vectors": { type: "boolean" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return { kind: "help" };
  if (!values.db) throw new Error("--db is required.");
  if (!values.name) throw new Error("--name is required.");
  assertExportName(values.name);
  if (values.tree !== undefined && !uuidPattern.test(values.tree))
    throw new Error(`--tree must be a UUID, got "${values.tree}".`);
  if (values.label !== undefined && values.label.length > 200)
    throw new Error("--label is limited to 200 characters.");
  return {
    kind: "run",
    db: values.db,
    name: values.name,
    label: values.label ?? null,
    treeId: values.tree?.toLowerCase() ?? null,
    cache: values.cache ? resolve(values.cache) : cacheRoot(),
    vectors: values["no-vectors"] !== true,
    force: values.force === true
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const command = parseExportArgs(argv);
  if (command.kind === "help") {
    console.info(exportUsage);
    return 0;
  }
  const connection = await resolveConnection(command.db);
  const client = new pg.Client({
    connectionString: connection.connectionString,
    options: "-c default_transaction_read_only=on -c statement_timeout=300000",
    connectionTimeoutMillis: 10_000
  });
  await client.connect();
  try {
    console.error(
      `[topics:export] reading ${connection.info.host}:${connection.info.port ?? "?"}/${connection.info.name}`
    );
    // One snapshot: the tree, the notes and the vectors are read as of the same moment, even when
    // the profile is running and placing items meanwhile.
    await client.query("begin isolation level repeatable read read only");
    const result = await exportTopicTree(createSqlTopicExportSource(client), {
      name: command.name,
      ...(command.label ? { label: command.label } : {}),
      ...(command.treeId ? { treeId: command.treeId } : {}),
      vectors: command.vectors,
      force: command.force,
      cacheDirectory: command.cache,
      database: describeConnectionString(connection.connectionString)
    }).finally(() => client.query("rollback"));
    console.error(`[topics:export] wrote ${result.exportPath}`);
    if (result.vectorsDirectory)
      console.error(`[topics:export] replay store ${command.name} in ${result.vectorsDirectory}`);
    console.info(JSON.stringify(result.summary, null, 2));
    return 0;
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Driver errors can echo the connection string; report only a content-free summary.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[topics:export] ${message.replace(/postgres(ql)?:\/\/\S+/giu, "postgres://***")}`
      );
      console.error("Run with --help for usage.");
      process.exitCode = 1;
    }
  );
}
