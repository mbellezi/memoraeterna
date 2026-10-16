import { describe, expect, it } from "vitest";

import { evaluateE6, formatDuration, renderE6Markdown } from "./assertions.js";
import type { E6Check, RunFacts } from "./assertions.js";
import type { E6Topic, StoreFacts } from "./facts.js";

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
    root: { directNotes: 0, needsGate: 0, needsVector: 0 },
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
    lastNamedAt: new Date("2026-10-16T12:04:30Z"),
    legacyRows: 0,
    ingestionRuns: [{ status: "succeeded", count: 9 }],
    failedStages: 0,
    failedJobs: [],
    aiCalls: [
      { taskType: "embedding", adapter: "cassette-replay", status: "succeeded", count: 80 }
    ],
    ...overrides
  };
}

function run(overrides: Partial<RunFacts> = {}): RunFacts {
  return {
    mode: "replay",
    source: "plos-one-murre-dros-2015",
    contentLanguage: "pt-BR",
    ipc: {
      registered: { settings: 57, product: 56 },
      phases: {
        setup: [{ channel: "app:ai:profiles:create", class: "settings", calls: 2 }],
        user: [
          { channel: "app:ingestion:import-file", class: "product", calls: 1 },
          { channel: "app:topics:status", class: "product", calls: 1 }
        ]
      }
    },
    settingsCalls: { setup: 6, user: 0 },
    cassette: {
      mode: "replay",
      served: 412,
      recorded: 0,
      misses: 0,
      liveTokens: 0,
      byTask: {},
      missDetails: [],
      maxLiveTokens: null
    },
    routes: { embedding: "Embedding", summarization: "Writer" },
    timing: {
      importStartedAt: new Date("2026-10-16T12:00:00Z"),
      heavyDoneAt: new Date("2026-10-16T12:03:00Z"),
      drainedAt: new Date("2026-10-16T12:05:00Z")
    },
    stoppedBy: null,
    errors: [],
    engine: {
      phase: "active",
      blocked: "no_decider",
      counts: { items: 64, placed: 64, pending: 0, needsGate: 0 }
    },
    recorded: { notes: 63, topics: 3 },
    ...overrides
  };
}

const failing = (checks: E6Check[]) => checks.filter((check) => !check.passed).map((c) => c.id);

describe("the E6 verdict", () => {
  it("passes a library with named topics, 0 Settings calls and a replay with 0 misses", () => {
    const report = evaluateE6(store(), run());
    expect(failing(report.checks)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      "settings",
      "tree",
      "placement",
      "topics",
      "names",
      "unnamed",
      "e1",
      "cassette",
      "replay",
      "lane"
    ]);
    expect(report.reported).toMatchObject({
      notes: 63,
      nonRootTopics: 3,
      topicsWithNotes: 3,
      importToNamedMs: 270_000,
      importToHeavyDoneMs: 180_000,
      importToDrainedMs: 300_000
    });
  });

  it("fails when a Settings handler ran after the setup, and says which", () => {
    const report = evaluateE6(
      store(),
      run({
        settingsCalls: { setup: 6, user: 1 },
        ipc: {
          registered: { settings: 57, product: 56 },
          phases: {
            user: [
              { channel: "app:settings:app:get", class: "settings", calls: 1 },
              { channel: "app:topics:status", class: "product", calls: 1 }
            ]
          }
        }
      })
    );
    expect(failing(report.checks)).toEqual(["settings"]);
    expect(report.checks[0]!.detail).toContain("app:settings:app:get x1");
  });

  it("does not take 0 Settings calls on faith: the counters must be wrapped and alive", () => {
    const silent = evaluateE6(
      store(),
      run({ ipc: { registered: { settings: 57, product: 56 }, phases: { user: [] } } })
    );
    expect(failing(silent.checks)).toEqual(["settings"]);
    const unwrapped = evaluateE6(
      store(),
      run({ ipc: { registered: { settings: 0, product: 56 }, phases: run().ipc.phases } })
    );
    expect(failing(unwrapped.checks)).toEqual(["settings"]);
  });

  it("fails a note without a primary placement", () => {
    const report = evaluateE6(store({ notesWithPrimary: 62, notesWithoutPrimary: ["n-9"] }), run());
    expect(failing(report.checks)).toEqual(["placement"]);
    expect(report.checks.find((check) => check.id === "placement")!.detail).toContain("n-9");
    expect(
      failing(evaluateE6(store({ currentNotes: 0, notesWithPrimary: 0 }), run()).checks)
    ).toContain("placement");
  });

  it("needs at least two non-root topics that hold notes", () => {
    const one = evaluateE6(store({ topics: [topic({ notes: 63 })] }), run({ recorded: null }));
    expect(failing(one.checks)).toEqual(["topics"]);
    const emptyTopic = evaluateE6(
      store({ topics: [topic({ notes: 63 }), topic({ id: "t2", title: "Vazio", notes: 0 })] }),
      run({ recorded: null })
    );
    expect(failing(emptyTopic.checks)).toEqual(["topics"]);
  });

  it("wants an LLM name in the content language on every topic that holds notes", () => {
    const tfidf = evaluateE6(
      store({
        topics: [
          topic(),
          topic({ id: "t2", title: "sono, memória", nameSource: "tfidf", nameState: "provisional" })
        ]
      }),
      run({ recorded: null })
    );
    expect(failing(tfidf.checks)).toEqual(["names"]);
    expect(tfidf.checks.find((check) => check.id === "names")!.detail).toContain("tfidf, not llm");
    const english = evaluateE6(
      store({ topics: [topic(), topic({ id: "t2", title: "Sleep", nameLanguage: "en" })] }),
      run({ recorded: null })
    );
    expect(failing(english.checks)).toEqual(["names"]);
    expect(english.checks.find((check) => check.id === "names")!.detail).toContain("in en");
  });

  it("fails an unnamed non-root topic, even one without notes", () => {
    const report = evaluateE6(
      store({
        topics: [
          ...store().topics,
          topic({
            id: "t4",
            title: null,
            nameState: "unnamed",
            nameSource: null,
            nameLanguage: null,
            notes: 0
          })
        ]
      }),
      run({ recorded: { notes: 63, topics: 4 } })
    );
    expect(failing(report.checks)).toEqual(["unnamed"]);
  });

  it("holds E1: reachability 100%, 0 orphans, 0 hard violations", () => {
    const base = store().e1!;
    expect(
      failing(
        evaluateE6(store({ e1: { ...base, reachability: 0.98, reachable: 63 } }), run()).checks
      )
    ).toEqual(["e1"]);
    expect(
      failing(
        evaluateE6(
          store({ e1: { ...base, orphans: { ...base.orphans, topics: 1, total: 1 } } }),
          run()
        ).checks
      )
    ).toEqual(["e1"]);
    expect(
      failing(
        evaluateE6(
          store({
            e1: { ...base, hardViolations: 1, hardReasons: ["I7 duplicate-sibling-title t1"] }
          }),
          run()
        ).checks
      )
    ).toEqual(["e1"]);
    expect(failing(evaluateE6(store({ e1: null }), run()).checks)).toContain("e1");
  });

  it("requires a tree without legacy content", () => {
    expect(failing(evaluateE6(store({ activeTree: null }), run()).checks)).toContain("tree");
    expect(failing(evaluateE6(store({ legacyRows: 1 }), run()).checks)).toEqual(["tree"]);
  });

  it("makes a replay fail on one miss, and on a replay that served nothing", () => {
    const missed = evaluateE6(
      store(),
      run({
        cassette: {
          ...run().cassette,
          misses: 1,
          missDetails: [
            { key: "a".repeat(64), taskType: "summarization", occurrence: 0, requestPath: "/x" }
          ]
        }
      })
    );
    expect(failing(missed.checks)).toEqual(["cassette"]);
    expect(missed.checks.find((check) => check.id === "cassette")!.detail).toContain(
      "summarization aaaaaaaaaaaa"
    );
    expect(
      failing(evaluateE6(store(), run({ cassette: { ...run().cassette, served: 0 } })).checks)
    ).toEqual(["cassette"]);
  });

  it("makes a replay reproduce the recording", () => {
    const report = evaluateE6(store(), run({ recorded: { notes: 61, topics: 3 } }));
    expect(failing(report.checks)).toEqual(["replay"]);
    expect(
      failing(evaluateE6(store(), run({ recorded: { notes: 63, topics: 5 } })).checks)
    ).toEqual(["replay"]);
    // A recording has nothing to reproduce.
    const recording = evaluateE6(
      store(),
      run({
        mode: "record",
        recorded: null,
        cassette: { ...run().cassette, mode: "record", served: 0, recorded: 412 }
      })
    );
    expect(recording.checks.some((check) => check.id === "replay")).toBe(false);
    expect(recording.passed).toBe(true);
  });

  it("fails a recording that made no call", () => {
    const report = evaluateE6(
      store(),
      run({
        mode: "record",
        recorded: null,
        cassette: { ...run().cassette, mode: "record", served: 0, recorded: 0 }
      })
    );
    expect(failing(report.checks)).toEqual(["cassette"]);
  });

  it("fails when the light lane timed out, the run stopped, work failed or something threw", () => {
    expect(failing(evaluateE6(store(), run({ stoppedBy: "drain_timeout" })).checks)).toEqual([
      "lane"
    ]);
    expect(failing(evaluateE6(store(), run({ errors: ["boom"] })).checks)).toEqual(["lane"]);
    expect(
      failing(evaluateE6(store({ ingestionRuns: [{ status: "failed", count: 1 }] }), run()).checks)
    ).toEqual(["lane"]);
    expect(failing(evaluateE6(store({ failedStages: 2 }), run()).checks)).toEqual(["lane"]);
    expect(
      failing(evaluateE6(store({ failedJobs: [{ type: "topic-name", count: 1 }] }), run()).checks)
    ).toEqual(["lane"]);
  });

  it("reports the share of notes left at the root and the time to named topics", () => {
    const report = evaluateE6(
      store({ root: { directNotes: 9, needsGate: 7, needsVector: 0 } }),
      run()
    );
    expect(report.reported).toMatchObject({ rootDirectNotes: 9, rootNeedsGate: 7 });
    const markdown = renderE6Markdown(
      report,
      store({ root: { directNotes: 9, needsGate: 7, needsVector: 0 } })
    );
    expect(markdown).toContain("# Zero-config end-to-end test (E6): PASSED");
    expect(markdown).toContain("9 (7 waiting for the gate), 14.3% of the notes");
    expect(markdown).toContain("Import start to named topics 4:30");
    expect(markdown).toContain("| Esquecimento e memória | llm | pt-BR | 21 |");
    expect(markdown).toContain("Handlers wrapped: 57 Settings, 56 product.");
    expect(markdown).toContain("Engine status: active (no_decider), 64 of 64 items placed");
  });

  it("does not know the time to named topics when nothing was named", () => {
    const report = evaluateE6(store({ lastNamedAt: null }), run());
    expect(report.reported.importToNamedMs).toBeNull();
    expect(formatDuration(null)).toBe("n/a");
    expect(formatDuration(65_000)).toBe("1:05");
  });
});
