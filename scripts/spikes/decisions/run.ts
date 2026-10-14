/**
 * Scores one stage of the Spike A2 protocol with the Decisions API.
 *
 *   npx tsx scripts/spikes/decisions/run.ts --stage tuning-forward --config predicate [options]
 *
 * Options: --concurrency N (default 4), --dry-run (project the cost only), --limit N (first N
 * requests only; the run id gains a `__limitN` suffix), --order-salt X (a different candidate
 * order for the same design; the run id gains `__orderX`; robustness check, predicate only).
 * Stages are defined in `plan.ts`; the typed configuration is only allowed on the tuning split.
 * Held-out stages and `extra` require the design to be frozen (`freeze.ts`).
 */
import { loadDataset, loadFrozen } from "../reranker/dataset.js";

import { DecisionsClient } from "./client.js";
import { buildRequest, designFingerprint, type ConfigName } from "./design.js";
import { readApiKey } from "./env.js";
import { assertDesignFrozen } from "./frozen.js";
import { heldOutStages, planStages, stageNames, type StageName } from "./plan.js";
import { runJobs, type Job } from "./runner.js";

function option(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const stage = option("--stage") as StageName | undefined;
const config = (option("--config") ?? "predicate") as ConfigName;
const concurrency = Number(option("--concurrency") ?? 4);
const limit = option("--limit") ? Number(option("--limit")) : undefined;
const dryRun = process.argv.includes("--dry-run");
/** Robustness runs: a different candidate order for the same design (predicate only). */
const orderSalt = option("--order-salt") ?? "";
if (!stage || !stageNames.includes(stage))
  throw new Error(`--stage must be one of ${stageNames.join(", ")}`);
if (config !== "predicate" && config !== "typed")
  throw new Error("--config must be predicate or typed");
if (orderSalt && config !== "predicate")
  throw new Error("--order-salt is for the predicate configuration");
if (config === "typed" && stage !== "tuning-forward" && stage !== "tuning-reverse") {
  throw new Error("The typed configuration is measured on the tuning split only");
}

const dataset = await loadDataset();
const frozen = await loadFrozen();
const noteById = new Map(dataset.notes.map((note) => [note.id, note]));
const planned = planStages(dataset)[stage];
const heldOutNotes = new Set(
  dataset.notes.filter((n) => n.partition === "holdout").map((n) => n.id)
);
const touchesHeldOut = planned.some(
  (job) => heldOutNotes.has(job.queryId) || job.candidateIds.some((id) => heldOutNotes.has(id))
);
if (heldOutStages.includes(stage) || touchesHeldOut) {
  if (!dryRun) await assertDesignFrozen();
}

const selected = limit ? planned.slice(0, limit) : planned;
const jobs: Job[] = selected.map((job) => {
  const built = buildRequest({
    key: job.key,
    instruction: frozen.instruction,
    query: { id: job.queryId, text: noteById.get(job.queryId)!.text },
    candidates: job.candidateIds.map((id) => ({ id, text: noteById.get(id)!.text })),
    config,
    orderSalt
  });
  return {
    key: job.key,
    kind: `${stage}/${config}`,
    meta: {
      stage,
      config,
      queryId: job.queryId,
      candidateIds: built.candidateIds,
      fingerprint: designFingerprint(frozen.instruction).slice(0, 12)
    },
    request: built.request
  };
});

const runId = `${stage}__${config}${orderSalt ? `__order${orderSalt}` : ""}${limit ? `__limit${limit}` : ""}`;
console.info(
  `${runId}: ${planned.length} planned requests, ${planned.reduce((n, j) => n + j.candidateIds.length, 0)} directed pairs` +
    (touchesHeldOut ? " (includes held-out notes)" : "")
);
const client = new DecisionsClient({ apiKey: await readApiKey() });
const outcome = await runJobs({ runId, jobs, client, concurrency, dryRun });
console.info(
  `${runId}: sent ${outcome.sent}, failed ${outcome.failed}, skipped ${outcome.skipped}, run spend US$ ${outcome.runUsd.toFixed(4)}, wall ${(outcome.wallMs / 1000).toFixed(1)} s` +
    (outcome.stoppedEarly ? `, stopped: ${outcome.stoppedEarly}` : "")
);
if (outcome.stoppedEarly) process.exitCode = 1;
