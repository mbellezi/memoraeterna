/**
 * Smoke test for the Decisions API: one tiny request per shape, using synthetic benchmark notes
 * only. It confirms the request/response shapes and the usage object, and probes the number of
 * questions one request accepts.
 *
 *   npx tsx scripts/spikes/decisions/smoke.ts [--probe-limits]
 *
 * Request 1: one relevant and one irrelevant candidate, predicate questions.
 * Request 2: the same candidates, predicate plus choice questions (typed configuration).
 * Probe: 40, 100 and 200 predicate questions on a short input (stops at the first failure).
 */
import { loadDataset, loadFrozen } from "../reranker/dataset.js";
import { pairKey } from "../reranker/metrics.js";

import { DecisionsClient, decisionsModel } from "./client.js";
import { buildRequest } from "./design.js";
import { readApiKey } from "./env.js";
import { runJobs, type Job } from "./runner.js";

const dataset = await loadDataset();
const frozen = await loadFrozen();
const noteById = new Map(dataset.notes.map((note) => [note.id, note]));
const expectedKeys = new Set(
  dataset.labels
    .filter((l) => l.partition === "tuning" && l.kind === "expected")
    .map((l) => pairKey(...l.pair))
);

// A tuning source note with an old-LLM-confirmed cross-root expected candidate and a candidate the
// old judge scored 0 on an unrelated root.
const economy = dataset.rows.filter((row) => row.phase === "economy");
let chosen: { query: string; relevant: string; irrelevant: string } | null = null;
for (const row of economy) {
  const a = noteById.get(row.query)!;
  const b = noteById.get(row.doc)!;
  if (a.root === b.root || row.oldLlm < 0.9 || !expectedKeys.has(pairKey(a.root, b.root))) continue;
  const other = economy.find((candidate) => {
    if (candidate.query !== row.query || candidate.oldLlm !== 0) return false;
    const c = noteById.get(candidate.doc)!;
    return c.root !== a.root && c.root !== b.root;
  });
  if (other) {
    chosen = { query: row.query, relevant: row.doc, irrelevant: other.doc };
    break;
  }
}
if (!chosen) throw new Error("No smoke pair found");

const ref = (id: string) => ({ id, text: noteById.get(id)!.text });
const jobs: Job[] = (["predicate", "typed"] as const).map((config) => {
  const built = buildRequest({
    key: `smoke-${config}`,
    instruction: frozen.instruction,
    query: ref(chosen.query),
    candidates: [ref(chosen.relevant), ref(chosen.irrelevant)],
    config
  });
  return {
    key: `smoke-${config}`,
    kind: `smoke/${config}`,
    meta: {
      queryId: chosen.query,
      relevantId: chosen.relevant,
      irrelevantId: chosen.irrelevant,
      candidateIds: built.candidateIds
    },
    request: built.request
  };
});

const client = new DecisionsClient({ apiKey: await readApiKey() });
const outcome = await runJobs({ runId: "smoke", jobs, client, concurrency: 1 });
for (const record of outcome.records) {
  const meta = record.meta as { relevantId: string; irrelevantId: string; candidateIds: string[] };
  console.info(
    `\n${record.key}: ok=${record.ok} model=${record.model} questions=${record.questions} ` +
      `usage=${JSON.stringify(record.usage)} attemptMs=${record.attemptMs?.toFixed(0)} serverMs=${record.serverMs}`
  );
  console.info(`  rate-limit headers: ${JSON.stringify(record.rateLimit)}`);
  (record.answers as Array<Record<string, unknown>>).forEach((answer, index) => {
    const alias = answer.name;
    const candidate = meta.candidateIds[Number(String(alias).replace(/\D/g, "")) - 1];
    const role =
      candidate === meta.relevantId
        ? "RELEVANT"
        : candidate === meta.irrelevantId
          ? "irrelevant"
          : "?";
    console.info(`  [${index}] ${role} ${JSON.stringify(answer)}`);
  });
}

if (process.argv.includes("--probe-limits")) {
  const query = noteById.get(chosen.query)!.text;
  for (const count of [40, 100, 200]) {
    const aliases = Array.from({ length: count }, (_, index) => `c${index + 1}`);
    const probe: Job = {
      key: `probe-${count}`,
      kind: "smoke/probe",
      meta: { count },
      request: {
        model: decisionsModel,
        input: `${query}\n\nCandidates: ${aliases.join(", ")} (all identical to the query note).`,
        questions: aliases.map((alias) => ({
          type: "predicate" as const,
          name: `rel_${alias}`,
          instructions: `${alias} is a duplicate of the query note.`
        }))
      }
    };
    const result = await runJobs({ runId: "smoke-probe", jobs: [probe], client, concurrency: 1 });
    const record = result.records.find((r) => r.key === probe.key);
    console.info(
      `probe ${count} questions: ${record?.ok ? `ok, ${record.usage?.inputTokens} input tokens, ${record.attemptMs?.toFixed(0)} ms` : `failed (see raw log)`}`
    );
    if (!record?.ok) break;
  }
}
