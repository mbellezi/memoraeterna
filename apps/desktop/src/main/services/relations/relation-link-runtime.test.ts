import { afterEach, describe, expect, it, vi } from "vitest";

import { InFlightRegistry } from "./in-flight-registry.js";
import {
  goldenLinkRuntime,
  readGoldenRelationsMode,
  relationLinkRuntime,
  resetRelationLinkRuntime,
  setRelationLinkRuntime
} from "./link-runtime.js";
import { localDay, nextLocalDay } from "./relation-call-budget.js";
import { decidedNotesOf, isInteractiveRun, StoredDecidedNoteSchema } from "./relation-link.js";
import type { DecidedNote } from "./relation-matcher.js";
import { RelationsChangedEmitter } from "./relations-changed.js";

afterEach(() => {
  resetRelationLinkRuntime();
  vi.useRealTimers();
});

describe("the in-flight registry (D24)", () => {
  it("lets one caller work on a key while the other waits, then gives the waiter the key", async () => {
    const registry = new InFlightRegistry();
    const worked: string[][] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = registry.run(["a", "b"], async (claimed) => {
      worked.push(["first", ...claimed]);
      await gate;
      return "first";
    });
    const second = registry.run(["b", "c"], async (claimed) => {
      worked.push(["second", ...claimed]);
      return "second";
    });
    await vi.waitFor(() => expect(worked).toHaveLength(2));
    // The free key is worked on at once; the held one waits for its holder.
    expect(worked).toEqual([
      ["first", "a", "b"],
      ["second", "c"]
    ]);
    open();
    await expect(first).resolves.toEqual(["first"]);
    await expect(second).resolves.toEqual(["second", "second"]);
    expect(worked.at(-1)).toEqual(["second", "b"]);
    expect(registry.size).toBe(0);
  });

  it("frees its keys when the work fails, and a cancelled waiter stops waiting", async () => {
    const registry = new InFlightRegistry();
    await expect(
      registry.run(["a"], async () => {
        throw new Error("typing_failed");
      })
    ).rejects.toThrow("typing_failed");
    expect(registry.size).toBe(0);
    const held = registry.claim(["a"]);
    const controller = new AbortController();
    const waiting = registry.run(["a"], async () => "never", controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeDefined();
    held.release();
    held.release();
    expect(registry.size).toBe(0);
  });
});

describe("the relationsChanged push", () => {
  it("coalesces changed notes over its window into events of at most 200 IDs", () => {
    vi.useFakeTimers();
    const emitter = new RelationsChangedEmitter({ coalesceMs: 250 });
    const events: string[][] = [];
    emitter.subscribe((event) => void events.push(event.noteIds));
    emitter.changed(["b", "a"]);
    emitter.changed(["a", "c"]);
    vi.advanceTimersByTime(249);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([["a", "b", "c"]]);
    emitter.changed(
      Array.from({ length: 450 }, (_, index) => `n${String(index).padStart(3, "0")}`)
    );
    emitter.flush();
    expect(events.slice(1).map((ids) => ids.length)).toEqual([200, 200, 50]);
    emitter.changed([]);
    vi.runAllTimers();
    expect(events).toHaveLength(4);
  });

  it("keeps notifying the other windows when one listener throws", () => {
    const failures: unknown[] = [];
    const emitter = new RelationsChangedEmitter({ onListenerError: (e) => void failures.push(e) });
    const heard: string[][] = [];
    emitter.subscribe(() => {
      throw new Error("window closed");
    });
    emitter.subscribe((event) => void heard.push(event.noteIds));
    emitter.changed(["a"]);
    emitter.flush();
    expect(heard).toEqual([["a"]]);
    expect(failures).toHaveLength(1);
  });
});

describe("the link runtime of golden and re-match runs", () => {
  it("reads MEMORA_GOLDEN_RELATIONS only in a golden run, and never in a packaged build", () => {
    const run = { MEMORA_GOLDEN_RUN: "scripts/fixtures/golden/manifest.json" };
    expect(readGoldenRelationsMode(run, { isPackaged: false })).toBe("live");
    expect(
      readGoldenRelationsMode({ ...run, MEMORA_GOLDEN_RELATIONS: "local" }, { isPackaged: false })
    ).toBe("local");
    expect(() =>
      readGoldenRelationsMode({ ...run, MEMORA_GOLDEN_RELATIONS: "off" }, { isPackaged: false })
    ).toThrow("MEMORA_GOLDEN_RELATIONS");
    expect(
      readGoldenRelationsMode({ MEMORA_GOLDEN_RELATIONS: "local" }, { isPackaged: false })
    ).toBeNull();
    expect(
      readGoldenRelationsMode({ ...run, MEMORA_GOLDEN_RELATIONS: "local" }, { isPackaged: true })
    ).toBeNull();
  });

  it("drains in golden runs, with relation remote calls off under local", () => {
    expect(relationLinkRuntime()).toEqual({ drain: false, remoteCallsOff: false });
    expect(goldenLinkRuntime("live")).toEqual({ drain: true, remoteCallsOff: false });
    setRelationLinkRuntime(goldenLinkRuntime("local"));
    expect(relationLinkRuntime()).toEqual({ drain: true, remoteCallsOff: true });
    resetRelationLinkRuntime();
    expect(relationLinkRuntime()).toEqual({ drain: false, remoteCallsOff: false });
  });
});

describe("what a run hands its link job", () => {
  const note: DecidedNote = {
    noteId: "n1",
    sourceItemId: "s1",
    decider: {
      kind: "generative",
      mode: "ranker-else-generative",
      deciderKey: "key",
      calibration: "uncalibrated",
      profileId: "profile",
      modelId: "writer"
    },
    pairs: [
      {
        noteId: "n1",
        candidateId: "n2",
        candidateSourceItemId: "s2",
        band: "suggest",
        probability: null,
        score: 0.8,
        calibration: "uncalibrated",
        relationType: "contradicts",
        subjectId: "n1",
        decisionSource: "reverse_cache",
        vectorScore: null,
        graphScore: 0.4
      }
    ]
  };

  it("parses the matcher's decided notes from the matching checkpoint and skips a bad entry", () => {
    expect(StoredDecidedNoteSchema.parse(note)).toEqual(note);
    const run = {
      stagesCheckpoint: {
        atomicNoteMatching: { status: "completed", metadata: { decided: [note, { noteId: "x" }] } }
      }
    };
    expect(decidedNotesOf(run)).toEqual([note]);
    expect(decidedNotesOf({ stagesCheckpoint: {} })).toEqual([]);
  });

  it("links an interactive import at P1", () => {
    expect(isInteractiveRun({ trigger: "interactive_import" })).toBe(true);
    expect(isInteractiveRun({ trigger: "library_action" })).toBe(false);
  });

  it("counts calls per local calendar day", () => {
    expect(localDay(new Date(2026, 9, 17, 23, 59))).toBe("2026-10-17");
    expect(localDay(new Date(2026, 9, 18, 0, 0))).toBe("2026-10-18");
    // Discovery deferred at the cap waits for the next day's count (D26).
    expect(nextLocalDay(new Date(2026, 9, 17, 23, 59))).toEqual(new Date(2026, 9, 18));
    expect(nextLocalDay(new Date(2026, 11, 31, 8, 0))).toEqual(new Date(2027, 0, 1));
  });
});
