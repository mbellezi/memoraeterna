import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleAdapter } from "@app/ai";
import {
  PostgresSidecarManager,
  closePgPool,
  createAiConfigRepository,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import {
  defaultPriceTable,
  PriceTableSchema,
  remoteBudgetRefusalOf,
  type PriceTable
} from "@app/domain";

import { AiService } from "../ai-service.js";
import { RemoteBudget } from "./remote-budget.js";

/**
 * E4 part (c) (F4 D14, T76): background calls against a priced OpenAI-compatible loopback fake at
 * concurrency 4, with random output sizes, transient 503s that are retried and streams that stall
 * after their first deltas (billed attempts whose usage never arrives). What the fake bills stays
 * within the cap plus one attempt's largest estimation error; remote background pauses at the pause
 * share until the person continues, then stops at the cap; P0 work is never refused; and the ledger
 * read back from PostgreSQL equals what the budget counted in memory.
 */
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const modelId = "priced-fake";
/** US$ 1 per million input tokens and US$ 10 per million output tokens. */
const prices = { input: 1, output: 10 };
const capUsd = 0.3;
const maxOutputTokens = 2_000;

/** A seeded random source (mulberry32), so the fake's choices are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Billed {
  kind: "ok" | "unavailable" | "stall";
  promptTokens: number;
  completionTokens: number;
}

/** The priced fake: what it billed per request, at its prices. */
function pricedFake(random: () => number) {
  const billed: Billed[] = [];
  let concurrent = 0;
  let maximumConcurrent = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        max_tokens?: number;
        max_completion_tokens?: number;
        messages: Array<{ content: string }>;
      };
      // A token holds at least one byte: the fake bills one per four bytes of the prompt.
      const promptTokens = Math.ceil(
        Buffer.byteLength(body.messages.map((message) => message.content).join(""), "utf8") / 4
      );
      const limit = body.max_completion_tokens ?? body.max_tokens ?? maxOutputTokens;
      const roll = random();
      if (roll < 0.1) {
        billed.push({ kind: "unavailable", promptTokens: 0, completionTokens: 0 });
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "busy" } }));
        return;
      }
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      response.on("close", () => {
        concurrent -= 1;
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      const stall = roll < 0.18;
      const completionTokens = stall
        ? 1 + Math.floor(random() * 20)
        : Math.min(limit, 50 + Math.floor(random() * (limit - 50)));
      const entry: Billed = { kind: stall ? "stall" : "ok", promptTokens, completionTokens: 0 };
      billed.push(entry);
      for (let index = 0; index < completionTokens; index += 1) {
        send({ choices: [{ delta: { content: "w " } }] });
        entry.completionTokens += 1;
      }
      // A stalled stream bills what it sent and never ends: the client's stall deadline aborts it.
      if (stall) return;
      send({
        choices: [],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens }
      });
      response.end("data: [DONE]\n\n");
    });
  });
  const usd = (entry: Billed) =>
    (entry.promptTokens * prices.input + entry.completionTokens * prices.output) / 1e6;
  return {
    server,
    billed,
    billedUsd: () => billed.reduce((sum, entry) => sum + usd(entry), 0),
    maximumConcurrent: () => maximumConcurrent
  };
}

const priceTable: PriceTable = PriceTableSchema.parse({
  ...defaultPriceTable,
  version: "test-priced-fake",
  entries: [
    ...defaultPriceTable.entries,
    {
      provider: "openai-compatible",
      model: modelId,
      billing: "per_token",
      inputUsdPerM: prices.input,
      cachedInputUsdPerM: prices.input,
      outputUsdPerM: prices.output,
      checkedAt: "2026-10-23",
      verified: true,
      source: "the test's priced fake"
    }
  ]
});

describe.skipIf(!sidecarInstalled)("the money cap against a priced fake (E4 part c)", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool;
  let fake: ReturnType<typeof pricedFake>;
  let baseUrl = "";

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-remote-budget-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_remote_budget_test",
        user: "memora_remote_budget_test",
        password: `remote-budget-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    fake = pricedFake(seeded(20261023));
    await new Promise<void>((done) => fake.server.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/v1`;
    const config = createAiConfigRepository(pool);
    const capabilities = ["text-generation", "structured-output", "summarization"];
    const provider = await config.upsertProvider({
      provider: "openai-compatible",
      displayName: "Priced fake",
      baseUrl,
      // The DEV flag puts the loopback fake in a remote lane under the remote deadlines (T62).
      metadata: { modelId, capabilities, treatAsRemote: true }
    });
    const profile = await config.createProfile({ name: "priced fake", isDefault: true });
    await config.updateProfile({
      id: profile.id,
      providerConfigId: provider.id,
      modelId,
      runtime: "remote",
      capabilities,
      privacyMode: "allow_remote"
    });
  }, 120_000);

  afterAll(async () => {
    fake?.server.closeAllConnections();
    await new Promise<void>((done) => (fake ? fake.server.close(() => done()) : done()));
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("keeps the billed spend within the cap, pauses at the share and stops at the cap", async () => {
    const budget = new RemoteBudget({
      getPool: () => pool,
      monthlyCapUsd: () => capUsd,
      priceTable
    });
    const runtime = {
      deadlines: { stallMs: 200, answerStartMs: 5_000, firstByteMs: 5_000 },
      retry: { baseDelayMs: 1, maxDelayMs: 5 }
    };
    const ai = new AiService({
      userDataPath: join(workDir, "user-data"),
      getPool: () => pool,
      workspaceRoot: workspace,
      resourcesPath: workspace,
      isPackaged: false,
      honourTreatAsRemote: true,
      lanes: { lanes: { apiKeyMax: 4 } },
      runtime,
      remoteBudget: budget
    });
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl,
      apiKey: "test-key-not-a-secret",
      modelId,
      capabilities: ["text-generation", "structured-output", "summarization"],
      runtime,
      treatAsRemote: true,
      random: () => 0
    });
    const internals = ai as unknown as {
      createAdapter: () => Promise<unknown>;
      registerAdapter: (adapter: unknown) => unknown;
    };
    vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
      internals.registerAdapter(adapter)
    );
    const call = (index: number, priority: "P3" | "P0" = "P3") =>
      ai.runDefaultTask(
        "text-generation",
        `Background call ${index}: write a short paragraph about gardens.`,
        {
          workloadClass: "write-fast",
          priority,
          budgetClass: priority === "P0" ? "interactive" : "background",
          operation: "budget_probe"
        },
        undefined,
        { maxOutputTokens }
      );
    const wave = async (from: number, count: number) => {
      const settled = await Promise.allSettled(
        Array.from({ length: count }, (_, index) => call(from + index))
      );
      const reasons = new Map<string, number>();
      for (const result of settled) {
        const reason =
          result.status === "fulfilled"
            ? "ok"
            : (remoteBudgetRefusalOf(result.reason)?.blockedReason ?? "failed");
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
      return reasons;
    };
    const estimate = budget.price("openai-compatible", modelId);
    // The largest error one attempt's estimate can make: its full output budget plus its input
    // bytes (the fake bills fewer tokens than bytes, so the error is never above the estimate).
    const largestAttemptUsd =
      (maxOutputTokens * estimate.outputUsdPerM + 2_000 * estimate.inputUsdPerM) / 1e6;

    // Waves of eight calls at a time until a whole wave is refused for `reason`: a refusal made while
    // other calls held reservations can clear when they settle below their estimates.
    const untilRefused = async (from: number, reason: string) => {
      const totals = new Map<string, number>();
      for (let round = 0; round < 12; round += 1) {
        const result = await wave(from + round * 8, 8);
        for (const [key, count] of result) totals.set(key, (totals.get(key) ?? 0) + count);
        if (result.get(reason) === 8) return totals;
      }
      throw new Error(`no whole wave was refused for ${reason}: ${JSON.stringify([...totals])}`);
    };

    // 1. Past the pause share remote background waits for the person.
    const first = await untilRefused(0, "money_80");
    expect(first.get("ok") ?? 0).toBeGreaterThan(0);
    expect(first.get("money_100") ?? 0).toBe(0);
    const paused = await budget.snapshot();
    expect(paused.money.state).toBe("paused");
    expect(paused.money.reservedUsd).toBe(0);
    expect(paused.money.spentUsd).toBeLessThanOrEqual(capUsd * paused.money.pauseShare + 1e-12);
    expect(fake.billedUsd()).toBeLessThanOrEqual(paused.money.spentUsd + 1e-12);

    // 2. The person continues: up to the cap, then local-only (refused with money_100).
    await budget.continuePastPause();
    expect((await budget.snapshot()).money.state).toBe("open");
    const second = await untilRefused(1_000, "money_100");
    expect(second.get("ok") ?? 0).toBeGreaterThan(0);
    expect(second.get("money_80") ?? 0).toBe(0);
    const capped = await budget.snapshot();
    expect(capped.money.state).toBe("exhausted");
    expect(capped.money.spentUsd).toBeLessThanOrEqual(capUsd + 1e-12);
    expect(capped.money.reservedUsd).toBe(0);
    // What the provider billed: within the cap plus one attempt's largest estimation error.
    expect(fake.billedUsd()).toBeLessThanOrEqual(capUsd + largestAttemptUsd);
    expect(fake.billedUsd()).toBeLessThanOrEqual(capped.money.spentUsd + 1e-12);

    // 3. Interactive work is never refused at the cap.
    await expect(call(999, "P0")).resolves.toMatchObject({ output: expect.any(String) });

    // 4. The ledger read back from the audit is what the budget counted.
    const reloaded = await budget.reload();
    expect(reloaded.money.spentUsd).toBeCloseTo(capped.money.spentUsd, 9);

    // The exercise covered what it claims: retries, stalls, and four calls at once.
    expect(fake.billed.some((entry) => entry.kind === "unavailable")).toBe(true);
    expect(fake.billed.some((entry) => entry.kind === "stall")).toBe(true);
    expect(fake.maximumConcurrent()).toBeGreaterThan(1);
    const audited = await pool.query<{ count: string }>(
      `select count(*)::text as count from ai_task_runs
         where budget_class = 'background' and lane like 'remote:%'`
    );
    expect(Number(audited.rows[0]?.count)).toBeGreaterThan(0);
  }, 120_000);
});
