import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { z } from "zod";

import type { DatabaseInfo } from "./report.js";

export const kpiUsage = `Usage: npx tsx scripts/kpi/kpi.ts --db <connection.json | postgres url> [options]

  --db <value>          Scratch connection file (.cache/f0/scratch-<name>.json) or a postgres:// URL. Read-only.
  --out <file.md>       Write the Markdown report here (default: print to stdout).
  --json <file.json>    Also write the full report as JSON.
  --label <text>        Name for the report header (default: the connection file's slug or the database name).
  --as-of <iso|now>     Instant that "now" means for stuck jobs (default: the latest recorded activity).
  --stuck-minutes <n>   Minutes without progress before a job counts as stuck (default: 15).
  --help                Show this text.

The report holds aggregates only. The password in a connection file or URL is never printed.`;

export interface KpiArgs {
  readonly db: string;
  readonly out: string | null;
  readonly json: string | null;
  readonly label: string | null;
  readonly asOf: Date | "now" | null;
  readonly stuckMinutes: number;
}

export type KpiCommand = { readonly kind: "help" } | ({ readonly kind: "run" } & KpiArgs);

export function parseKpiArgs(argv: readonly string[]): KpiCommand {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      db: { type: "string" },
      out: { type: "string" },
      json: { type: "string" },
      label: { type: "string" },
      "as-of": { type: "string" },
      "stuck-minutes": { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return { kind: "help" };
  if (!values.db) throw new Error("--db is required.");

  let asOf: Date | "now" | null = null;
  if (values["as-of"] !== undefined) {
    if (values["as-of"] === "now") asOf = "now";
    else {
      const parsed = new Date(values["as-of"]);
      if (Number.isNaN(parsed.getTime()))
        throw new Error(`--as-of must be "now" or an ISO timestamp, got "${values["as-of"]}".`);
      asOf = parsed;
    }
  }
  const stuckText = values["stuck-minutes"] ?? "15";
  const stuckMinutes = Number(stuckText);
  if (!Number.isInteger(stuckMinutes) || stuckMinutes < 1 || stuckMinutes > 10_080)
    throw new Error(`--stuck-minutes must be an integer between 1 and 10080, got "${stuckText}".`);

  return {
    kind: "run",
    db: values.db,
    out: values.out ?? null,
    json: values.json ?? null,
    label: values.label ?? null,
    asOf,
    stuckMinutes
  };
}

const connectionFileSchema = z
  .object({
    connectionString: z.string().min(1),
    slug: z.string().optional(),
    status: z.string().optional(),
    restored: z
      .object({
        sourcePath: z.string().optional(),
        sha256: z.string().optional(),
        dumpCreatedAt: z.string().nullable().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export interface ResolvedConnection {
  /** Contains the password: pass it to the driver only. */
  readonly connectionString: string;
  readonly label: string | null;
  readonly info: {
    readonly host: string;
    readonly port: number | null;
    readonly name: string;
    readonly provenance: DatabaseInfo["provenance"];
  };
}

const lastSegments = (path: string): string =>
  path.split(/[\\/]/u).filter(Boolean).slice(-2).join("/");

export function describeConnectionString(connectionString: string): {
  host: string;
  port: number | null;
  name: string;
} {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("The connection string is not a valid postgres:// URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new Error("The connection string must use the postgres:// or postgresql:// scheme.");
  return {
    host: url.hostname || "localhost",
    port: url.port ? Number(url.port) : null,
    name: decodeURIComponent(url.pathname.replace(/^\//u, "")) || "postgres"
  };
}

export async function resolveConnection(value: string): Promise<ResolvedConnection> {
  if (/^postgres(ql)?:\/\//iu.test(value)) {
    return {
      connectionString: value,
      label: null,
      info: { ...describeConnectionString(value), provenance: null }
    };
  }
  let raw: string;
  try {
    raw = await readFile(value, "utf8");
  } catch {
    throw new Error(`Cannot read the connection file "${value}".`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The connection file "${value}" is not valid JSON.`);
  }
  const file = connectionFileSchema.safeParse(parsed);
  if (!file.success)
    throw new Error(`The connection file "${value}" has no "connectionString" field.`);
  if (file.data.status === "stopped")
    throw new Error(
      `The scratch cluster in "${value}" is stopped. Start it again (restore-backup.ts --from <dump> --name <slug> --keep-running) before measuring.`
    );
  const restored = file.data.restored;
  return {
    connectionString: file.data.connectionString,
    label: file.data.slug ?? null,
    info: {
      ...describeConnectionString(file.data.connectionString),
      provenance:
        restored?.sourcePath && restored.sha256
          ? {
              sourceName: lastSegments(restored.sourcePath),
              sha256: restored.sha256,
              dumpCreatedAt: restored.dumpCreatedAt ?? null
            }
          : null
    }
  };
}
