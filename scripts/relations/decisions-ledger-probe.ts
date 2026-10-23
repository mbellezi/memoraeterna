/**
 * The US$ 0.50 Decisions API ledger probe (F4 T76, owner answer Q12): 20 requests of the product's
 * Decisions request design on the SYNTHETIC matching-benchmark fixture (fictional text only, never a
 * library), each admitted by the product's RemoteBudget as background work, audited as the decider
 * audits it, and settled after its audit row. It then checks the monthly ledger (the audit read back
 * through the ledger statement and priced with the versioned price table) against the usage the
 * provider reported in each response body, read apart from the adapter.
 *
 *   npx tsx scripts/relations/decisions-ledger-probe.ts --dry-run [--out <dir>]
 *   npx tsx scripts/relations/decisions-ledger-probe.ts --live --env-file <path to .env> [--out <dir>]
 *
 * `--dry-run` answers every request from a scripted provider and reads no key (US$ 0). `--live` is
 * the orchestrator's run: it reads `OPENAPI_KEY` from the named `.env` at run time only (the key stays
 * in the adapter's closure: never printed, logged, written or put in the environment), sends one
 * attempt per request (a refusal such as `credit_balance_exhausted` is recorded once and stops the
 * probe, never retried), and stops before any request whose estimate would pass US$ 0.50. Both modes
 * write the audit into a temporary PostgreSQL sidecar (deleted afterwards) and a JSON report with no
 * text and no key under `--out` (default `.cache/f4/t76-decisions-probe/`).
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  bindAttemptAdmission,
  decisionsTaskRequest,
  estimatePlanInputTokens,
  OpenAiDecisionsAdapter,
  planDecisionRequests,
  redactDecisionsSecrets,
  resolveDecisionsLimits,
  type DecisionsList,
  type DecisionsLimits,
  type PlannedDecisionsRequest
} from "@app/ai";
import type { Queryable } from "@app/db";
import { defaultPriceTable, resolvePrice, tokensCostUsd } from "@app/domain";

import {
  RemoteBudget,
  type RemoteBudgetSnapshot
} from "../../apps/desktop/src/main/services/gardener/remote-budget.ts";

export const probeCapUsd = 0.5;
export const probeRequests = 20;
export const repositoryRoot = resolve(import.meta.dirname, "..", "..");
export const fixturePath = join(repositoryRoot, "scripts/fixtures/matching-benchmark.json");
const lane = "remote:openai-decisions";

/** One audited request, as the decider writes it (no text). */
export interface ProbeAuditRow {
  status: "succeeded" | "failed";
  inputTokens: number | null;
  outputTokens: number | null;
  costEstimate: number | null;
  budgetEstimateUsd: number | null;
  error: string | null;
}

/** Where the probe writes its audit rows: the sidecar's `ai_task_runs` (CLI) or memory (tests). */
export interface ProbeAudit {
  record(row: ProbeAuditRow): Promise<void>;
}

export interface ProbeRequestRecord {
  index: number;
  candidates: number;
  /** The admission estimate (input tokens) and its US$. */
  estimateTokens: number;
  estimateUsd: number;
  /** What the provider's response body said, read apart from the adapter. */
  providerInputTokens: number | null;
  providerOutputTokens: number | null;
  /** What the adapter computed. */
  adapterCostUsd: number | null;
  status: "succeeded" | "failed" | "not_sent";
  error: string | null;
}

export interface ProbeReport {
  mode: "dry-run" | "live";
  startedAt: string;
  priceTableVersion: string;
  model: string;
  capUsd: number;
  requests: ProbeRequestRecord[];
  totals: {
    sent: number;
    succeeded: number;
    providerInputTokens: number;
    /** Provider-reported input tokens at the published price (`decisions/limits.ts`). */
    providerUsd: number;
    adapterUsd: number;
    /** The RemoteBudget's month spend before and after it reloaded the ledger from the audit. */
    budgetInMemoryUsd: number;
    ledgerUsd: number;
    maxEstimateErrorUsd: number;
  };
  checks: {
    ledgerMatchesProvider: boolean;
    inMemoryMatchesLedger: boolean;
    adapterMatchesProvider: boolean;
    estimatesNeverBelowUsage: boolean;
    withinCap: boolean;
  };
  /** The first refusal or failure, redacted, recorded once; the probe stopped there. */
  stoppedBy: string | null;
  passed: boolean;
}

const fixtureNoteText = (title: string, idea: string) => `${title}\n${idea}`;

/**
 * The synthetic notes of the fixture (title and idea of every source or chapter), in fixture order.
 * Nothing but this fixture can enter a request.
 */
export async function readFixtureNotes(path = fixturePath): Promise<string[]> {
  const fixture = JSON.parse(await readFile(path, "utf8")) as {
    version: string;
    sources: Array<{
      title: string;
      ideas?: string[];
      chapters?: Array<{ title: string; ideas: string[] }>;
    }>;
  };
  if (fixture.version !== "matching-benchmark-v1")
    throw new Error("The probe sends only the synthetic matching-benchmark-v1 fixture.");
  const notes: string[] = [];
  for (const source of fixture.sources) {
    for (const idea of source.ideas ?? []) notes.push(fixtureNoteText(source.title, idea));
    for (const chapter of source.chapters ?? [])
      for (const idea of chapter.ideas) notes.push(fixtureNoteText(chapter.title, idea));
  }
  return notes;
}

/**
 * Lists of one query note and four candidates from other places in the fixture, in content order,
 * until the product's plan holds `count` requests (both candidate orders of each list).
 */
export function planProbe(
  notes: readonly string[],
  instruction: string,
  limits: DecisionsLimits,
  count = probeRequests
): PlannedDecisionsRequest[] {
  const lists: DecisionsList[] = [];
  let plan: PlannedDecisionsRequest[] = [];
  for (let index = 0; plan.length < count; index += 1) {
    if (notes.length < 60 || index >= notes.length) throw new Error("The fixture is too small.");
    const at = (offset: number) => notes[(index * 7 + offset) % notes.length]!;
    lists.push({ query: at(0), candidates: [at(11), at(23), at(37), at(53)] });
    plan = planDecisionRequests(lists, instruction, limits);
  }
  return plan.slice(0, count);
}

/** A scripted Decisions provider: probabilities and a usage of one token per three body bytes. */
export function scriptedDecisionsFetch(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { questions?: unknown[] };
    const inputTokens = Math.ceil(Buffer.byteLength(String(init?.body ?? ""), "utf8") / 3);
    const answers = (body.questions ?? []).map((question, index) => ({
      type: "predicate",
      name: (question as { name?: string }).name ?? `q${index}`,
      probability: 0.5
    }));
    return new Response(
      JSON.stringify({
        model: "gpt-6-luna",
        answers,
        usage: { input_tokens: inputTokens, output_tokens: 0, total_tokens: inputTokens }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
}

/** Wraps a fetch to read each response's reported usage apart from the adapter. */
function usageReadingFetch(
  inner: typeof fetch,
  seen: Array<{ input: number | null; output: number | null }>
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await inner(url, init);
    try {
      const json = (await response.clone().json()) as {
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };
      const number = (value: unknown) => (typeof value === "number" ? value : null);
      seen.push({
        input: number(json.usage?.input_tokens),
        output: number(json.usage?.output_tokens)
      });
    } catch {
      seen.push({ input: null, output: null });
    }
    return response;
  }) as typeof fetch;
}

export async function runDecisionsLedgerProbe(options: {
  mode: "dry-run" | "live";
  fetch: typeof fetch;
  apiKey: () => string | Promise<string>;
  /** The database the RemoteBudget reads its ledger and counters from. */
  pool: Queryable;
  audit: ProbeAudit;
  instruction: string;
  notes: readonly string[];
  now?: () => Date;
}): Promise<ProbeReport> {
  // One attempt per request: a refusal is recorded and reported once, never retried.
  const limits = resolveDecisionsLimits({ retry: { maxAttempts: 1 } });
  const plan = planProbe(options.notes, options.instruction, limits);
  const seen: Array<{ input: number | null; output: number | null }> = [];
  const adapter = new OpenAiDecisionsAdapter({
    apiKey: options.apiKey,
    limits,
    fetch: usageReadingFetch(options.fetch, seen),
    random: () => 0
  });
  const budget = new RemoteBudget({
    getPool: () => options.pool,
    monthlyCapUsd: () => probeCapUsd,
    ...(options.now ? { now: options.now } : {})
  });
  // The probe's cap is its whole allowance: no pause at the share before it.
  await budget.continuePastPause();
  const price = resolvePrice(defaultPriceTable, limits.providerId, limits.model);
  const records: ProbeRequestRecord[] = [];
  let stoppedBy: string | null = null;
  for (const [index, planned] of plan.entries()) {
    const estimateTokens = estimatePlanInputTokens([planned], limits);
    const estimateUsd = tokensCostUsd(price, { inputTokens: estimateTokens, outputTokens: 0 });
    const record: ProbeRequestRecord = {
      index,
      candidates: planned.input.candidates.length,
      estimateTokens,
      estimateUsd,
      providerInputTokens: null,
      providerOutputTokens: null,
      adapterCostUsd: null,
      status: "not_sent",
      error: null
    };
    records.push(record);
    if (stoppedBy) continue;
    const ticket = await budget.open({
      lane,
      provider: limits.providerId,
      modelId: limits.model,
      budgetClass: "background",
      priority: 3,
      estimate: { inputTokens: estimateTokens, outputTokens: 0 }
    });
    const signal = AbortSignal.any([]);
    bindAttemptAdmission(
      signal,
      (attempt) => ticket.admitAttempt(attempt),
      (failed) => ticket.attemptFailed(failed)
    );
    const before = seen.length;
    let row: ProbeAuditRow;
    try {
      const result = await adapter.run(decisionsTaskRequest(planned.input, limits), signal);
      const reported = seen[before];
      record.providerInputTokens = reported?.input ?? null;
      record.providerOutputTokens = reported?.output ?? null;
      record.adapterCostUsd = result.costEstimate ?? null;
      record.status = "succeeded";
      const usage = {
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? 0
      };
      row = {
        status: "succeeded",
        ...usage,
        costEstimate: result.costEstimate ?? null,
        // What the ledger counts beyond the reported usage, as the ticket settles it.
        budgetEstimateUsd: ticket.auditEstimateUsd(usage),
        error: null
      };
    } catch (error) {
      const message = redactDecisionsSecrets(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      ).slice(0, 300);
      record.status = seen.length > before ? "failed" : "not_sent";
      record.error = message;
      stoppedBy = `request ${index}: ${message}`;
      row = {
        status: "failed",
        inputTokens: null,
        outputTokens: null,
        costEstimate: null,
        budgetEstimateUsd: ticket.auditEstimateUsd({}),
        error: message
      };
    }
    try {
      await options.audit.record(row);
    } finally {
      await ticket.settle({ inputTokens: row.inputTokens, outputTokens: row.outputTokens });
    }
  }
  const inMemory: RemoteBudgetSnapshot = await budget.snapshot();
  const reloaded = await budget.reload();
  const succeeded = records.filter((record) => record.status === "succeeded");
  const providerInputTokens = succeeded.reduce(
    (sum, record) => sum + (record.providerInputTokens ?? 0),
    0
  );
  const providerUsd = (providerInputTokens * limits.pricePerMillionInputTokensUsd) / 1_000_000;
  const adapterUsd = succeeded.reduce((sum, record) => sum + (record.adapterCostUsd ?? 0), 0);
  const failedEstimates = records
    .filter((record) => record.status === "failed")
    .reduce((sum, record) => sum + record.estimateUsd, 0);
  const close = (left: number, right: number) => Math.abs(left - right) <= 1e-12;
  const errors = succeeded.map(
    (record) =>
      record.estimateUsd -
      tokensCostUsd(price, { inputTokens: record.providerInputTokens ?? 0, outputTokens: 0 })
  );
  const checks = {
    // A failed request reported no usage: the ledger keeps its estimate as spend (D14).
    ledgerMatchesProvider: close(reloaded.money.spentUsd, providerUsd + failedEstimates),
    inMemoryMatchesLedger: close(inMemory.money.spentUsd, reloaded.money.spentUsd),
    adapterMatchesProvider: close(adapterUsd, providerUsd),
    estimatesNeverBelowUsage: errors.every((error) => error >= 0),
    withinCap: reloaded.money.spentUsd <= probeCapUsd
  };
  return {
    mode: options.mode,
    startedAt: (options.now?.() ?? new Date()).toISOString(),
    priceTableVersion: defaultPriceTable.version,
    model: limits.model,
    capUsd: probeCapUsd,
    requests: records,
    totals: {
      sent: records.filter((record) => record.status !== "not_sent").length,
      succeeded: succeeded.length,
      providerInputTokens,
      providerUsd,
      adapterUsd,
      budgetInMemoryUsd: inMemory.money.spentUsd,
      ledgerUsd: reloaded.money.spentUsd,
      maxEstimateErrorUsd: errors.length > 0 ? Math.max(...errors) : 0
    },
    checks,
    stoppedBy,
    passed: stoppedBy === null && Object.values(checks).every(Boolean)
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      "env-file": { type: "string" },
      out: { type: "string" }
    }
  });
  if (values["dry-run"] === values.live)
    throw new Error("Pass exactly one of --dry-run or --live.");
  const mode = values.live ? "live" : "dry-run";
  if (mode === "live" && !values["env-file"])
    throw new Error("--live needs --env-file <path to the .env holding OPENAPI_KEY>.");
  // Imported here so the dry run and the tests never load the key reader.
  const apiKey =
    mode === "live"
      ? await (async () => {
          const { readApiKey } = await import("../spikes/decisions/env.ts");
          const envFile = resolve(values["env-file"]!);
          return () => readApiKey(envFile);
        })()
      : () => "dry-run-key-not-a-secret";
  const {
    closePgPool,
    createAiConfigRepository,
    createPgPool,
    PostgresSidecarManager,
    resolvePostgresSidecarPaths,
    runMigrations
  } = await import("@app/db");
  const { relationDecisionsInstruction } =
    await import("../../apps/desktop/src/main/services/relations/decisions-identity.ts");
  const workDir = await mkdtemp(join(tmpdir(), "memora-decisions-probe-"));
  const sidecar = resolvePostgresSidecarPaths({ cwd: repositoryRoot, env: process.env });
  const manager = new PostgresSidecarManager({
    binDir: sidecar.binDir,
    dataDir: join(workDir, "data"),
    database: "memora_decisions_probe",
    user: "memora_decisions_probe",
    password: `probe-${randomUUID()}`,
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 10_000
  });
  let pool: Awaited<ReturnType<typeof createPgPool>> | null = null;
  try {
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 3 });
    await runMigrations(pool, join(repositoryRoot, "packages/db/drizzle"), {
      seedFolder: join(repositoryRoot, "packages/db/seed")
    });
    const ai = createAiConfigRepository(pool);
    const limits = resolveDecisionsLimits();
    const report = await runDecisionsLedgerProbe({
      mode,
      fetch: mode === "live" ? fetch : scriptedDecisionsFetch(),
      apiKey,
      pool,
      instruction: relationDecisionsInstruction(),
      notes: await readFixtureNotes(),
      audit: {
        record: async (row) => {
          await ai.recordTaskRun({
            taskType: "reranking",
            provider: limits.providerId,
            modelId: limits.model,
            runtime: "remote",
            adapter: "openai-decisions",
            durationMs: 1,
            lane,
            workloadClass: "decide",
            priority: 3,
            budgetClass: "background",
            status: row.status,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            costEstimate: row.costEstimate,
            budgetEstimateUsd: row.budgetEstimateUsd,
            error: row.error
          });
        }
      }
    });
    const outDir = resolve(values.out ?? join(repositoryRoot, ".cache/f4/t76-decisions-probe"));
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, `${mode}-${report.startedAt.replace(/[:.]/gu, "-")}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    console.info(
      JSON.stringify({
        mode,
        passed: report.passed,
        totals: report.totals,
        checks: report.checks,
        stoppedBy: report.stoppedBy,
        report: file
      })
    );
    if (!report.passed) process.exitCode = 1;
  } finally {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error: unknown) => {
    console.error(
      redactDecisionsSecrets(
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      )
    );
    process.exit(1);
  });
}
