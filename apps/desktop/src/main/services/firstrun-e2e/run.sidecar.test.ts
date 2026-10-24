import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePostgresSidecarPaths } from "@app/db";
import {
  TopicClusteringRequestSchema,
  checkTopicClusteringResult,
  topicTreeConfigWith
} from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clusterTopics } from "../../workers/topic-clustering.worker.js";
import { catalogHeaderRefreshEnabled } from "../catalog-header-policy.js";
import { isExtractionPinned } from "../extraction-pin.js";
import { productLinkRuntime, relationLinkRuntime } from "../relations/link-runtime.js";
import type { ClusterTopics } from "../topic-tree/topic-build.js";
import { sharedElectronStub } from "../topics-e2e/electron-stub.js";
import { parseFirstRunArgs, recordFileName } from "./config.js";
import type { FirstRunConfig } from "./config.js";
import { invokedSetupChannels } from "./sequence.js";
import { replaysAgree, runFirstRunE2e } from "./run.js";
import type { PassResult } from "./run.js";

// The services import Electron for its secure storage and dialogs; the harness runs without it.
vi.mock("electron", async () => {
  const { sharedElectronStub: stub } = await import("../topics-e2e/electron-stub.js");
  return { ...stub().module, default: stub().module };
});

/**
 * The first-run Hybrid end-to-end harness (F4 T90) on a throwaway PostgreSQL sidecar, in its
 * synthetic mode: a fresh database, the Hybrid setup through the product's handlers (the writer's
 * sign-in, the simulated install of the embedder, the preset, one test per class), the first-run
 * ranker installed next to it, two small papers, a synthetic model under a real cassette, the clock
 * and the E6 checks. It records the cassette, replays it twice with recorded timing and 0 misses,
 * and a replay against a cassette with calls missing fails. The real papers, Docling, the real
 * downloads and models are the orchestrator's proof (`npm run firstrun:e2e`).
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

/** The clustering worker's own code, run in process (no built worker host under vitest). */
const clusterInProcess: ClusterTopics = async (request) => {
  const parsed = TopicClusteringRequestSchema.parse(request);
  const result = clusterTopics(parsed);
  checkTopicClusteringResult(result, parsed);
  return result;
};

describe.skipIf(!sidecarAvailable)(
  "the first-run Hybrid end-to-end harness on the PostgreSQL sidecar",
  () => {
    let workDir = "";
    let config: FirstRunConfig;
    let passes: PassResult[] = [];
    const events: Array<{ event: string; data: Record<string, unknown> | undefined }> = [];

    const deps = () => ({
      electron: sharedElectronStub(),
      env: {},
      log: (event: string, data?: Record<string, unknown>) => void events.push({ event, data }),
      pollIntervalMs: 20,
      quietPolls: 5,
      syntheticInstallMs: 200,
      // No status port: the pass reads the product's own GardenerStatusService (T86).
      clusterTopics: clusterInProcess,
      newTreeConfig: () => topicTreeConfigWith({ jobs: { debounceMs: 0, debounceCapMs: 0 } })
    });

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), "memora-firstrun-e2e-test-"));
      const parsed = parseFirstRunArgs(
        [
          "--synthetic",
          "--replays",
          "2",
          "--cassette-dir",
          join(workDir, "cassette"),
          "--report",
          join(workDir, "report"),
          "--work-dir",
          join(workDir, "scratch"),
          "--lane-timeout",
          "2"
        ],
        { repositoryRoot: workspaceRoot }
      );
      if (parsed === "help") throw new Error("help");
      config = parsed;
      passes = await runFirstRunE2e(config, deps());
    }, 420_000);

    afterAll(async () => {
      await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }, 120_000);

    it("records the synthetic first run and replays it twice with 0 misses, every check passing", () => {
      expect(passes.map((pass) => `${pass.mode}-${pass.index}`)).toEqual([
        "record-1",
        "replay-1",
        "replay-2"
      ]);
      for (const pass of passes) {
        expect(
          pass.report.checks.filter((check) => !check.passed),
          pass.markdown
        ).toEqual([]);
        expect(pass.report.passed).toBe(true);
      }
      const [record, ...replays] = passes.map((pass) => pass.report.reported.cassette);
      expect(record!.recorded).toBeGreaterThan(0);
      for (const replay of replays)
        expect(replay).toMatchObject({
          mode: "replay",
          recorded: 0,
          misses: 0,
          served: record!.recorded,
          timing: "recorded"
        });
    });

    it("makes the same library in the recording and in both replays (one digest)", () => {
      const digests = passes.map((pass) => pass.report.reported.endState.digest);
      expect(digests[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(new Set(digests).size).toBe(1);
      expect(replaysAgree(passes)).toBe(true);
      expect(passes[0]!.report.reported.endState.noteRelations).toBe(1);
    });

    it("plays the onboarding sequence in order, then makes 0 Settings calls", () => {
      for (const pass of passes) {
        const { ipc } = pass.report.reported;
        expect(ipc.registered.settings).toBeGreaterThan(40);
        const setup = ipc.phases.setup!.map((entry) => `${entry.channel} x${entry.calls}`).sort();
        expect(setup).toEqual(
          [
            "app:ai:class-routes:apply-preset x1",
            "app:ai:class-routes:test x5",
            "app:ai:profiles:create x1",
            "app:ai:profiles:update x1",
            "app:ai:providers:save x1",
            "app:local-models:download x1",
            "app:local-models:list x1",
            "app:settings:app:update x1"
          ].sort()
        );
        expect(ipc.phases.user!.every((entry) => entry.class === "product")).toBe(true);
        expect(pass.report.checks.find((check) => check.id === "sequence")?.detail).toBe(
          `${invokedSetupChannels("codex").length} calls`
        );
      }
    });

    it("applies Hybrid: local embedder, local ranker routed by the first run, remote writer", () => {
      for (const pass of passes) {
        const { hybrid, models, firstRunRanker } = pass.report.reported;
        expect(hybrid.preset).toBe("hybrid");
        expect(hybrid.routes).toMatchObject({
          embedding: "embedder",
          "class:embed": "embedder",
          "class:decide": "ranker",
          "class:write-fast": "writer",
          "class:write-quality": "writer",
          "class:answer": "writer",
          "structured-output": "writer"
        });
        expect(models.embedding).toMatchObject({ installed: true, status: "ready" });
        expect(models.ranker).toMatchObject({ installed: true, validated: true });
        expect(firstRunRanker).toMatchObject({
          state: "ready",
          catalogId: models.ranker.catalogId
        });
        expect(pass.report.reported.setup!.tests.map((test) => test.state)).toEqual([
          "passed",
          "passed",
          "passed",
          "passed",
          "passed"
        ]);
      }
    });

    it("reads the product's status while the run waits for a download, and it says why", () => {
      for (const pass of passes) {
        const check = pass.report.checks.find((entry) => entry.id === "status")!;
        expect(check.passed, check.detail).toBe(true);
        const status = pass.report.reported.statusAtStalls!;
        expect(status).toMatchObject({ unexplained: 0 });
        expect(status.stalls).toBeGreaterThan(0);
        // A wait that holds Gardener tasks names its class (a download, a queue...); idle is read
        // only where none waits (T86). A sentence never names nothing while a task waits.
        expect(status.classes.idle ?? 0).toBeLessThanOrEqual(status.quiet);
      }
    });

    it("hears every install through the event bus and keeps no job set aside at the end", () => {
      for (const pass of passes) {
        const check = pass.report.checks.find((entry) => entry.id === "events")!;
        expect(check.passed, check.detail).toBe(true);
        expect(pass.report.reported.blockedJobs).toEqual({});
      }
    });

    it("reaches T1 with a first-source note in a named topic and a shown relation", () => {
      for (const pass of passes) {
        const { connection, relations, clock } = pass.report.reported;
        expect(connection).toMatchObject({ crossSource: true });
        expect(connection!.topicTitle).toMatch(/ e /);
        expect(["applied", "suggested", "kept"]).toContain(connection!.relationState);
        expect(relations).toMatchObject({ shown: 1, betweenSources: 1 });
        expect(clock.t1Ms).toBeGreaterThan(clock.appLaunchMs);
        expect(clock.drainedMs).toBeGreaterThanOrEqual(clock.t1Ms!);
        expect(pass.store.currentNotes).toBe(36 + 15);
        expect(pass.report.reported.sources.map((source) => source.notes)).toEqual([36, 15]);
      }
    });

    it("measures the clock from app launch, and the replay adds the recording's download term D", () => {
      const [record, ...replays] = passes;
      const live = record!.report.reported.clock;
      expect(live.download.source).toBe("this run");
      // The self-test's install takes 200 ms per model; the person waits for the embedder alone.
      expect(live.download.criticalPathMs).toBeGreaterThan(0);
      expect(live.download.setupMs).toBeGreaterThan(0);
      expect(live.installs.map((install) => install.catalogId)).toHaveLength(2);
      expect(Object.keys(live.marks)).toEqual(
        expect.arrayContaining([
          "launch.database",
          "launch.migrations",
          "launch.services",
          "setup.embedder_ready",
          "setup.preset",
          "heavy.first",
          "heavy.second",
          "t1",
          "drained"
        ])
      );
      expect(record!.record!.timing).toMatchObject({
        downloadCriticalPathMs: live.download.criticalPathMs,
        appLaunchMs: live.appLaunchMs
      });
      for (const replay of replays) {
        const clock = replay.report.reported.clock;
        expect(clock.download).toMatchObject({
          source: "the recording",
          criticalPathMs: live.download.criticalPathMs
        });
        expect(replay.report.reported.withDownloadMs).toBe(
          clock.t1Ms! + live.download.criticalPathMs
        );
        const gate = replay.report.checks.find((check) => check.id === "gate")!;
        expect(gate.passed, gate.detail).toBe(true);
      }
      expect(record!.report.checks.some((check) => check.id === "gate")).toBe(false);
    });

    it("keeps the record next to the cassette without credentials, paths or the key", async () => {
      const text = await readFile(join(workDir, "cassette", recordFileName), "utf8");
      expect(JSON.parse(text)).toMatchObject({
        format: "memora-firstrun-e2e-record",
        synthetic: true,
        contentLanguage: "pt-BR",
        writer: { kind: "codex", modelId: "synthetic-codex" },
        result: { notes: 51, topics: 3, noteRelations: 1 },
        timing: { live: true }
      });
      expect(text).not.toContain("placeholder-access-token");
      expect(text).not.toContain("credentialFile");
      expect(text).not.toContain(workDir);
    });

    it("serves the replays from the cassette alone: the audit shows no live call", () => {
      for (const replay of passes.slice(1)) {
        const adapters = new Set(replay.store.aiCalls.map((call) => call.adapter));
        expect(adapters).toEqual(new Set(["cassette-replay"]));
      }
    });

    it("switches the catalog-header refresh off and lets go of every process-wide hold when it ends", () => {
      for (const pass of passes)
        expect(pass.catalogHeaders).toEqual({ refresh: "off", reason: "topics_e2e", jobs: 0 });
      expect(catalogHeaderRefreshEnabled({})).toBe(true);
      expect(isExtractionPinned()).toBe(false);
      expect(relationLinkRuntime()).toEqual(productLinkRuntime);
    });

    it("runs on a fresh database with its own scratch workspace, removed afterwards", async () => {
      expect(passes.every((pass) => !pass.kept)).toBe(true);
      for (const pass of passes) expect(existsSync(pass.workDir)).toBe(false);
      const scratch = join(workDir, "scratch");
      expect(existsSync(scratch) ? await readdir(scratch) : []).toEqual([]);
    });

    it("writes one report per pass", async () => {
      for (const name of ["record", "replay-1", "replay-2"]) {
        const report = JSON.parse(
          await readFile(join(workDir, "report", name, "report.json"), "utf8")
        );
        expect(report.report.format).toBe("memora-firstrun-e2e");
        expect(report.report.passed).toBe(true);
        expect(existsSync(join(workDir, "report", name, "report.md"))).toBe(true);
      }
    });

    it("refuses to record over a cassette that holds calls, whose clock would not be live, unless resumed", async () => {
      await expect(
        runFirstRunE2e({ ...config, mode: "record", replays: 1 }, deps())
      ).rejects.toThrow(/already holds recorded calls.*--resume/su);
    });

    it("fails a replay whose cassette lacks calls, reports the miss and stops early", async () => {
      const damaged = join(workDir, "damaged");
      await cp(join(workDir, "cassette"), damaged, { recursive: true });
      // Keep the manifest and the record, drop every recorded answer.
      await rm(join(damaged, "entries"), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 300
      });
      const [replay] = await runFirstRunE2e(
        {
          ...config,
          mode: "replay",
          replays: 1,
          cassetteDir: damaged,
          keep: false,
          reportDir: join(workDir, "damaged-report")
        },
        deps()
      );
      expect(replay!.report.passed).toBe(false);
      const failed = replay!.report.checks
        .filter((check) => !check.passed)
        .map((check) => check.id);
      expect(failed).toContain("cassette");
      expect(failed).toContain("lane");
      expect(replay!.report.reported.cassette.misses).toBeGreaterThan(0);
      // A failed run keeps its scratch workspace for diagnosis.
      expect(replay!.kept).toBe(true);
      expect(existsSync(replay!.workDir)).toBe(true);
      await rm(replay!.workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }, 240_000);
  }
);
