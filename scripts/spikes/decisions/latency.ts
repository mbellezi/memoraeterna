/**
 * Spike A2 latency: single-candidate, 8-candidate and 20-candidate requests at concurrency 1 and
 * 4, on the same 30 sampled notes as Spike A's latency spike, written to
 * `.cache/spikes/decisions/latency.json`.
 *
 *   npx tsx scripts/spikes/decisions/latency.ts [--notes 30] [--repeats 3] [--concurrency 1,4]
 *
 * Sample (Spike A's rule, same seed): source notes of the `economy` and `validate` shortlists
 * with at least 20 candidates, shuffled with seed 20261014; the first N notes keep their first 20
 * candidates; single-candidate requests use the first 7 candidates of each note. Each concurrency
 * level and size is one section whose wall time gives the throughput. A warm-up request (not part
 * of the statistics) opens the connection first; the cold first request is recorded separately.
 * Repeats send the same request, which also measures the determinism of the answers.
 */
import { writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";

import { loadDataset, loadFrozen } from "../reranker/dataset.js";
import { mean, percentile, seededRandom } from "../reranker/metrics.js";

import { outputDirectory, readRaw, type RawRecord } from "./budget.js";
import { DecisionsClient } from "./client.js";
import { buildRequest } from "./design.js";
import { readApiKey } from "./env.js";
import { runJobs, type Job } from "./runner.js";

function option(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const noteCount = Number(option("--notes") ?? 30);
const repeats = Number(option("--repeats") ?? 3);
const levels = (option("--concurrency") ?? "1,4").split(",").map(Number);

const dataset = await loadDataset();
const frozen = await loadFrozen();
const noteById = new Map(dataset.notes.map((note) => [note.id, note]));
const ref = (id: string) => ({ id, text: noteById.get(id)!.text });

const shortlists = new Map<string, string[]>();
for (const row of dataset.rows) {
  if (row.phase !== "economy" && row.phase !== "validate") continue;
  const list = shortlists.get(row.query) ?? [];
  if (!list.includes(row.doc)) list.push(row.doc);
  shortlists.set(row.query, list);
}
const random = seededRandom(20_261_014);
const eligible = [...shortlists.entries()].filter(([, docs]) => docs.length >= 20);
for (let index = eligible.length - 1; index > 0; index -= 1) {
  const swap = Math.floor(random() * (index + 1));
  [eligible[index], eligible[swap]] = [eligible[swap]!, eligible[index]!];
}
const sample = eligible
  .slice(0, noteCount)
  .map(([query, docs]) => ({ query, docs: docs.slice(0, 20) }));
const heldOutNotes = new Set(
  dataset.notes.filter((n) => n.partition === "holdout").map((n) => n.id)
);
const usesHeldOut = sample.some(
  (s) => heldOutNotes.has(s.query) || s.docs.some((id) => heldOutNotes.has(id))
);
if (usesHeldOut) {
  const { assertDesignFrozen } = await import("./frozen.js");
  await assertDesignFrozen();
}

type Size = "single" | "note8" | "note20";
function jobsFor(size: Size, level: number): Job[] {
  const jobs: Job[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const note of sample) {
      const groups: string[][] =
        size === "single"
          ? note.docs.slice(0, 7).map((doc) => [doc])
          : [note.docs.slice(0, size === "note8" ? 8 : 20)];
      groups.forEach((docs, index) => {
        if (size === "single" && repeat > 0) return; // singles: one pass (7 per note, 210 requests)
        const shuffleKey = `latency:${size}:${note.query}:${index}`;
        const built = buildRequest({
          key: shuffleKey,
          instruction: frozen.instruction,
          query: ref(note.query),
          candidates: docs.map(ref),
          config: "predicate"
        });
        jobs.push({
          key: `${shuffleKey}:r${repeat}`,
          kind: `latency/${size}/c${level}`,
          meta: { size, level, repeat, queryId: note.query, candidateIds: built.candidateIds },
          request: built.request
        });
      });
    }
  }
  return jobs;
}

function summarize(values: number[]) {
  return {
    samples: values.length,
    meanMs: mean(values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values)
  };
}

const client = new DecisionsClient({ apiKey: await readApiKey() });
// Warm-up: opens the TLS connection; its latency is the cold-start figure.
await runJobs({
  runId: "latency-warmup",
  jobs: jobsFor("single", 1)
    .slice(0, 1)
    .map((job) => ({ ...job, key: "warmup", kind: "latency/warmup" })),
  client,
  concurrency: 1
});
const cold = (await readRaw("latency-warmup")).find((record) => record.ok);

const sections: Array<Record<string, unknown>> = [];
const determinism: Record<string, { answers: number; identical: number; maxAbsDiff: number }> = {};
for (const level of levels) {
  for (const size of ["single", "note8", "note20"] as const) {
    const runId = `latency-c${level}-${size}`;
    const jobs = jobsFor(size, level);
    const outcome = await runJobs({ runId, jobs, client, concurrency: level });
    if (outcome.stoppedEarly) throw new Error(`${runId} stopped: ${outcome.stoppedEarly}`);
    const records = (await readRaw(runId)).filter((record) => record.ok);
    const latest = new Map(records.map((record) => [record.key, record]));
    const unique = [...latest.values()];
    const tokens = unique.reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0);
    const requests = unique.length;
    // Wall time of the whole section: first request start to last finish (sum of waves at c>1).
    const wallMs = outcome.skipped === jobs.length ? null : outcome.wallMs;
    sections.push({
      runId,
      size,
      concurrency: level,
      requests,
      wallMs,
      requestsPerSecond: wallMs ? (requests / wallMs) * 1000 : null,
      attemptMs: summarize(unique.map((r) => r.attemptMs ?? 0)),
      totalMs: summarize(unique.map((r) => r.totalMs ?? 0)),
      serverMs: summarize(unique.flatMap((r) => (r.serverMs ? [r.serverMs] : []))),
      inputTokens: tokens,
      meanTokensPerRequest: tokens / requests,
      questionsPerRequest: mean(unique.map((r) => r.questions)),
      retried: unique.filter((r) => (r.attemptStatuses?.length ?? 1) > 1).length
    });
    // Determinism across repeats of the same request.
    const byShuffle = new Map<string, RawRecord[]>();
    for (const record of unique) {
      const key = record.key.replace(/:r\d+$/, "");
      byShuffle.set(key, [...(byShuffle.get(key) ?? []), record]);
    }
    let answers = 0;
    let identical = 0;
    let maxAbsDiff = 0;
    for (const group of byShuffle.values()) {
      if (group.length < 2) continue;
      const first = (group[0]!.answers ?? []) as Array<{ probability?: number }>;
      for (const other of group.slice(1)) {
        const second = (other.answers ?? []) as Array<{ probability?: number }>;
        first.forEach((answer, index) => {
          answers += 1;
          const diff = Math.abs((answer.probability ?? 0) - (second[index]?.probability ?? 0));
          if (diff === 0) identical += 1;
          maxAbsDiff = Math.max(maxAbsDiff, diff);
        });
      }
    }
    if (answers > 0) determinism[runId] = { answers, identical, maxAbsDiff };
    console.info(
      `${runId}: ${requests} requests, p50 ${(sections.at(-1)!.attemptMs as { p50Ms: number }).p50Ms.toFixed(0)} ms, ` +
        `p95 ${(sections.at(-1)!.attemptMs as { p95Ms: number }).p95Ms.toFixed(0)} ms`
    );
  }
}

// 200 notes x 8 candidates: one request per note and direction.
const estimate = (level: number) => {
  const section = sections.find((s) => s.size === "note8" && s.concurrency === level) as
    { attemptMs: { meanMs: number; p95Ms: number }; requestsPerSecond: number | null } | undefined;
  if (!section) return null;
  const serialMinutes = (200 * section.attemptMs.meanMs) / 60_000;
  const throughputMinutes = section.requestsPerSecond ? 200 / section.requestsPerSecond / 60 : null;
  return {
    concurrency: level,
    oneDirectionMinutesFromMeanLatency: level === 1 ? serialMinutes : serialMinutes / level,
    oneDirectionMinutesFromThroughput: throughputMinutes,
    bothDirectionsMinutesFromThroughput: throughputMinutes === null ? null : throughputMinutes * 2,
    oneDirectionMinutesAtP95Latency: (200 * section.attemptMs.p95Ms) / 60_000 / level
  };
};
const estimate20 = (level: number) => {
  const section = sections.find((s) => s.size === "note20" && s.concurrency === level) as
    { requestsPerSecond: number | null } | undefined;
  if (!section?.requestsPerSecond) return null;
  return { concurrency: level, oneDirectionMinutes: 200 / section.requestsPerSecond / 60 };
};

const report = {
  measuredAt: new Date().toISOString(),
  instructionId: frozen.instructionId,
  sampleNotes: sample.length,
  repeats,
  hostLoadAverage: loadavg(),
  coldFirstRequest: cold ? { attemptMs: cold.attemptMs, serverMs: cold.serverMs } : null,
  sections,
  determinism,
  estimate200Notes8Candidates: levels.map(estimate),
  estimate200Notes20Candidates: levels.map(estimate20)
};
await writeFile(join(outputDirectory, "latency.json"), `${JSON.stringify(report, null, 2)}\n`);
console.info(
  JSON.stringify(
    {
      estimate200Notes8Candidates: report.estimate200Notes8Candidates,
      estimate200Notes20Candidates: report.estimate200Notes20Candidates,
      cold: report.coldFirstRequest,
      determinism
    },
    null,
    2
  )
);
