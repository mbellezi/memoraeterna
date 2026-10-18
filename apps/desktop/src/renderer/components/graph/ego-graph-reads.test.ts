import { describe, expect, it } from "vitest";
import type { ObjectNeighborhood } from "@app/domain";

import {
  initialReadState,
  readKey,
  readReducer,
  shouldRead,
  type ReadEvent,
  type ReadState
} from "./ego-graph-reads";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const answer = (depth: 1 | 2, extra = 0): ObjectNeighborhood => ({
  focus: id(1),
  depth,
  nodes: [
    { id: id(1), kind: "note", title: "Focus", ideaStatement: "Idea.", language: null, depth: 0 },
    ...Array.from({ length: 1 + extra }, (_, n) => ({
      id: id(2 + n),
      kind: "note" as const,
      title: `Note ${n}`,
      ideaStatement: "Idea.",
      language: null,
      depth: 1 as const
    }))
  ],
  edges: [],
  neighbourTotal: 1 + extra,
  truncated: false
});

const run = (events: ReadEvent[], from: ReadState = initialReadState): ReadState =>
  events.reduce(readReducer, from);
const key = (request: number, revision = 0) => readKey(id(1), revision, request);
/** A graph of depth 1 on screen, as after the first read. */
const shown = () =>
  run([{ type: "started" }, { type: "answered", key: key(0), answer: answer(1) }]);

describe("how the relation graph reads its answer", () => {
  it("is loading until the first answer, then draws it", () => {
    expect(run([{ type: "started" }]).load).toEqual({ status: "loading" });
    const state = shown();
    expect(state.load).toEqual({ status: "ready", answer: answer(1) });
    expect(state.reread).toBe("idle");
  });

  it("asks for the other depth, marks the toggle busy while it is read and draws it", () => {
    const asked = run([{ type: "depth", depth: 2 }], shown());
    expect(asked.wanted).toBe(2);
    expect(asked.request).toBe(1);
    const reading = run([{ type: "started" }], asked);
    // The graph on screen stays while the other depth is read.
    expect(reading.load).toEqual({ status: "ready", answer: answer(1) });
    expect(reading.reread).toBe("pending");
    const done = run([{ type: "answered", key: key(1), answer: answer(2) }], reading);
    expect(done.load).toEqual({ status: "ready", answer: answer(2) });
    expect(done).toMatchObject({ reread: "idle", wanted: 2 });
  });

  it("does not mark the toggle busy for a reread of the depth that is drawn", () => {
    expect(run([{ type: "started" }], shown()).reread).toBe("idle");
  });

  it("keeps the graph after a failed depth-2 read, shows the notice and leaves the toggle usable", () => {
    const failed = run(
      [{ type: "depth", depth: 2 }, { type: "started" }, { type: "failed", key: key(1) }],
      shown()
    );
    expect(failed.load).toEqual({ status: "ready", answer: answer(1) });
    expect(failed.reread).toBe("failed");
    // What is asked for is what is drawn, so the toggle (pressed for depth 2 only) and a later push agree.
    expect(failed.wanted).toBe(1);
    expect(failed.failedDepth).toBe(2);
    // Pressing the toggle again asks again: the request grows, so the read really happens.
    const again = run([{ type: "depth", depth: 2 }], failed);
    expect(again.request).toBeGreaterThan(failed.request);
    expect(again.wanted).toBe(2);
    expect(shouldRead(again.failedKey, key(again.request))).toBe(true);
    expect(run([{ type: "started" }], again).reread).toBe("pending");
    // And the notice's Retry asks for the depth that failed, not the one on screen.
    const retried = run([{ type: "retryReread" }], failed);
    expect(retried).toMatchObject({ wanted: 2, request: failed.request + 1 });
  });

  it("does not change the depth on its own when a push reads after a failed depth read", () => {
    const failed = run(
      [{ type: "depth", depth: 2 }, { type: "started" }, { type: "failed", key: key(1) }],
      shown()
    );
    // The page's revision grows: the read that follows asks for what is drawn.
    expect(failed.wanted).toBe(1);
    expect(shouldRead(failed.failedKey, key(failed.request, 1))).toBe(true);
    const push = run(
      [{ type: "started" }, { type: "answered", key: key(1, 1), answer: answer(1) }],
      failed
    );
    expect(push.load).toEqual({ status: "ready", answer: answer(1) });
    expect(push.reread).toBe("idle");
  });

  it("keeps the failure on screen when the page is shown again, and reads again only on a new ask", () => {
    const error = run([{ type: "started" }, { type: "failed", key: key(0) }]);
    expect(error.load).toEqual({ status: "error" });
    // The same read (same note, revision and request) is not repeated by a page shown again.
    expect(shouldRead(error.failedKey, key(0))).toBe(false);
    // Another revision of the page's relations is another read.
    expect(shouldRead(error.failedKey, key(0, 1))).toBe(true);
    // Retry asks again.
    const retried = run([{ type: "retry" }], error);
    expect(retried.load).toEqual({ status: "loading" });
    expect(shouldRead(retried.failedKey, key(retried.request))).toBe(true);
    // The same holds for a reread that failed under a graph that is shown.
    const noticed = run(
      [{ type: "depth", depth: 2 }, { type: "started" }, { type: "failed", key: key(1) }],
      shown()
    );
    expect(shouldRead(noticed.failedKey, key(1))).toBe(false);
  });

  it("treats a missing note as a failure that can be retried", () => {
    const state = run([{ type: "started" }, { type: "answered", key: key(0), answer: null }]);
    expect(state.load).toEqual({ status: "error" });
    expect(shouldRead(state.failedKey, key(0))).toBe(false);
    // A graph that was shown is replaced by the error too: the note is gone.
    expect(
      run([{ type: "started" }, { type: "answered", key: key(1), answer: null }], shown()).load
    ).toEqual({ status: "error" });
  });

  it("keeps the same object for an identical answer, so the graph is not drawn twice", () => {
    const first = shown();
    const again = run(
      [{ type: "started" }, { type: "answered", key: key(0, 1), answer: answer(1) }],
      first
    );
    expect(again.load).toBe(first.load);
    const changed = run(
      [{ type: "started" }, { type: "answered", key: key(0, 1), answer: answer(1, 1) }],
      first
    );
    expect(changed.load).not.toBe(first.load);
  });

  it("clears the notice when the reread that follows succeeds", () => {
    const failed = run(
      [{ type: "depth", depth: 2 }, { type: "started" }, { type: "failed", key: key(1) }],
      shown()
    );
    const healed = run(
      [
        { type: "retryReread" },
        { type: "started" },
        { type: "answered", key: key(2), answer: answer(2) }
      ],
      failed
    );
    expect(healed).toMatchObject({ reread: "idle", wanted: 2 });
    expect(healed.load).toEqual({ status: "ready", answer: answer(2) });
  });
});
