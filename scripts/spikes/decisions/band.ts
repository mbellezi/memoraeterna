/**
 * Scores the band-only cascade requests of Spike A2 with the Decisions API (see `band-plan.ts`).
 *
 *   npx tsx scripts/spikes/decisions/band.ts --partition tuning [--order-salt B] [options]
 *   npx tsx scripts/spikes/decisions/band.ts --freeze
 *   npx tsx scripts/spikes/decisions/band.ts --partition holdout [--order-salt B] [options]
 *
 * Options: --lo 0,1.5,2.5 (default: all band edges), --concurrency N (default 4), --dry-run
 * (project the cost only). Held-out requests need the design freeze (`freeze.ts`) and the band
 * freeze (`--freeze`, written after the tuning band runs). Each band edge and candidate order is
 * its own run id (`band-<partition>-lo<edge>__predicate[__order<salt>]`) with the shared spend
 * guards of `budget.ts`.
 */
import type { Partition } from "../reranker/dataset.js";

import { bandLows, bandRunId, loadBandContext, planBand } from "./band-plan.js";
import { DecisionsClient } from "./client.js";
import { buildRequest, designFingerprint } from "./design.js";
import { readApiKey } from "./env.js";
import { assertDesignFrozen } from "./frozen.js";
import { assertBandFrozen, frozenBandPath, writeFrozenBand } from "./frozen-band.js";
import { runJobs, type Job } from "./runner.js";

function option(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const ctx = await loadBandContext();

if (process.argv.includes("--freeze")) {
  await writeFrozenBand(ctx);
  console.info(`Band design frozen: ${frozenBandPath}`);
  process.exit(0);
}

const partition = option("--partition") as Partition | undefined;
if (partition !== "tuning" && partition !== "holdout")
  throw new Error("--partition must be tuning or holdout");
const orderSalt = option("--order-salt") ?? "";
const concurrency = Number(option("--concurrency") ?? 4);
const dryRun = process.argv.includes("--dry-run");
const lows = (option("--lo") ?? bandLows.join(",")).split(",").map(Number);
for (const lo of lows) {
  if (!(bandLows as readonly number[]).includes(lo)) throw new Error(`Unknown band edge ${lo}`);
}

const heldOutNotes = new Set(
  ctx.dataset.notes.filter((note) => note.partition === "holdout").map((note) => note.id)
);
const noteById = new Map(ctx.dataset.notes.map((note) => [note.id, note]));
const planned = lows.map((lo) => ({ lo, jobs: planBand(ctx, partition, lo) }));
const touchesHeldOut = planned.some(({ jobs }) =>
  jobs.some(
    (job) => heldOutNotes.has(job.queryId) || job.candidateIds.some((id) => heldOutNotes.has(id))
  )
);
if (partition === "tuning" && touchesHeldOut)
  throw new Error("A tuning band request would carry a held-out note");
if (partition === "holdout" && !dryRun) {
  await assertDesignFrozen();
  await assertBandFrozen(ctx);
}

const client = dryRun ? null : new DecisionsClient({ apiKey: await readApiKey() });
const fingerprint = designFingerprint(ctx.instruction).slice(0, 12);
for (const { lo, jobs: plannedJobs } of planned) {
  const runId = bandRunId(partition, lo, orderSalt);
  const jobs: Job[] = plannedJobs.map((job) => {
    const built = buildRequest({
      key: job.key,
      instruction: ctx.instruction,
      query: { id: job.queryId, text: noteById.get(job.queryId)!.text },
      candidates: job.candidateIds.map((id) => ({ id, text: noteById.get(id)!.text })),
      config: "predicate",
      orderSalt
    });
    return {
      key: job.key,
      kind: `band/${partition}/lo${lo}`,
      meta: {
        stage: "band",
        partition,
        lo,
        config: "predicate",
        queryId: job.queryId,
        candidateIds: built.candidateIds,
        fingerprint
      },
      request: built.request
    };
  });
  console.info(
    `${runId}: ${jobs.length} planned requests, ${plannedJobs.reduce((n, j) => n + j.candidateIds.length, 0)} directed pairs`
  );
  if (!client) {
    await runJobs({
      runId,
      jobs,
      client: new DecisionsClient({ apiKey: "dry-run-placeholder" }),
      concurrency,
      dryRun: true
    });
    continue;
  }
  const outcome = await runJobs({ runId, jobs, client, concurrency });
  console.info(
    `${runId}: sent ${outcome.sent}, failed ${outcome.failed}, skipped ${outcome.skipped}, run spend US$ ${outcome.runUsd.toFixed(4)}, wall ${(outcome.wallMs / 1000).toFixed(1)} s` +
      (outcome.stoppedEarly ? `, stopped: ${outcome.stoppedEarly}` : "")
  );
  if (outcome.stoppedEarly) {
    process.exitCode = 1;
    break;
  }
}
