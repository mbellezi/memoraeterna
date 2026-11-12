import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectLocateResult } from "@app/domain";

import type { AppEvent } from "../../../../shared/app-events";
import type { LibrarySourceProgress } from "../../../../shared/ipc-library";
import { createFakeAppEvents } from "../../../lib/fake-app-events";
import {
  SourceController,
  type SourceApi,
  type SourceControllerDeps,
  type SourceSnapshot
} from "./source-controller";
import { doneProgress, noteIds, runningProgress, sourceFixture } from "./source-panel-fixtures";

const now = Date.UTC(2026, 10, 12, 9, 17, 0);
const detail = sourceFixture(now);
const sourceId = detail.id;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const placed = (title: string): ObjectLocateResult => ({
  object: { kind: "note", id: noteIds[0] as string, title: "" },
  primaryPath: [
    { kind: "topic", id: uuid(100), title: "" },
    { kind: "topic", id: uuid(101), title },
    { kind: "note", id: noteIds[0] as string, title: "" }
  ],
  alsoIn: [],
  citedBy: [],
  counts: { alsoIn: 0, citedBy: 0, notes: 0, passages: 0, children: 0 }
});
const unplaced = (): ObjectLocateResult => ({ ...placed(""), primaryPath: [] });

interface Harness {
  controller: SourceController;
  api: {
    getSourceDetail: ReturnType<typeof vi.fn>;
    sourceProgress: ReturnType<typeof vi.fn>;
    rows: ReturnType<typeof vi.fn>;
    locate: ReturnType<typeof vi.fn>;
    estimateImport: ReturnType<typeof vi.fn>;
    process: ReturnType<typeof vi.fn>;
  };
  record: ReturnType<typeof vi.fn>;
  events: ReturnType<typeof createFakeAppEvents>;
  emit(event: AppEvent): void;
  snapshot(): SourceSnapshot;
}

function harness(progress: () => LibrarySourceProgress = () => runningProgress(now)): Harness {
  const events = createFakeAppEvents();
  const api = {
    getSourceDetail: vi.fn(() => Promise.resolve(detail as typeof detail | null)),
    sourceProgress: vi.fn(() => Promise.resolve(progress())),
    rows: vi.fn(() => Promise.resolve({ rows: [], total: 48 })),
    locate: vi.fn(() => Promise.resolve(placed("Urban planning") as ObjectLocateResult | null)),
    estimateImport: vi.fn(() => Promise.resolve({ billing: "local" as const })),
    process: vi.fn(() => Promise.resolve({}))
  };
  const record = vi.fn();
  const sourceApi = {
    knowledge: { getSourceDetail: api.getSourceDetail },
    library: { sourceProgress: api.sourceProgress, rows: api.rows },
    objects: { locate: api.locate },
    budget: { estimateImport: api.estimateImport },
    ingestion: { process: api.process }
  } as unknown as SourceApi;
  const deps: SourceControllerDeps = {
    api: () => sourceApi,
    subscribe: (type, handler) => events.api.onAppEvent(type, handler),
    record,
    now: () => now,
    refreshDelayMs: 300
  };
  const controller = new SourceController(deps);
  return {
    controller,
    api,
    record,
    events,
    emit: (event) => events.emit(event),
    snapshot: () => controller.getSnapshot()
  };
}

/** Lets the promises that are already settled run. */
const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("reading the source", () => {
  it("reads the source and its strip once when shown, and records one open", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    expect(h.snapshot().load.status).toBe("loading");
    await settle();
    expect(h.snapshot().load).toMatchObject({ status: "ready" });
    expect(h.snapshot().strip).toMatchObject({ status: "ready" });
    expect(h.api.getSourceDetail).toHaveBeenCalledTimes(1);
    expect(h.api.sourceProgress).toHaveBeenCalledTimes(1);
    expect(h.api.sourceProgress).toHaveBeenCalledWith({ sourceId });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith({ kind: "source", id: sourceId, title: detail.title });
  });

  it("loads nothing and listens to nothing while hidden", async () => {
    const h = harness();
    h.controller.show(sourceId, false);
    await settle();
    expect(h.api.getSourceDetail).not.toHaveBeenCalled();
    expect(h.events.listening("object.changed")).toBe(0);
    expect(h.events.listening("job.progress")).toBe(0);
    expect(h.record).not.toHaveBeenCalled();
  });

  it("says a missing source is missing, and a failed read can be tried again", async () => {
    const h = harness();
    h.api.getSourceDetail.mockResolvedValueOnce(null);
    h.controller.show(sourceId, true);
    await settle();
    expect(h.snapshot().load.status).toBe("missing");

    const failing = harness();
    failing.api.getSourceDetail.mockRejectedValueOnce(new Error("no"));
    failing.controller.show(sourceId, true);
    await settle();
    expect(failing.snapshot().load.status).toBe("error");
    failing.controller.retry();
    await settle();
    expect(failing.snapshot().load.status).toBe("ready");
  });

  it("keeps the strip's failure to the strip: the panel stays, and the strip can be tried again", async () => {
    const h = harness();
    h.api.sourceProgress.mockRejectedValueOnce(new Error("no"));
    h.controller.show(sourceId, true);
    await settle();
    expect(h.snapshot().load.status).toBe("ready");
    expect(h.snapshot().strip.status).toBe("error");
    h.controller.retryStrip();
    await settle();
    expect(h.snapshot().strip.status).toBe("ready");
  });

  it("reads again, in place, when shown again after being hidden", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    h.controller.show(sourceId, false);
    h.controller.show(sourceId, true);
    await settle();
    expect(h.api.getSourceDetail).toHaveBeenCalledTimes(2);
    expect(h.snapshot().load.status).toBe("ready");
  });
});

describe("following the bus", () => {
  it("reads again once for a burst of changes to the source or its notes", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    h.emit({
      type: "object.changed",
      refs: [{ kind: "note", id: noteIds[0] as string, change: "created" }]
    });
    h.emit({ type: "object.changed", refs: [{ kind: "source", id: sourceId, change: "updated" }] });
    h.emit({
      type: "object.changed",
      refs: [{ kind: "note", id: noteIds[1] as string, change: "created" }]
    });
    expect(h.api.getSourceDetail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(h.api.getSourceDetail).toHaveBeenCalledTimes(2);
  });

  it("ignores a change to an object it does not show", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    h.emit({
      type: "object.changed",
      refs: [{ kind: "source", id: uuid(999), change: "updated" }]
    });
    h.emit({
      type: "object.changed",
      refs: [{ kind: "question", id: uuid(998), change: "created" }]
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(h.api.getSourceDetail).toHaveBeenCalledTimes(1);
  });

  it("follows the jobs only while the strip is live, and then reads the strip alone", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    const job = {
      type: "job.progress",
      lanes: { heavy: zero(), light: zero() },
      changedIds: [],
      changedIdsTruncated: false
    } as AppEvent;
    h.emit(job);
    await settle();
    expect(h.api.sourceProgress).toHaveBeenCalledTimes(2);
    expect(h.api.getSourceDetail).toHaveBeenCalledTimes(1);

    const finished = harness(() => doneProgress(now));
    finished.controller.show(sourceId, true);
    await settle();
    finished.emit(job);
    await settle();
    expect(finished.api.sourceProgress).toHaveBeenCalledTimes(1);
  });

  it("adds no timer that asks again: nothing is read without an event", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(h.api.getSourceDetail).toHaveBeenCalledTimes(1);
    expect(h.api.sourceProgress).toHaveBeenCalledTimes(1);
  });

  it("stops listening when hidden or disposed", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    expect(h.events.listening("object.changed")).toBe(1);
    h.controller.show(sourceId, false);
    expect(h.events.listening("object.changed")).toBe(0);
    h.controller.show(sourceId, true);
    h.controller.dispose();
    expect(h.events.listening("object.changed")).toBe(0);
    expect(h.events.listening("tree.changed")).toBe(0);
  });

  it("keeps what is shown when a refresh fails", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    h.api.getSourceDetail.mockRejectedValueOnce(new Error("no"));
    h.emit({ type: "object.changed", refs: [{ kind: "source", id: sourceId, change: "updated" }] });
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(h.snapshot().load.status).toBe("ready");
  });
});

describe("the places of the notes", () => {
  it("reads each wanted note once, as a chip's crumbs, and the unplaced one as unplaced", async () => {
    const h = harness();
    h.api.locate.mockImplementation(({ address }: { address: string }) =>
      Promise.resolve(
        address.endsWith(noteIds[0] as string) ? unplaced() : placed("Urban planning")
      )
    );
    h.controller.show(sourceId, true);
    await settle();
    h.controller.want([noteIds[0] as string, noteIds[1] as string]);
    await settle();
    expect(h.api.locate).toHaveBeenCalledTimes(2);
    const paths = h.snapshot().paths;
    expect(paths.get(noteIds[0] as string)).toEqual({ status: "unplaced" });
    expect(paths.get(noteIds[1] as string)).toEqual({
      status: "placed",
      crumbs: [{ id: uuid(101), title: "Urban planning" }]
    });
    // Asking again for notes already read asks nothing.
    h.controller.want([noteIds[0] as string, noteIds[1] as string]);
    await settle();
    expect(h.api.locate).toHaveBeenCalledTimes(2);
  });

  it("reads only the notes the panel draws, a few at a time", async () => {
    const h = harness();
    let open = 0;
    let most = 0;
    h.api.locate.mockImplementation(async () => {
      open += 1;
      most = Math.max(most, open);
      await Promise.resolve();
      open -= 1;
      return placed("Urban planning");
    });
    h.controller.show(sourceId, true);
    await settle();
    h.controller.want(noteIds.slice(0, 7));
    await settle();
    expect(h.api.locate).toHaveBeenCalledTimes(7);
    expect(most).toBeLessThanOrEqual(3);
  });

  it("reads a note's place again, in place, after the tree changed, keeping the old one meanwhile", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    h.controller.want([noteIds[1] as string]);
    await settle();
    expect(h.api.locate).toHaveBeenCalledTimes(1);
    let release: (value: ObjectLocateResult) => void = () => undefined;
    h.api.locate.mockImplementationOnce(
      () => new Promise<ObjectLocateResult>((resolve) => (release = resolve))
    );
    h.emit({
      type: "tree.changed",
      treeId: uuid(999),
      generation: 13,
      topicIds: null,
      changeSetId: null
    });
    await settle();
    expect(h.api.locate).toHaveBeenCalledTimes(2);
    expect(h.snapshot().paths.get(noteIds[1] as string)?.status).toBe("placed");
    release(placed("Moved"));
    await settle();
    expect(h.snapshot().paths.get(noteIds[1] as string)).toEqual({
      status: "placed",
      crumbs: [{ id: uuid(101), title: "Moved" }]
    });
  });

  it("marks a note whose place could not be read, and keeps a place that was read", async () => {
    const h = harness();
    h.api.locate.mockRejectedValueOnce(new Error("no"));
    h.controller.show(sourceId, true);
    await settle();
    h.controller.want([noteIds[1] as string]);
    await settle();
    expect(h.snapshot().paths.get(noteIds[1] as string)).toEqual({ status: "error" });
  });
});

describe("keeping up with a run", () => {
  const job = (): AppEvent =>
    ({
      type: "job.progress",
      lanes: { heavy: zero(), light: zero() },
      changedIds: [],
      changedIdsTruncated: false
    }) as AppEvent;
  const changed = (kind: "note" | "source", id: string, change: "created" | "updated") =>
    ({ type: "object.changed", refs: [{ kind, id, change }] }) as AppEvent;

  it("reads the strip again after a full read when a job moved while that read was in flight", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    expect(h.api.sourceProgress).toHaveBeenCalledTimes(1);
    let release: (value: typeof detail) => void = () => undefined;
    h.api.getSourceDetail.mockImplementationOnce(
      () => new Promise<typeof detail>((resolve) => (release = resolve))
    );
    h.emit(changed("source", sourceId, "updated"));
    await vi.advanceTimersByTimeAsync(300);
    expect(h.api.sourceProgress).toHaveBeenCalledTimes(2);
    h.emit(job());
    release(detail);
    await settle();
    expect(h.api.sourceProgress).toHaveBeenCalledTimes(3);
    expect(h.api.getSourceDetail).toHaveBeenCalledTimes(2);
  });

  it("reads a note's place again after that note changed, though the rows on screen did not", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    h.controller.want([noteIds[1] as string]);
    await settle();
    expect(h.api.locate).toHaveBeenCalledTimes(1);
    h.emit(changed("note", noteIds[1] as string, "updated"));
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(h.api.locate).toHaveBeenCalledTimes(2);
  });

  it("does not read the source again for a note of another source, but does for its own", async () => {
    const h = harness(() => doneProgress(now));
    h.controller.show(sourceId, true);
    await settle();
    h.emit(changed("note", uuid(990), "updated"));
    h.emit(changed("note", uuid(991), "created"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(h.api.getSourceDetail).toHaveBeenCalledTimes(1);
    h.emit(changed("note", noteIds[2] as string, "updated"));
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(h.api.getSourceDetail).toHaveBeenCalledTimes(2);
  });

  it("reads again for a note created while the strip is live, which is how new notes arrive", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    h.emit(changed("note", uuid(992), "created"));
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(h.api.getSourceDetail).toHaveBeenCalledTimes(2);
  });
});

describe("the source relations of the Connections tab", () => {
  const relationCreated = (noteId: string) =>
    ({ type: "relation.created", noteIds: [noteId] }) as AppEvent;

  it("moves its epoch once per burst of relations that concern the source's notes", async () => {
    const h = harness(() => doneProgress(now));
    h.controller.show(sourceId, true);
    await settle();
    expect(h.snapshot().relationsEpoch).toBe(0);
    h.emit(relationCreated(uuid(990)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.snapshot().relationsEpoch).toBe(0);
    h.emit(relationCreated(noteIds[0] as string));
    h.emit(relationCreated(noteIds[1] as string));
    await vi.advanceTimersByTimeAsync(300);
    expect(h.snapshot().relationsEpoch).toBe(1);
  });

  it("moves its epoch for any relation while the source is being made", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    h.emit(relationCreated(uuid(990)));
    await vi.advanceTimersByTimeAsync(300);
    expect(h.snapshot().relationsEpoch).toBe(1);
  });

  it("moves its epoch when the run ends, since promoted source relations publish nothing", async () => {
    let progress: () => LibrarySourceProgress = () => runningProgress(now);
    const h = harness(() => progress());
    h.controller.show(sourceId, true);
    await settle();
    progress = () => doneProgress(now);
    h.emit({
      type: "job.progress",
      lanes: { heavy: zero(), light: zero() },
      changedIds: [],
      changedIdsTruncated: false
    });
    await settle();
    expect(h.snapshot().relationsEpoch).toBe(1);
  });

  it("listens to relations only while shown", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    expect(h.events.listening("relation.created")).toBe(1);
    h.controller.show(sourceId, false);
    expect(h.events.listening("relation.created")).toBe(0);
  });
});

describe("the strip's own reads", () => {
  it("asks the money line once, from the passages indexed, only while the strip is live", async () => {
    const h = harness();
    h.controller.show(sourceId, true);
    await settle();
    expect(h.api.estimateImport).toHaveBeenCalledTimes(1);
    expect(h.api.estimateImport).toHaveBeenCalledWith({ chunkCount: 142 });
    expect(h.snapshot().cost).toEqual({ status: "ready", estimate: { billing: "local" } });

    const finished = harness(() => doneProgress(now));
    finished.controller.show(sourceId, true);
    await settle();
    expect(finished.api.estimateImport).not.toHaveBeenCalled();
  });

  it("knows the only source of the library, for the first-source hint", async () => {
    const h = harness();
    h.api.rows.mockResolvedValueOnce({ rows: [], total: 1 });
    h.controller.show(sourceId, true);
    await settle();
    expect(h.snapshot().firstSource).toBe(true);
    const ordinary = await readyHarness();
    expect(ordinary.snapshot().firstSource).toBe(false);
  });
});

describe("starting work", () => {
  it("queues the missing stages of this source for its notes, and reads the panel again", async () => {
    const h = harness(() => ({ ...doneProgress(now), run: null }));
    h.controller.show(sourceId, true);
    await settle();
    await h.controller.run("notes");
    expect(h.api.process).toHaveBeenCalledTimes(1);
    const request = h.api.process.mock.calls[0]?.[0];
    expect(request.runKind).toBe("missing_stages");
    expect(request.plan.targetSourceItemIds).toEqual([sourceId]);
    expect(request.plan.preset).toBe("full_knowledge");
    expect(h.snapshot().action).toEqual({ status: "idle" });
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(h.api.getSourceDetail).toHaveBeenCalledTimes(2);
  });

  it("retries a searchable-only source without asking for notes", async () => {
    const searchOnly = (): LibrarySourceProgress => ({
      ...doneProgress(now),
      steps: {
        ...doneProgress(now).steps,
        notes: { state: "notApplicable", soFar: 0, estimate: null }
      }
    });
    const h = harness(searchOnly);
    h.controller.show(sourceId, true);
    await settle();
    await h.controller.run("retry");
    expect(h.api.process.mock.calls[0]?.[0].plan.preset).toBe("search_ready");
  });

  it("says so when the work could not be queued, once, and starts no second request meanwhile", async () => {
    const h = harness();
    h.api.process.mockRejectedValueOnce(new Error("no"));
    h.controller.show(sourceId, true);
    await settle();
    await h.controller.run("notes");
    expect(h.snapshot().action).toEqual({ status: "failed" });
  });
});

function zero() {
  return { queued: 0, blocked: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
}

async function readyHarness(): Promise<Harness> {
  const h = harness();
  h.controller.show(sourceId, true);
  await settle();
  return h;
}
