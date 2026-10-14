import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import pg from "pg";

import { collectKpi } from "./collect.js";
import { kpiUsage, parseKpiArgs, resolveConnection } from "./connection.js";
import { renderMarkdown } from "./render.js";

// Usage: npm run kpi -- --db <connection.json | postgres url> [--out report.md] [--json report.json]
// Read-only: the session is opened with default_transaction_read_only. Progress goes to stderr,
// the Markdown report to --out or stdout. The report contains aggregates only and no secrets.

async function writeFileEnsuringDirectory(path: string, content: string): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

try {
  const command = parseKpiArgs(process.argv.slice(2));
  if (command.kind === "help") {
    console.info(kpiUsage);
  } else {
    const connection = await resolveConnection(command.db);
    const client = new pg.Client({
      connectionString: connection.connectionString,
      options: "-c default_transaction_read_only=on -c statement_timeout=120000",
      connectionTimeoutMillis: 10_000
    });
    await client.connect();
    try {
      console.error(
        `[kpi] reading ${connection.info.host}:${connection.info.port ?? "?"}/${connection.info.name}`
      );
      const report = await collectKpi(client, {
        asOf: command.asOf,
        stuckMinutes: command.stuckMinutes,
        label: command.label ?? connection.label,
        connection: connection.info
      });
      const markdown = renderMarkdown(report);
      if (command.json) {
        await writeFileEnsuringDirectory(command.json, `${JSON.stringify(report, null, 2)}\n`);
        console.error(`[kpi] wrote ${command.json}`);
      }
      if (command.out) {
        await writeFileEnsuringDirectory(command.out, markdown);
        console.error(`[kpi] wrote ${command.out}`);
      } else {
        console.info(markdown);
      }
    } finally {
      await client.end();
    }
  }
} catch (error) {
  // Driver errors can echo the connection string; report only a content-free summary.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[kpi] ${message.replace(/postgres(ql)?:\/\/\S+/giu, "postgres://***")}`);
  console.error("Run with --help for usage.");
  process.exitCode = 1;
}
