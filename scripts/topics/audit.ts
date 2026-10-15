import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import pg from "pg";

import { resolveConnection } from "../kpi/connection.js";
import { auditDatabase } from "./audit-db.js";
import { auditUsage, parseAuditArgs, renderAuditMarkdown } from "./audit-render.js";

// Usage: npm run topics:audit -- --db <connection.json | postgres url> [--tree <uuid>] [--out report.md]
// Read-only: the session is opened with default_transaction_read_only. Progress goes to stderr, the
// Markdown report to --out or stdout. Exit code 0 when E1 holds, 1 when it does not, 2 on an error.

async function writeFileEnsuringDirectory(path: string, content: string): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

try {
  const command = parseAuditArgs(process.argv.slice(2));
  if (command.kind === "help") {
    console.info(auditUsage);
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
        `[topics:audit] reading ${connection.info.host}:${connection.info.port ?? "?"}/${connection.info.name}`
      );
      const report = await auditDatabase(client, {
        treeId: command.treeId,
        areas: command.areas,
        undoWindowDays: command.undoWindowDays,
        limit: command.limit,
        ...(command.asOf ? { asOf: command.asOf } : {})
      });
      const markdown = renderAuditMarkdown(report);
      if (command.json) {
        await writeFileEnsuringDirectory(command.json, `${JSON.stringify(report, null, 2)}\n`);
        console.error(`[topics:audit] wrote ${command.json}`);
      }
      if (command.out) {
        await writeFileEnsuringDirectory(command.out, markdown);
        console.error(`[topics:audit] wrote ${command.out}`);
      } else {
        console.info(markdown);
      }
      process.exitCode = report.summary.e1.passes ? 0 : 1;
    } finally {
      await client.end();
    }
  }
} catch (error) {
  // Driver errors can echo the connection string; report only a content-free summary.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[topics:audit] ${message.replace(/postgres(ql)?:\/\/\S+/giu, "postgres://***")}`);
  console.error("Run with --help for usage.");
  process.exitCode = 2;
}
