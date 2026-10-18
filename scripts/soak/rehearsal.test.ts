import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenAiCodexAdapter, OpenAiCompatibleAdapter, type AiRuntimeConfigInput } from "@app/ai";
import { afterAll, describe, expect, it, vi } from "vitest";

import { analyzeRun, loadRun } from "./report.ts";
import { AiService } from "../../apps/desktop/src/main/services/ai-service.ts";
import {
  consultationEvidence,
  consultationSnapshot
} from "../../apps/desktop/src/main/services/consultation-fixture.ts";
import {
  consultationPrompt,
  parseConsultationAnswer
} from "../../apps/desktop/src/main/services/consultation-service.ts";
import { parseRelationExplanation } from "../../apps/desktop/src/main/services/relation-explanation.ts";
import {
  codexWireBasePath,
  codexWireKind,
  devCodexCredential,
  devFakeCodexModelId
} from "../../apps/desktop/src/main/services/dev/fake-codex-provider.ts";
import {
  FakeProviderServer,
  fixedLatency
} from "../../apps/desktop/src/main/services/dev/fake-remote-core.ts";
import {
  devFakeAnswerModelId,
  devFakeApiKey,
  openAiCompatibleKind
} from "../../apps/desktop/src/main/services/dev/fake-remote-provider.ts";
import {
  FaultSchedule,
  withFaults
} from "../../apps/desktop/src/main/services/dev/fault-decorator.ts";
import {
  parseBreakerLog,
  runSoak,
  type SoakPorts
} from "../../apps/desktop/src/main/services/dev/soak-driver.ts";
import { soakProfileSchema } from "../../apps/desktop/src/main/services/dev/soak-plan.ts";
import {
  fileEventSink,
  type TaskRunRecord
} from "../../apps/desktop/src/main/services/dev/soak-records.ts";

/**
 * A rehearsal of the whole soak at the scale of seconds (F3 T62): the real driver, the two real
 * fakes with their faults and windows, the real adapters under the real AI service (lanes,
 * breaker, audit), and the real report on the folder they write. Time is compressed so the 25 s and
 * 35 s faults play against bounds of 150 and 300 ms; nothing else differs from the pre-soak. What it
 * proves is that the harness agrees with itself: the records the driver, the fakes and the service
 * write are what the report's pre-soak assertion reads, for every fault kind on both fakes.
 */

const state = vi.hoisted(() => ({
  selections: {} as Record<string, Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({
    getDefaultTask: async (task: string, _profile: unknown, routeKeys: readonly string[] = []) => {
      const keys = [task, ...routeKeys];
      return keys.includes("op:relation_explanation")
        ? state.selections.codex
        : keys.includes("class:answer")
          ? state.selections.compatible
          : null;
    },
    recordTaskRun: async (row: Record<string, unknown>) => {
      state.rows.push({ ...row, finishedAt: Date.now() });
      return randomUUID();
    }
  }),
  createLocalModelRepository: () => ({ findById: async () => null })
}));

const second = 1 / 60;
const at = (seconds: number) => Number((seconds * second).toFixed(5));
const rate = { rateLimit: 0, unavailable: 0, stall: 0, lateFirstByte: 0, malformed: 0 };
const latency = {
  fit: null,
  task: null,
  fixedMs: 60,
  minMs: 0,
  maxMs: 1_000,
  firstByteFraction: 0.3
};

const profile = soakProfileSchema.parse({
  seed: 20261021,
  durationHours: at(22) / 60,
  warmupMinutes: 0,
  sampleEveryMinutes: at(1),
  driver: {
    explain: { everyMinutes: at(2), offsetMinutes: at(0.5) },
    ask: { everyMinutes: at(2), offsetMinutes: at(1) },
    explainBurst: { everyMinutes: 60, offsetMinutes: at(6), count: 3 },
    article: { everyMinutes: 600 },
    noteEdit: { everyMinutes: 600 },
    sourceReimport: { everyMinutes: 600 },
    typingFault: { everyMinutes: 600 },
    postOutageProbeSeconds: 1
  },
  remote: {
    openAiCompatible: {
      latency,
      faults: {
        rates: rate,
        retryAfterSeconds: [0, 0],
        stallMs: 600,
        lateFirstByteMs: 450,
        windows: [{ kind: "slow", startMinute: at(15), durationMinutes: at(4), factor: 5 }],
        forced: [
          { kind: "unavailable", afterMinute: at(0.9), count: 3 },
          { kind: "stall", afterMinute: at(2.9), count: 3 },
          { kind: "late_first_byte", afterMinute: at(4.9), count: 3 },
          { kind: "rate_limit", afterMinute: at(6.9), count: 2 },
          { kind: "malformed", afterMinute: at(8.9), count: 1 }
        ]
      }
    },
    codexWire: {
      latency,
      notRelatedRate: 0,
      faults: {
        rates: rate,
        retryAfterSeconds: [0, 0],
        stallMs: 600,
        lateFirstByteMs: 450,
        windows: [{ kind: "outage", startMinute: at(5.5), durationMinutes: at(1.5) }],
        forced: [
          { kind: "rate_limit", afterMinute: at(0.4), count: 2 },
          { kind: "unavailable", afterMinute: at(2.4), count: 3 },
          { kind: "stall", afterMinute: at(4.4), count: 3 },
          { kind: "late_first_byte", afterMinute: at(8.4), count: 3 },
          { kind: "malformed", afterMinute: at(10.4), count: 1 }
        ]
      }
    }
  },
  local: { mlxKill: { everyMinutes: 600 }, ggufAbort: { everyMinutes: 600 } },
  bounds: { connectMs: 1_000, firstByteMs: 300, stallMs: 150 }
});

const runtime: AiRuntimeConfigInput = {
  deadlines: {
    connectMs: 1_000,
    firstByteMs: 300,
    stallMs: 150,
    answerStartMs: 5_000,
    totalMs: { "write-fast": 6_000, answer: 6_000 }
  },
  retry: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 10, maxInlineRetryAfterMs: 1_000 }
};

const ids = {
  compatible: "00000000-0000-4000-8000-0000000000a1",
  codex: "00000000-0000-4000-8000-0000000000c1"
};
const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const snapshot = consultationSnapshot({
  evidence: [consultationEvidence(1), consultationEvidence(2)]
});
const askPrompt = consultationPrompt(snapshot, "What improves delayed recall?");

describe("a compressed pre-soak, from the driver to the report", () => {
  it(
    "ends every injected fault kind of both fakes with the outcome the deadlines say",
    { timeout: 120_000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "soak-rehearsal-"));
      directories.push(directory);
      const sink = fileEventSink(join(directory, "events.ndjson"));

      const fakes = (["compatible", "codex"] as const).map((name) => {
        const faults =
          name === "codex"
            ? profile.remote.codexWire.faults
            : profile.remote.openAiCompatible.faults;
        const kind = name === "codex" ? "codex-wire" : "openai-compatible";
        const schedule = new FaultSchedule(faults, profile.seed, kind);
        const server = new FakeProviderServer({
          kind: withFaults(
            name === "codex"
              ? codexWireKind({ seed: profile.seed, latency: fixedLatency(60), notRelatedRate: 0 })
              : openAiCompatibleKind({ seed: profile.seed, latency: fixedLatency(60) }),
            schedule
          ),
          sink,
          windows: schedule.windows()
        });
        return { name, server };
      });
      await Promise.all(fakes.map((fake) => fake.server.start()));
      const [compatible, codex] = fakes.map((fake) => fake.server) as [
        FakeProviderServer,
        FakeProviderServer
      ];

      const common = {
        profileId: "00000000-0000-4000-8000-000000000001",
        localModelId: null,
        runtime: "remote",
        revision: null,
        repository: null,
        quantization: null,
        parameters: {},
        modelDefaultParameters: {},
        providerMetadata: { treatAsRemote: true }
      };
      state.selections.compatible = {
        ...common,
        routeKey: "class:answer",
        providerConfigId: ids.compatible,
        provider: "openai-compatible",
        modelId: devFakeAnswerModelId,
        baseUrl: `${compatible.origin}/v1`,
        requiredCapabilities: ["text-generation", "structured-output"]
      };
      state.selections.codex = {
        ...common,
        routeKey: "op:relation_explanation",
        providerConfigId: ids.codex,
        provider: "openai-codex",
        modelId: devFakeCodexModelId,
        baseUrl: `${codex.origin}${codexWireBasePath}`,
        requiredCapabilities: ["text-generation"]
      };

      const logger = {
        error: () => undefined,
        info: (line: string) => {
          const event = parseBreakerLog(line, Date.now());
          if (event) sink.append(event);
        }
      };
      const ai = new AiService({
        userDataPath: "/tmp/soak-rehearsal",
        getPool: () => ({}) as never,
        workspaceRoot: "/tmp",
        resourcesPath: "/tmp",
        isPackaged: false,
        honourTreatAsRemote: true,
        runtime,
        lanes: { breaker: { failureThreshold: 5, openMs: 250 } },
        logger
      });
      const internals = ai as unknown as {
        createAdapter: (id: string) => Promise<unknown>;
        registerAdapter: (adapter: unknown) => unknown;
      };
      vi.spyOn(internals, "createAdapter").mockImplementation(async (providerId: string) =>
        internals.registerAdapter(
          providerId === ids.codex
            ? new OpenAiCodexAdapter({
                accessToken: devCodexCredential.access,
                accountId: devCodexCredential.accountId,
                modelId: devFakeCodexModelId,
                capabilities: ["text-generation"],
                baseUrl: `${codex.origin}${codexWireBasePath}`,
                runtime,
                random: () => 0
              })
            : new OpenAiCompatibleAdapter({
                baseUrl: `${compatible.origin}/v1`,
                apiKey: devFakeApiKey,
                modelId: devFakeAnswerModelId,
                capabilities: ["text-generation", "structured-output"],
                runtime,
                random: () => 0,
                treatAsRemote: true
              })
        )
      );

      // The two consumers of the product, in miniature: one validation, one re-ask.
      const explainOnce = async () => {
        const first = await ai.runDefaultTask("text-generation", "Explain n1 and n2.", {
          operation: "relation_explanation",
          workloadClass: "write-fast",
          priority: "P0"
        });
        if (parseRelationExplanation(first?.output) !== null) return "explained";
        // The service asks once more under the same operation, as the second attempt.
        await ai.runDefaultTask("text-generation", "Explain n1 and n2. Answer again.", {
          operation: "relation_explanation",
          workloadClass: "write-fast",
          priority: "P0",
          attempt: 1
        });
        return "repaired";
      };
      const askOnce = async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await ai.runDefaultTask("structured-output", askPrompt, {
            operation: "wiki-consultation",
            workloadClass: "answer",
            priority: "P0",
            attempt: attempt + 1
          });
          try {
            parseConsultationAnswer(result?.output, snapshot);
            return "answered";
          } catch {
            // The consultation asks once more.
          }
        }
        return "invalid";
      };
      const none = async () => ({});
      const ports: SoakPorts = {
        importArticle: none,
        ask: async () => ({ outcome: await askOnce().catch(() => "failed") }),
        explain: async (count) => ({
          outcomes: (
            await Promise.all(
              Array.from({ length: count }, () => explainOnce().catch(() => "failed"))
            )
          ).join(",")
        }),
        editNote: none,
        reimportSource: none,
        importTypingFaultSource: none,
        killMlxHelper: async () => ({ killed: false, detail: {} }),
        armGgufAbort: none,
        sample: async () => ({
          lanes: ai.laneSnapshots().map((lane) => ({
            lane: lane.lane,
            limit: lane.limit,
            running: lane.running,
            held: lane.held,
            waiting: { ...lane.waiting },
            rateLimits: lane.rateLimits,
            breaker: lane.breaker?.state ?? null
          })),
          jobs: [],
          jobCounts: {},
          helper: null,
          appRssMb: 500,
          pageouts: null,
          pageSizeBytes: null,
          eventLoopLagP99Ms: null,
          dbPool: null
        }),
        taskRuns: async (sinceMs) =>
          state.rows
            .filter((row) => (row.finishedAt as number) > sinceMs)
            .map((row): TaskRunRecord => ({
              id: `${row.finishedAt}-${state.rows.indexOf(row)}`,
              taskType: String(row.taskType),
              provider: String(row.provider),
              modelId: String(row.modelId),
              runtime: String(row.runtime),
              workloadClass: (row.workloadClass as string | null) ?? null,
              lane: (row.lane as string | null) ?? null,
              priority: (row.priority as number | null) ?? null,
              deadlineMs: (row.deadlineMs as number | null) ?? null,
              deadlineOutcome: (row.deadlineOutcome as string | null) ?? null,
              isRepair: row.isRepair === true,
              schemaMode: (row.schemaMode as string | null) ?? null,
              retryWaitMs: (row.retryWaitMs as number | null) ?? null,
              requeueMs: (row.requeueMs as number | null) ?? null,
              queueMs: (row.queueMs as number | null) ?? null,
              durationMs: row.durationMs as number,
              attempt: (row.attempt as number | null) ?? null,
              status: String(row.status),
              error: row.error ? String(row.error).slice(0, 300) : null,
              startedAt: new Date(
                (row.finishedAt as number) - (row.durationMs as number)
              ).toISOString(),
              finishedAt: new Date(row.finishedAt as number).toISOString()
            })),
        stopRequested: async () => false
      };

      for (const fake of fakes) fake.server.restartClock();
      const outcome = await runSoak({
        profile,
        profileName: "presoak-rehearsal",
        directory,
        run: "rehearsal",
        ports,
        sink,
        logger: { info: () => undefined, error: () => undefined },
        meta: {
          host: { platform: "darwin", arch: "arm64", totalMemoryMb: 16_384 },
          catalogHeader: { refresh: "on", reason: null },
          bounds: profile.bounds,
          providers: [
            {
              provider: "openai-compatible",
              providerConfigId: ids.compatible,
              baseUrl: `${compatible.origin}/v1`
            },
            {
              provider: "codex-wire",
              providerConfigId: ids.codex,
              baseUrl: `${codex.origin}${codexWireBasePath}`
            }
          ]
        },
        settleMs: 5_000
      });
      await Promise.all(fakes.map((fake) => fake.server.stop()));
      await sink.flush();
      expect(outcome.reason).toBe("duration");
      expect(outcome.failed).toBe(0);

      const loaded = await loadRun(directory);
      const report = analyzeRun(loaded, { presoak: true });
      const summary = report.presoak!.map(
        (entry) =>
          `${entry.provider} ${entry.kind} x${entry.occurrences}: ${entry.status} | ${entry.attempt} | ${entry.call}`
      );
      // Every kind on both fakes, the outage and the slow window.
      expect(report.presoak!.map((entry) => `${entry.provider}:${entry.kind}`).toSorted()).toEqual([
        "codex-wire:late_first_byte",
        "codex-wire:malformed",
        "codex-wire:outage",
        "codex-wire:rate_limit",
        "codex-wire:stall",
        "codex-wire:unavailable",
        "openai-compatible:late_first_byte",
        "openai-compatible:malformed",
        "openai-compatible:rate_limit",
        "openai-compatible:slow",
        "openai-compatible:stall",
        "openai-compatible:unavailable"
      ]);
      expect(
        summary.filter((line) => !line.includes(": pass |")),
        summary.join("\n")
      ).toEqual([]);
      // The breaker opened with the outage and closed through the probe that follows it.
      expect(report.checks.find((check) => check.id === "breaker")?.status).toBe("pass");
      expect(report.checks.find((check) => check.id === "past-deadline")?.status).toBe("pass");
    }
  );
});
