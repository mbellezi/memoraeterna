/**
 * Executes a list of Decisions requests with bounded concurrency, resumable raw logging and
 * spend guards (see `budget.ts`). A run id names one raw log; jobs already recorded as
 * successful in that log are skipped, so an interrupted run resumes without paying twice.
 */
import {
  DecisionsClient,
  DecisionsError,
  type DecisionRequest,
  type DecisionResult
} from "./client.js";
import {
  appendRaw,
  assertWithinBudget,
  costUsd,
  project,
  readAllRaw,
  readRaw,
  runLimitUsd,
  summarizeSpend,
  totalLimitUsd,
  type RawRecord
} from "./budget.js";

export interface Job {
  key: string;
  kind: string;
  meta: Record<string, unknown>;
  request: DecisionRequest;
}

export interface RunOptions {
  runId: string;
  jobs: readonly Job[];
  client: DecisionsClient;
  concurrency: number;
  /** Only project the cost; send nothing. */
  dryRun?: boolean;
  /** Stop issuing requests after this many consecutive failures. */
  maxConsecutiveFailures?: number;
  log?: (line: string) => void;
}

export interface RunOutcome {
  records: RawRecord[];
  skipped: number;
  sent: number;
  failed: number;
  runUsd: number;
  stoppedEarly: string | null;
  wallMs: number;
}

function expectedAnswerNames(request: DecisionRequest): string[] {
  return request.questions.map((question) => question.name);
}

function describeAnswers(result: DecisionResult, request: DecisionRequest): string | null {
  if (result.answers.length !== request.questions.length) {
    return `expected ${request.questions.length} answers, got ${result.answers.length}`;
  }
  const names = expectedAnswerNames(request);
  for (let index = 0; index < names.length; index += 1) {
    const answer = result.answers[index]!;
    if (answer.name !== null && answer.name !== names[index]) {
      return `answer ${index} is named ${String(answer.name).slice(0, 40)}, expected ${names[index]}`;
    }
  }
  return null;
}

export async function runJobs(options: RunOptions): Promise<RunOutcome> {
  const log = options.log ?? ((line: string) => console.info(line));
  const wallStarted = performance.now();
  const existing = await readRaw(options.runId);
  const done = new Map<string, RawRecord>();
  for (const record of existing) if (record.ok) done.set(record.key, record);
  const pending = options.jobs.filter((job) => !done.has(job.key));

  const projection = await project(pending.map((job) => JSON.stringify(job.request).length));
  log(
    `[${options.runId}] ${options.jobs.length} jobs (${done.size} already done, ${pending.length} to send); ` +
      `projected ${projection.inputTokens} input tokens = US$ ${projection.usd.toFixed(4)} ` +
      `(${projection.charsPerToken.toFixed(2)} chars/token assumed; spent so far US$ ${projection.spentBeforeUsd.toFixed(4)}; ` +
      `limits US$ ${runLimitUsd} per run, US$ ${totalLimitUsd} total)`
  );
  assertWithinBudget(projection);
  const outcome: RunOutcome = {
    records: [...done.values()],
    skipped: done.size,
    sent: 0,
    failed: 0,
    runUsd: 0,
    stoppedEarly: null,
    wallMs: 0
  };
  if (options.dryRun || pending.length === 0) {
    outcome.wallMs = performance.now() - wallStarted;
    return outcome;
  }

  const abort = new AbortController();
  const stop = (reason: string): void => {
    if (!outcome.stoppedEarly) {
      outcome.stoppedEarly = reason;
      log(`[${options.runId}] stopping: ${reason}`);
      abort.abort();
    }
  };
  let runTokens = summarizeSpend(existing).inputTokens;
  outcome.runUsd = costUsd(runTokens);
  const totalOtherUsd = summarizeSpend(
    (await readAllRaw()).filter((record) => record.runId !== options.runId)
  ).usd;
  const maxFailures = options.maxConsecutiveFailures ?? 6;
  let consecutiveFailures = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (abort.signal.aborted) return;
      const job = pending[next];
      next += 1;
      if (!job) return;
      const bodyChars = JSON.stringify(job.request).length;
      const base = {
        runId: options.runId,
        key: job.key,
        kind: job.kind,
        meta: job.meta,
        at: new Date().toISOString(),
        questions: job.request.questions.length,
        bodyChars
      };
      let record: RawRecord;
      try {
        const result = await options.client.decide(job.request, abort.signal);
        const mismatch = describeAnswers(result, job.request);
        record = {
          ...base,
          ok: mismatch === null,
          ...(mismatch ? { error: { kind: "answers", status: 200, message: mismatch } } : {}),
          model: result.model,
          usage: {
            inputTokens: result.usage.input_tokens,
            cachedTokens: result.usage.input_tokens_details?.cached_tokens ?? 0,
            outputTokens: result.usage.output_tokens ?? 0,
            reasoningTokens: result.usage.output_tokens_details?.reasoning_tokens ?? 0
          },
          requestId: result.requestId,
          attemptMs: result.attemptMs,
          serverMs: result.serverMs,
          totalMs: result.totalMs,
          attemptStatuses: result.attempts.map((attempt) => attempt.status),
          rateLimit: result.rateLimit,
          answers: result.answers
        };
      } catch (error) {
        const failure =
          error instanceof DecisionsError
            ? error
            : new DecisionsError("network", String(error).slice(0, 200), null, []);
        record = {
          ...base,
          ok: false,
          error: { kind: failure.kind, status: failure.status, message: failure.message },
          attemptStatuses: failure.attempts.map((attempt) => attempt.status),
          totalMs: failure.attempts.reduce((sum, a) => sum + a.ms + a.waitedMs, 0)
        };
        if (failure.kind === "aborted") continue;
        if (failure.kind === "auth" || failure.kind === "quota") {
          await appendRaw(record);
          outcome.failed += 1;
          stop(`${failure.kind} error (HTTP ${failure.status}); not retrying`);
          return;
        }
      }
      await appendRaw(record);
      outcome.sent += 1;
      if (record.ok) {
        consecutiveFailures = 0;
        outcome.records.push(record);
      } else {
        outcome.failed += 1;
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxFailures) stop(`${maxFailures} consecutive failures`);
      }
      if (record.usage) runTokens += record.usage.inputTokens;
      outcome.runUsd = costUsd(runTokens);
      if (outcome.runUsd > runLimitUsd)
        stop(`run spend US$ ${outcome.runUsd.toFixed(4)} exceeds the limit`);
      if (totalOtherUsd + outcome.runUsd > totalLimitUsd) stop("total spend limit reached");
      if (outcome.sent % 10 === 0 || outcome.sent === pending.length) {
        log(
          `[${options.runId}] ${outcome.sent}/${pending.length} sent, ${outcome.failed} failed, ` +
            `run spend US$ ${outcome.runUsd.toFixed(4)}`
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, () => worker()));
  outcome.wallMs = performance.now() - wallStarted;
  return outcome;
}
