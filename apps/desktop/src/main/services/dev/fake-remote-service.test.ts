import { OpenAiCodexAdapter, type AiRuntimeConfigInput } from "@app/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiService } from "../ai-service.js";
import {
  codexWireBasePath,
  codexWireKind,
  devCodexCredential,
  devFakeCodexModelId
} from "./fake-codex-provider.js";
import { FakeProviderServer, fixedLatency } from "./fake-remote-core.js";
import {
  FaultSchedule,
  faultPlanSchema,
  withFaults,
  type FaultPlanInput
} from "./fault-decorator.js";
import { parseBreakerLog } from "./soak-driver.js";
import { MemoryEventSink, type ExchangeRecord } from "./soak-records.js";

/**
 * The AI service on a Codex-wire fake that carries `treatAsRemote` (F3 R6, T62): what the audit
 * rows say about each injected fault. This is the evidence the pre-soak asserts at scale: the late
 * first byte and the stall end the call `aborted` with their error class, a 429 and a 503 end it
 * `met`, the audit's lane is the fake's own remote lane, and the circuit breaker opens during an
 * outage and closes after it.
 */

const state = vi.hoisted(() => ({
  selection: null as Record<string, unknown> | null,
  record: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({
    getDefaultTask: async () => state.selection,
    recordTaskRun: state.record
  }),
  createLocalModelRepository: () => ({ findById: async () => null })
}));

const configId = "00000000-0000-4000-8000-0000000000c1";
const runtime: AiRuntimeConfigInput = {
  deadlines: {
    connectMs: 1_000,
    firstByteMs: 300,
    stallMs: 150,
    answerStartMs: 5_000,
    totalMs: { "write-fast": 6_000 }
  },
  retry: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 10, maxInlineRetryAfterMs: 1_000 }
};

const servers: FakeProviderServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  vi.restoreAllMocks();
});

const rows = () => state.record.mock.calls.map(([row]) => row as Record<string, unknown>);

async function harness(plan: FaultPlanInput, breaker = { failureThreshold: 5, openMs: 30_000 }) {
  const sink = new MemoryEventSink();
  const schedule = new FaultSchedule(faultPlanSchema.parse(plan), 20261021, "codex-wire");
  const server = new FakeProviderServer({
    kind: withFaults(codexWireKind({ seed: 20261021, latency: fixedLatency(40) }), schedule),
    sink,
    windows: schedule.windows()
  });
  await server.start();
  servers.push(server);
  state.selection = {
    routeKey: "op:relation_explanation",
    profileId: "00000000-0000-4000-8000-000000000001",
    providerConfigId: configId,
    localModelId: null,
    provider: "openai-codex",
    modelId: devFakeCodexModelId,
    runtime: "remote",
    revision: null,
    repository: null,
    quantization: null,
    baseUrl: `${server.origin}${codexWireBasePath}`,
    parameters: {},
    modelDefaultParameters: {},
    providerMetadata: { treatAsRemote: true },
    requiredCapabilities: ["text-generation"]
  };
  const logger = { error: vi.fn(), info: vi.fn() };
  const ai = new AiService({
    userDataPath: "/tmp/fake-remote-service",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    honourTreatAsRemote: true,
    runtime,
    lanes: { breaker },
    logger
  });
  const internals = ai as unknown as {
    createAdapter: () => Promise<unknown>;
    registerAdapter: (adapter: unknown) => unknown;
  };
  const adapter = new OpenAiCodexAdapter({
    accessToken: devCodexCredential.access,
    accountId: devCodexCredential.accountId,
    modelId: devFakeCodexModelId,
    capabilities: ["text-generation"],
    baseUrl: `${server.origin}${codexWireBasePath}`,
    runtime,
    random: () => 0
  });
  vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
    internals.registerAdapter(adapter)
  );
  const explain = () =>
    ai.runDefaultTask("text-generation", "Explain n1 and n2.", {
      operation: "relation_explanation",
      workloadClass: "write-fast",
      priority: "P0"
    });
  const exchanges = () =>
    sink.events.filter((event): event is ExchangeRecord => event.type === "exchange");
  return { ai, explain, exchanges, logger, sink };
}

beforeEach(() => {
  state.record.mockReset().mockResolvedValue("run-id");
});

describe("a Codex-wire fake that counts as remote, through the AI service", () => {
  it("serves an explanation in its own remote lane under the remote deadline", async () => {
    const { explain } = await harness({});
    await expect(explain()).resolves.toMatchObject({ output: expect.any(String) });
    expect(rows()[0]).toMatchObject({
      lane: `remote:${configId}`,
      priority: 0,
      workloadClass: "write-fast",
      deadlineMs: 6_000,
      deadlineOutcome: "met",
      status: "succeeded"
    });
  });

  it("ends a call whose three attempts all got a late first byte as aborted, on the no-data error", async () => {
    const { explain, exchanges } = await harness({
      lateFirstByteMs: 450,
      forced: [{ kind: "late_first_byte", afterMinute: 0, count: 3 }]
    });
    await expect(explain()).rejects.toMatchObject({ kind: "timeout" });
    expect(rows()[0]).toMatchObject({
      status: "failed",
      deadlineOutcome: "aborted",
      error: expect.stringMatching(/sent no data within 300 ms/u)
    });
    await vi.waitFor(() => expect(exchanges()).toHaveLength(3));
    for (const exchange of exchanges()) {
      expect(exchange).toMatchObject({ kind: "late_first_byte", outcome: "client_closed" });
      expect(exchange.closedAfterMs).toBeGreaterThanOrEqual(280);
      expect(exchange.closedAfterMs).toBeLessThan(440);
    }
  });

  it("ends three stalls in a row as aborted, on the stalled error", async () => {
    const { explain, exchanges } = await harness({
      stallMs: 600,
      forced: [{ kind: "stall", afterMinute: 0, count: 3 }]
    });
    await expect(explain()).rejects.toMatchObject({ kind: "stalled" });
    expect(rows()[0]).toMatchObject({
      status: "failed",
      deadlineOutcome: "aborted",
      error: expect.stringMatching(/stalled for 150 ms/u)
    });
    await vi.waitFor(() => expect(exchanges()).toHaveLength(3));
    expect(exchanges().every((exchange) => (exchange.closedAfterLastWriteMs ?? 0) >= 130)).toBe(
      true
    );
  });

  it("ends a 429 and a 503 as met: retried to an answer, or failed transient inside the deadline", async () => {
    const { explain } = await harness({
      retryAfterSeconds: [0, 0],
      forced: [
        { kind: "rate_limit", afterMinute: 0, count: 1 },
        { kind: "unavailable", afterMinute: 0, count: 3 }
      ]
    });
    // The 429 is retried inside the call; the 503s that follow exhaust the attempts.
    await expect(explain()).rejects.toMatchObject({ status: 503, transient: true });
    expect(rows()[0]).toMatchObject({
      status: "failed",
      deadlineOutcome: "met",
      error: expect.stringMatching(/503|overloaded/iu)
    });
    state.record.mockClear();
    await expect(explain()).resolves.toMatchObject({ output: expect.any(String) });
    expect(rows()[0]).toMatchObject({ status: "succeeded", deadlineOutcome: "met" });
  });

  it("opens the breaker during an outage and closes it through the first call after it", async () => {
    const { explain, logger, sink } = await harness(
      { windows: [{ kind: "outage", startMinute: 0.0003, durationMinutes: 0.01 }] },
      { failureThreshold: 5, openMs: 250 }
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(explain()).rejects.toMatchObject({ kind: "network" });
    await expect(explain()).rejects.toMatchObject({ kind: "network" });
    // Six refused attempts opened it: the next call is refused without a request.
    await expect(explain()).rejects.toThrow("errors.ai.providerUnavailable");
    await vi.waitFor(
      () => expect(sink.events.some((event) => event.type === "window")).toBe(true),
      {
        timeout: 2_000
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(explain()).resolves.toMatchObject({ output: expect.any(String) });
    const moves = logger.info.mock.calls
      .map(([line]) => parseBreakerLog(String(line), 0))
      .filter((event) => event !== null)
      .map((event) => `${event!.from}->${event!.to}`);
    expect(moves).toEqual(["closed->open", "open->half_open", "half_open->closed"]);
    expect(rows().map((row) => row.deadlineOutcome)).toEqual(["met", "met", "met", "met"]);
  });
});
