/**
 * Scores a library against the matching-quality fixture: expected and forbidden root pairs per
 * partition (from note relations and source relations aggregated to roots) and the cost of the
 * reranking calls per note.
 *
 *   npx tsx scripts/golden/evaluate-matching.ts --db <connection.json | postgres url> [options]
 *
 * Read-only (default_transaction_read_only plus a read-only transaction). The report holds counts
 * and root ids only: no note text, no relation explanations, no password.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  checkExitCode,
  evaluateMatching,
  renderEvaluationMarkdown
} from "./matching-evaluation.ts";
import {
  evaluateUsage,
  parseEvaluateArgs,
  readBenchmarkIds,
  readLibrary,
  readMapping,
  resolveEvaluationConnection
} from "./matching-evaluation-db.ts";

async function write(path: string, content: string): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

try {
  const command = parseEvaluateArgs(process.argv.slice(2));
  if (command.kind === "help") {
    console.info(evaluateUsage);
  } else {
    const mapping = await readMapping(command.mapping);
    const ids = command.ids ? await readBenchmarkIds(command.ids) : undefined;
    const connection = await resolveEvaluationConnection(command.db);
    console.error(`[evaluate-matching] reading ${connection.description}`);
    const input = await readLibrary(connection, mapping, {
      tasks: command.tasks,
      since: command.since,
      until: command.until,
      ids
    });
    const evaluation = evaluateMatching(input, command.options, command.tasks);
    const markdown = renderEvaluationMarkdown(evaluation, {
      label: command.label,
      database: connection.description,
      fixtureSha256: mapping.fixture.sha256
    });
    if (command.json) {
      await write(
        command.json,
        `${JSON.stringify(
          {
            ...evaluation,
            context: {
              label: command.label,
              database: connection.description,
              fixture: mapping.fixture,
              manifest: mapping.manifest,
              idsFile: command.ids,
              window: { since: command.since?.toISOString(), until: command.until?.toISOString() },
              generatedAt: new Date().toISOString()
            }
          },
          null,
          2
        )}\n`
      );
      console.error(`[evaluate-matching] wrote ${command.json}`);
    }
    if (command.out) {
      await write(command.out, markdown);
      console.error(`[evaluate-matching] wrote ${command.out}`);
    } else console.info(markdown);
    if (command.check) process.exitCode = checkExitCode(evaluation.exit.pass);
  }
} catch (error) {
  // Driver errors can echo the connection string; report only a content-free summary.
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[evaluate-matching] ${message.replace(/postgres(ql)?:\/\/\S+/giu, "postgres://***")}`
  );
  console.error("Run with --help for usage.");
  process.exitCode = 1;
}
