import { operationRouteKey, workloadClassRouteKey } from "@app/db";
import { generativeDecideOperations } from "@app/domain";
import { describe, expect, it } from "vitest";

import type { E6Topic, StoreFacts } from "../topics-e2e/facts.js";
import { evaluateFirstRun, formatDuration, renderFirstRunMarkdown } from "./assertions.js";
import type { ClockFacts, FirstRunCheck, FirstRunFacts } from "./assertions.js";
import { firstRunModels } from "./config.js";
import type { ModelFacts } from "./facts.js";
import { invokedSetupChannels } from "./sequence.js";

const topic = (overrides: Partial<E6Topic> = {}): E6Topic => ({
  id: "t1",
  parentId: "root",
  title: "Esquecimento e memória",
  nameState: "named",
  nameSource: "llm",
  nameLanguage: "pt-BR",
  notes: 21,
  ...overrides
});

function store(overrides: Partial<StoreFacts> = {}): StoreFacts {
  return {
    activeTree: { id: "tree-1", generation: "4" },
    currentNotes: 63,
    notesWithPrimary: 63,
    notesWithoutPrimary: [],
    topics: [
      topic(),
      topic({ id: "t2", title: "Sono", notes: 20 }),
      topic({ id: "t3", title: "Teste", notes: 22 })
    ],
    root: { directNotes: 0, needsGate: 0, needsVector: 0, fallbackNone: 0 },
    fallback: { notes: 0, waitingNotes: 0, decisions: 0 },
    e1: {
      items: 64,
      reachable: 64,
      reachability: 1,
      orphans: { topics: 0, retiredPlacements: 0, unplaced: 0, total: 0 },
      hardViolations: 0,
      hardReasons: [],
      softViolations: {},
      unsortedShare: 0.0156,
      needsVectorItems: 0
    },
    lastNamedAt: new Date("2026-10-24T12:04:30Z"),
    ingestionRuns: [{ status: "succeeded", count: 2 }],
    failedStages: 0,
    failedJobs: [],
    matching: { runs: 2, matchedRuns: 2, graphFailedRuns: 0, graphFailedMatchedRuns: 0 },
    endState: { noteRelations: 9, sourceRelations: 1, digest: "ab".repeat(32) },
    aiCalls: [
      { taskType: "embedding", adapter: "cassette-replay", status: "succeeded", count: 80 }
    ],
    ...overrides
  };
}

const model = (catalogId: string, overrides: Partial<ModelFacts> = {}): ModelFacts => ({
  catalogId,
  runtime: "gguf",
  status: "ready",
  installed: true,
  installedSizeBytes: 1,
  validated: false,
  lastError: null,
  ...overrides
});

const routes = (): Record<string, "writer" | "embedder" | "ranker"> => ({
  embedding: "embedder",
  [workloadClassRouteKey("embed")]: "embedder",
  [workloadClassRouteKey("decide")]: "ranker",
  [workloadClassRouteKey("write-fast")]: "writer",
  [workloadClassRouteKey("write-quality")]: "writer",
  [workloadClassRouteKey("answer")]: "writer",
  "structured-output": "writer",
  summarization: "writer",
  ...Object.fromEntries(generativeDecideOperations.map((op) => [operationRouteKey(op), "writer"]))
});

const clock = (overrides: Partial<ClockFacts> = {}): ClockFacts => ({
  t0: "2026-10-24T12:00:00.000Z",
  appLaunchMs: 9_000,
  marks: { "launch.services": 9_000, t1: 400_000, drained: 420_000 },
  t1Ms: 400_000,
  drainedMs: 420_000,
  download: {
    source: "the recording",
    criticalPathMs: 120_000,
    setupMs: null,
    userMs: null,
    windowMs: 240_000
  },
  installs: [
    {
      catalogId: firstRunModels.embedding,
      requestedAtMs: 10_000,
      readyAtMs: 14_000,
      bytes: 639_150_592
    },
    {
      catalogId: firstRunModels.rankerMlx,
      requestedAtMs: 20_000,
      readyAtMs: 31_000,
      bytes: 1_203_021_367
    }
  ],
  ...overrides
});

function run(overrides: Partial<FirstRunFacts> = {}): FirstRunFacts {
  return {
    mode: "replay",
    synthetic: false,
    sources: { first: "plos-one-murre-dros-2015", second: "wikibooks-en-memory-and-language" },
    contentLanguage: "pt-BR",
    writerKind: "codex",
    ipc: {
      registered: { settings: 67, product: 58 },
      phases: {
        setup: [{ channel: "app:ai:profiles:create", class: "settings", calls: 1 }],
        user: [
          { channel: "app:ingestion:import-file", class: "product", calls: 2 },
          { channel: "app:topics:status", class: "product", calls: 1 }
        ]
      }
    },
    settingsCalls: { setup: 12, user: 0 },
    setupChannels: invokedSetupChannels("codex"),
    expectedSetupChannels: invokedSetupChannels("codex"),
    cassette: {
      mode: "replay",
      served: 900,
      recorded: 0,
      misses: 0,
      liveTokens: 0,
      timing: "recorded",
      waitedMs: 300_000,
      byTask: {},
      missDetails: [],
      maxLiveTokens: null
    },
    setup: {
      onboarding: { show: true, libraryEmpty: true },
      card: { recommended: "hybrid", localAvailable: true },
      writer: {} as never,
      preset: { applied: true, blocked: [] },
      tests: ["embed", "write-fast", "write-quality", "answer", "judge"].map((route) => ({
        route,
        state: "passed" as const,
        ms: 1200,
        error: null
      }))
    },
    hybrid: { preset: "hybrid", routes: routes() },
    models: {
      embedding: model(firstRunModels.embedding),
      ranker: model(firstRunModels.rankerMlx, { runtime: "mlx", validated: true })
    },
    modelSource: "seed",
    firstRunRanker: {
      catalogId: firstRunModels.rankerMlx,
      state: "ready",
      reason: null,
      at: "2026-10-24T12:00:31Z"
    },
    downloadEvents: {
      [firstRunModels.embedding]: { delivered: 3, last: "ready" },
      [firstRunModels.rankerMlx]: { delivered: 4, last: "ready" }
    },
    clock: clock(),
    connection: {
      noteId: "n1",
      noteTitle: "Curva de esquecimento",
      topicId: "t1",
      topicTitle: "Esquecimento e memória",
      relationId: "r1",
      relationState: "suggested",
      otherNoteId: "n2",
      crossSource: true
    },
    relations: { shown: 5, betweenSources: 3, byState: { applied: 2, suggested: 3 } },
    sourceFacts: [
      {
        rootId: "s1",
        title: "Replication and Analysis of Ebbinghaus' Forgetting Curve",
        notes: 40
      },
      { rootId: "s2", title: "Memory and Language", notes: 23 }
    ],
    blockedJobs: {},
    statusAtStalls: null,
    stoodIn: [],
    stoppedBy: null,
    errors: [],
    engine: {
      phase: "active",
      blocked: null,
      counts: { items: 64, placed: 64, pending: 0, needsGate: 0 }
    } as never,
    recorded: {
      format: "memora-firstrun-e2e-record",
      version: 1,
      recordedAt: "2026-10-24T12:00:00.000Z",
      synthetic: false,
      contentLanguage: "pt-BR",
      sources: { first: "a", second: "b" },
      writer: { kind: "codex", modelId: "m" },
      models: {
        embedding: { catalogId: firstRunModels.embedding, runtime: "gguf", bytes: 1, installMs: 1 },
        ranker: { catalogId: firstRunModels.rankerMlx, runtime: "mlx", bytes: 1, installMs: 1 }
      },
      result: { notes: 63, topics: 3, noteRelations: 9, digest: "ab".repeat(32) },
      timing: {
        t1MinusT0Ms: 1,
        appLaunchMs: 1,
        downloadCriticalPathMs: 120_000,
        downloadWindowMs: 240_000,
        live: true
      }
    },
    budgetMs: 600_000,
    ...overrides
  };
}

const failing = (checks: FirstRunCheck[]) =>
  checks.filter((check) => !check.passed).map((c) => c.id);

describe("the first-run verdict", () => {
  it("passes a Hybrid first run that reached T1 in time, with every model seeded and routed", () => {
    const report = evaluateFirstRun(store(), run());
    expect(failing(report.checks)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      "settings",
      "sequence",
      "setup",
      "hybrid",
      "models",
      "ranker",
      "events",
      "tree",
      "placement",
      "topics",
      "names",
      "unnamed",
      "e1",
      "waiting",
      "t1",
      "cassette",
      "replay",
      "lane",
      "gate"
    ]);
    expect(report.reported).toMatchObject({
      notes: 63,
      t1MinusT0Ms: 400_000,
      withDownloadMs: 520_000,
      budgetMs: 600_000
    });
  });

  it("gates a replay on T1 - T0 plus the recording's D, and says the margin", () => {
    const tooSlow = evaluateFirstRun(store(), run({ clock: clock({ t1Ms: 500_000 }) }));
    expect(failing(tooSlow.checks)).toEqual(["gate"]);
    const gate = tooSlow.checks.find((check) => check.id === "gate")!;
    expect(gate.detail).toContain("8:20");
    expect(gate.detail).toContain("2:00");
    expect(gate.detail).toContain("10:20");
    // Exactly on the bar passes.
    expect(
      failing(evaluateFirstRun(store(), run({ clock: clock({ t1Ms: 480_000 }) })).checks)
    ).toEqual([]);
  });

  it("does not gate a recording: it reports T1 - T0 and D, which the replays add", () => {
    const record = evaluateFirstRun(
      store(),
      run({
        mode: "record",
        modelSource: "download",
        recorded: null,
        cassette: {
          mode: "record",
          served: 0,
          recorded: 410,
          misses: 0,
          liveTokens: 91_000,
          byTask: {},
          missDetails: [],
          maxLiveTokens: 150_000
        },
        clock: clock({
          download: {
            source: "this run",
            criticalPathMs: 95_000,
            setupMs: 70_000,
            userMs: 25_000,
            windowMs: 200_000
          }
        })
      })
    );
    expect(failing(record.checks)).toEqual([]);
    expect(record.checks.map((check) => check.id)).not.toContain("gate");
    expect(record.checks.map((check) => check.id)).not.toContain("replay");
    expect(record.reported.withDownloadMs).toBe(495_000);
  });

  it("refuses a replay that ran without recorded timing, because its clock is not E6's", () => {
    const { mode, served, recorded, misses, liveTokens, byTask, missDetails, maxLiveTokens } =
      run().cassette;
    const report = evaluateFirstRun(
      store(),
      run({
        cassette: { mode, served, recorded, misses, liveTokens, byTask, missDetails, maxLiveTokens }
      })
    );
    expect(failing(report.checks)).toEqual(["gate"]);
    expect(report.checks.find((check) => check.id === "gate")!.detail).toContain("recorded timing");
  });

  it("checks that the status said why while the run waited for a download, when a status is wired", () => {
    const said = evaluateFirstRun(
      store(),
      run({
        statusAtStalls: {
          stalls: 14,
          unexplained: 0,
          quiet: 2,
          classes: { download: 9, no_model: 3, idle: 2 }
        }
      })
    );
    expect(failing(said.checks)).toEqual([]);
    expect(said.checks.map((check) => check.id)).toContain("status");
    expect(said.checks.find((check) => check.id === "status")!.detail).toContain("download 9");
    // An idle sentence while no Gardener task waits is the product's right answer (T86).
    expect(said.checks.find((check) => check.id === "status")!.detail).toContain(
      "2 with no Gardener task waiting"
    );
    const silent = evaluateFirstRun(
      store(),
      run({
        statusAtStalls: { stalls: 12, unexplained: 2, quiet: 0, classes: { download: 10, idle: 2 } }
      })
    );
    expect(failing(silent.checks)).toEqual(["status"]);
    expect(silent.checks.find((check) => check.id === "status")!.detail).toContain(
      "2 said nothing was wrong"
    );
    // A replay that never waited has nothing to explain.
    expect(
      failing(
        evaluateFirstRun(
          store(),
          run({ statusAtStalls: { stalls: 0, unexplained: 0, quiet: 0, classes: {} } })
        ).checks
      )
    ).toEqual([]);
    // Without a status the check is not made.
    expect(evaluateFirstRun(store(), run()).checks.map((check) => check.id)).not.toContain(
      "status"
    );
  });

  it("refuses the D of a recording that was resumed from an earlier take: its clock is not live", () => {
    const resumed = run().recorded!;
    const report = evaluateFirstRun(
      store(),
      run({ recorded: { ...resumed, timing: { ...resumed.timing, live: false } } })
    );
    expect(failing(report.checks)).toEqual(["gate"]);
    expect(report.checks.find((check) => check.id === "gate")!.detail).toContain(
      "not a live figure"
    );
  });

  it("fails when T1 was never reached, and says what was found instead", () => {
    const report = evaluateFirstRun(
      store(),
      run({
        connection: null,
        clock: clock({ t1Ms: null }),
        relations: { shown: 0, betweenSources: 0, byState: {} }
      })
    );
    expect(failing(report.checks)).toEqual(["t1", "gate"]);
    expect(report.checks.find((check) => check.id === "t1")!.detail).toContain("0 relations shown");
    expect(report.reported.withDownloadMs).toBeNull();
  });

  it("fails when the setup deviates from the onboarding sequence, with the first difference", () => {
    const channels = [...invokedSetupChannels("codex")];
    [channels[3], channels[4]] = [channels[4]!, channels[3]!];
    const report = evaluateFirstRun(store(), run({ setupChannels: channels }));
    expect(failing(report.checks)).toEqual(["sequence"]);
    expect(report.checks.find((check) => check.id === "sequence")!.detail).toContain(
      "difference at 4"
    );
    expect(
      failing(evaluateFirstRun(store(), run({ setupChannels: channels.slice(0, 5) })).checks)
    ).toEqual(["sequence"]);
  });

  it("fails when a Settings handler ran after the setup, and says which", () => {
    const report = evaluateFirstRun(
      store(),
      run({
        settingsCalls: { setup: 12, user: 1 },
        ipc: {
          registered: { settings: 67, product: 58 },
          phases: {
            user: [
              { channel: "app:ai:class-routes:test", class: "settings", calls: 1 },
              { channel: "app:topics:status", class: "product", calls: 1 }
            ]
          }
        }
      })
    );
    expect(failing(report.checks)).toEqual(["settings"]);
    expect(report.checks[0]!.detail).toContain("app:ai:class-routes:test x1");
  });

  it("fails a class test that did not pass, a blocked preset, or a setup that did not complete", () => {
    const base = run().setup!;
    const failed = evaluateFirstRun(
      store(),
      run({
        setup: {
          ...base,
          tests: base.tests.map((test) =>
            test.route === "judge"
              ? {
                  ...test,
                  state: "failed" as const,
                  error: "settings.ai.classes.errors.invalidOutput"
                }
              : test
          )
        }
      })
    );
    expect(failing(failed.checks)).toEqual(["setup"]);
    expect(failed.checks.find((check) => check.id === "setup")!.detail).toContain("judge failed");
    const blocked = evaluateFirstRun(
      store(),
      run({
        setup: {
          ...base,
          preset: {
            applied: false,
            blocked: [{ route: "embed", reason: "model_missing", catalogId: "x", modelName: "X" }]
          }
        }
      })
    );
    expect(failing(blocked.checks)).toEqual(["setup"]);
    expect(failing(evaluateFirstRun(store(), run({ setup: null })).checks)).toContain("setup");
  });

  it("fails when the routes are not Hybrid: a ranker that is not routed, a remote embedder, another preset", () => {
    const withoutDecide = routes() as Record<string, string>;
    delete withoutDecide[workloadClassRouteKey("decide")];
    const missing = evaluateFirstRun(
      store(),
      run({ hybrid: { preset: "hybrid", routes: withoutDecide as never } })
    );
    expect(failing(missing.checks)).toEqual(["hybrid"]);
    expect(missing.checks.find((check) => check.id === "hybrid")!.detail).toContain(
      "class:decide routes to nothing"
    );
    const remoteEmbedder = evaluateFirstRun(
      store(),
      run({ hybrid: { preset: "hybrid", routes: { ...routes(), embedding: "writer" } } })
    );
    expect(failing(remoteEmbedder.checks)).toEqual(["hybrid"]);
    expect(
      failing(
        evaluateFirstRun(store(), run({ hybrid: { preset: "cloud", routes: routes() } })).checks
      )
    ).toEqual(["hybrid"]);
    expect(
      failing(
        evaluateFirstRun(
          store(),
          run({ hybrid: { preset: "hybrid", routes: { ...routes(), "op:x": "other" } } })
        ).checks
      )
    ).toEqual(["hybrid"]);
  });

  it("fails when a model is not installed, the ranker is not validated, or the first-run ranker did not finish", () => {
    const notInstalled = evaluateFirstRun(
      store(),
      run({
        models: {
          ...run().models,
          embedding: model(firstRunModels.embedding, {
            installed: false,
            status: "failed",
            lastError: "errors.localModels.checksumMismatch"
          })
        }
      })
    );
    expect(failing(notInstalled.checks)).toEqual(["models"]);
    expect(notInstalled.checks.find((check) => check.id === "models")!.detail).toContain(
      "checksumMismatch"
    );
    const unvalidated = evaluateFirstRun(
      store(),
      run({
        models: { ...run().models, ranker: model(firstRunModels.rankerMlx, { validated: false }) }
      })
    );
    expect(failing(unvalidated.checks)).toEqual(["models"]);
    const unfinished = evaluateFirstRun(
      store(),
      run({
        firstRunRanker: {
          catalogId: firstRunModels.rankerMlx,
          state: "failed",
          reason: "errors.localModels.rankerSmokeFailed",
          at: "x"
        }
      })
    );
    expect(failing(unfinished.checks)).toEqual(["ranker"]);
    expect(failing(evaluateFirstRun(store(), run({ firstRunRanker: null })).checks)).toEqual([
      "ranker"
    ]);
  });

  it("fails when the event bus did not deliver an install to its end", () => {
    const report = evaluateFirstRun(
      store(),
      run({ downloadEvents: { [firstRunModels.embedding]: { delivered: 3, last: "ready" } } })
    );
    expect(failing(report.checks)).toEqual(["events"]);
  });

  it("fails a note that waits for the gate even though a ranker exists", () => {
    const report = evaluateFirstRun(
      store({ fallback: { notes: 2, waitingNotes: 1, decisions: 2 } }),
      run()
    );
    expect(failing(report.checks)).toEqual(["waiting"]);
  });

  it("keeps the topic checks of the zero-config test: names, placement, reachability", () => {
    const report = evaluateFirstRun(
      store({
        topics: [
          topic({ nameSource: "fallback" }),
          topic({ id: "t2", nameLanguage: "en" }),
          topic({ id: "t3", nameState: "unnamed", title: null })
        ],
        notesWithPrimary: 60,
        notesWithoutPrimary: ["n7"],
        e1: {
          ...store().e1!,
          reachability: 0.9,
          orphans: { topics: 0, retiredPlacements: 0, unplaced: 2, total: 2 }
        }
      }),
      run()
    );
    expect(failing(report.checks)).toEqual(["placement", "names", "unnamed", "e1"]);
  });

  it("fails a replay with misses, a different library than the recording, or a stopped lane", () => {
    const misses = evaluateFirstRun(
      store(),
      run({
        cassette: {
          ...run().cassette,
          misses: 3,
          missDetails: [
            { key: "k".repeat(64), taskType: "reranking", occurrence: 0, requestPath: "/m.json" }
          ]
        }
      })
    );
    expect(failing(misses.checks)).toEqual(["cassette"]);
    expect(misses.checks.find((check) => check.id === "cassette")!.detail).toContain("3 misses");
    const different = evaluateFirstRun(
      store({ endState: { noteRelations: 8, sourceRelations: 1, digest: "cd".repeat(32) } }),
      run()
    );
    expect(failing(different.checks)).toEqual(["replay"]);
    expect(different.checks.find((check) => check.id === "replay")!.detail).toContain(
      "digests differ"
    );
    const stopped = evaluateFirstRun(
      store(),
      run({ stoppedBy: "drain_timeout", errors: ["took too long"] })
    );
    expect(failing(stopped.checks)).toEqual(["lane"]);
    const failedTopicJob = evaluateFirstRun(
      store({ failedJobs: [{ type: "topic-name", count: 2 }] }),
      run()
    );
    expect(failing(failedTopicJob.checks)).toEqual(["lane"]);
  });

  it("reports failed ingestion work outside the topics without failing the run", () => {
    const report = evaluateFirstRun(
      store({ failedJobs: [{ type: "knowledge-graph-generation", count: 1 }], failedStages: 1 }),
      run()
    );
    expect(report.passed).toBe(true);
    expect(report.reported.failedWork).toEqual([
      "1 failed stages",
      "1 failed knowledge-graph-generation jobs"
    ]);
  });
});

describe("the first-run report", () => {
  it("renders the clock, the models, the library and the calls, and names a self-test", () => {
    const facts = run({ synthetic: true, stoodIn: ["the library is seeded, not imported"] });
    const report = evaluateFirstRun(store(), facts);
    const markdown = renderFirstRunMarkdown(report, store());
    expect(markdown).toContain("# First-run Hybrid end-to-end test (E6): PASSED");
    expect(markdown).toContain("(synthetic self-test)");
    expect(markdown).toContain("T1 - T0 + D = 8:40 against 10:00.");
    expect(markdown).toContain(
      "D, the download term of the live record: 2:00 on the critical path"
    );
    expect(markdown).toContain("| launch.services | 0:09 |");
    expect(markdown).toContain("Stood in by the self-test: the library is seeded, not imported.");
    expect(markdown).toContain("| Esquecimento e memória | llm | pt-BR | 21 |");
    expect(markdown).toContain("Handlers wrapped: 67 Settings, 58 product.");
  });

  it("marks a failed run and lists its errors", () => {
    const report = evaluateFirstRun(
      store(),
      run({ stoppedBy: "model_failed", errors: ["could not be installed"] })
    );
    const markdown = renderFirstRunMarkdown(report, store());
    expect(markdown).toContain("FAILED");
    expect(markdown).toContain("| FAIL |");
    expect(markdown).toContain("- could not be installed");
  });

  it("formats durations as m:ss", () => {
    expect(formatDuration(null)).toBe("n/a");
    expect(formatDuration(65_400)).toBe("1:05");
    expect(formatDuration(600_000)).toBe("10:00");
  });
});
