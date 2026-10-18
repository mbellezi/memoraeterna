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
import type { ClusterTopics } from "../topic-tree/topic-build.js";
import { parseE2eArgs } from "./config.js";
import type { E2eConfig } from "./config.js";
import { sharedElectronStub } from "./electron-stub.js";
import { runTopicsE2e } from "./run.js";
import type { PassResult } from "./run.js";

// The services import Electron for its secure storage and dialogs; the harness runs without it.
vi.mock("electron", async () => {
  const { sharedElectronStub: stub } = await import("./electron-stub.js");
  return { ...stub().module, default: stub().module };
});

/**
 * The zero-config end-to-end harness (F2 T32) on a throwaway PostgreSQL sidecar, in its synthetic
 * mode: a fresh database, the first-run configuration through the Settings handlers, a small
 * library whose notes carry their theme in their words, a synthetic model under a real cassette,
 * and the E6 assertions. It records the cassette, replays it with 0 misses, and a replay against a
 * cassette with calls missing fails. The real paper, Docling and the models are the orchestrator's
 * proof (`npm run topics:e2e`).
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
  "the zero-config end-to-end harness on the PostgreSQL sidecar",
  () => {
    let workDir = "";
    let config: E2eConfig;
    let passes: PassResult[] = [];

    const deps = () => ({
      electron: sharedElectronStub(),
      env: {},
      pollIntervalMs: 20,
      quietPolls: 5,
      clusterTopics: clusterInProcess,
      newTreeConfig: () => topicTreeConfigWith({ jobs: { debounceMs: 0, debounceCapMs: 0 } })
    });

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), "memora-topics-e2e-test-"));
      const parsed = parseE2eArgs(
        [
          "--synthetic",
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
      passes = await runTopicsE2e(config, deps());
    }, 240_000);

    afterAll(async () => {
      await rm(workDir, { recursive: true, force: true });
    });

    it("records the synthetic library and replays it with 0 misses, every E6 check passing", () => {
      expect(passes.map((pass) => pass.mode)).toEqual(["record", "replay"]);
      for (const pass of passes) {
        expect(
          pass.report.checks.filter((check) => !check.passed),
          pass.markdown
        ).toEqual([]);
        expect(pass.report.passed).toBe(true);
      }
      const [record, replay] = passes.map((pass) => pass.report.reported.cassette);
      expect(record!.recorded).toBeGreaterThan(0);
      expect(replay).toMatchObject({
        mode: "replay",
        recorded: 0,
        misses: 0,
        served: record!.recorded
      });
    });

    it("switches the catalog-header refresh off, says so, and a replay sees no refresh job (T53h)", async () => {
      for (const pass of passes)
        expect(pass.catalogHeaders, pass.mode).toEqual({
          refresh: "off",
          reason: "topics_e2e",
          jobs: 0
        });
      const report = JSON.parse(
        await readFile(join(workDir, "report", "record", "report.json"), "utf8")
      ) as { catalogHeaders: unknown };
      expect(report.catalogHeaders).toEqual({ refresh: "off", reason: "topics_e2e", jobs: 0 });
      // The runner lets go of the refresh when it ends: the process is as it was.
      expect(catalogHeaderRefreshEnabled({})).toBe(true);
    });

    it("runs on a fresh database with its own scratch workspace, removed afterwards", async () => {
      expect(passes.every((pass) => !pass.kept)).toBe(true);
      for (const pass of passes) expect(existsSync(pass.workDir)).toBe(false);
      const scratch = join(workDir, "scratch");
      expect(existsSync(scratch) ? await readdir(scratch) : []).toEqual([]);
    });

    it("configures the profiles through Settings handlers and then makes 0 Settings calls", () => {
      for (const pass of passes) {
        const { ipc } = pass.report.reported;
        expect(ipc.registered.settings).toBeGreaterThan(40);
        const setup = ipc.phases.setup!.map((entry) => entry.channel).sort();
        expect(setup).toEqual([
          "app:ai:profiles:create",
          "app:ai:profiles:update",
          "app:ai:providers:save",
          "app:local-models:list"
        ]);
        expect(ipc.phases.user!.every((entry) => entry.class === "product")).toBe(true);
        expect(pass.report.reported.routes).toMatchObject({
          embedding: "Embedding",
          summarization: "Writer",
          "class:write-fast": "Writer"
        });
        expect(pass.report.reported.routes["class:decide"]).toBeUndefined();
      }
    });

    it("names the topics with the LLM in the content language and places every note", () => {
      for (const pass of passes) {
        expect(pass.report.contentLanguage).toBe("pt-BR");
        expect(pass.store.currentNotes).toBe(36);
        expect(pass.store.notesWithPrimary).toBe(36);
        expect(pass.store.topics).toHaveLength(3);
        for (const topic of pass.store.topics) {
          expect(topic).toMatchObject({ nameSource: "llm", nameLanguage: "pt-BR", notes: 12 });
          expect(topic.title).toMatch(/ e /);
        }
        expect(pass.store.e1).toMatchObject({ reachability: 1, hardViolations: 0 });
        expect(pass.store.e1!.orphans.total).toBe(0);
        expect(pass.report.reported.importToNamedMs).toBeGreaterThan(0);
      }
    });

    it("serves the replay from the cassette alone: the audit shows no live call", () => {
      const replay = passes[1]!;
      const adapters = new Set(replay.store.aiCalls.map((call) => call.adapter));
      expect(adapters).toEqual(new Set(["cassette-replay"]));
    });

    it("keeps the route next to the cassette without credentials, paths or the key", async () => {
      const text = await readFile(join(workDir, "cassette", "e2e-route.json"), "utf8");
      expect(JSON.parse(text)).toMatchObject({
        format: "memora-topics-e2e-route",
        contentLanguage: "pt-BR",
        source: "synthetic",
        writer: { kind: "remote", provider: "openai-compatible", modelId: "synthetic-writer" },
        result: { notes: 36, topics: 3 }
      });
      expect(text).not.toContain("synthetic-key");
      expect(text).not.toContain(workDir);
    });

    it("fails a replay whose cassette lacks calls, reports the miss and stops early", async () => {
      const damaged = join(workDir, "damaged");
      await cp(join(workDir, "cassette"), damaged, { recursive: true });
      // Keep the manifest and the route, drop every recorded answer.
      await rm(join(damaged, "entries"), { recursive: true, force: true });
      const [replay] = await runTopicsE2e(
        { ...config, mode: "replay", synthetic: true, cassetteDir: damaged, keep: false },
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
      await rm(replay!.workDir, { recursive: true, force: true });
    }, 240_000);
  }
);
