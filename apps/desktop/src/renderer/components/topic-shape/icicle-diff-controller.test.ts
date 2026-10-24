import { describe, expect, it, vi } from "vitest";
import type { ChangeSetRef, ChangesDiff } from "@app/domain";

import { IcicleDiffController, type IcicleDiffLoader } from "./icicle-diff-controller";
import {
  diffId,
  diffSummary,
  diffTopics,
  sampleDiffNodes,
  sampleTopicDiff
} from "./icicle-diff-fixtures";

const topic: ChangeSetRef = { kind: "topic", id: diffId(700) };
const other: ChangeSetRef = { kind: "topic", id: diffId(701) };

/** A read that answers when the test says so. */
function deferred() {
  const calls: Array<{
    ref: ChangeSetRef;
    resolve: (diff: ChangesDiff | null) => void;
    reject: (error: unknown) => void;
  }> = [];
  const load: IcicleDiffLoader = (ref) =>
    new Promise<ChangesDiff | null>((resolve, reject) => {
      calls.push({ ref, resolve, reject });
    });
  return { calls, load };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the icicle diff controller", () => {
  it("starts idle, reads the change-set once it is pointed at, and shows the bounded diff", async () => {
    const { calls, load } = deferred();
    const controller = new IcicleDiffController({ load });
    expect(controller.getSnapshot().load).toEqual({ status: "idle" });
    controller.setTarget(topic);
    expect(controller.getSnapshot().load).toEqual({ status: "loading" });
    expect(calls.map((call) => call.ref)).toEqual([topic]);
    calls[0]!.resolve(sampleTopicDiff(sampleDiffNodes(), 3));
    await settle();
    const { load: state } = controller.getSnapshot();
    expect(state.status).toBe("ready");
    expect(state.status === "ready" && state.nodes).toHaveLength(7);
    expect(state.status === "ready" && state.hidden).toBe(3);
  });

  it("reads with the newest loader without reading again", () => {
    const first = deferred();
    const second = deferred();
    const controller = new IcicleDiffController({ load: first.load });
    controller.setLoader(second.load);
    controller.setTarget(topic);
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(1);
    controller.setLoader(first.load);
    expect(second.calls).toHaveLength(1);
    expect(first.calls).toHaveLength(0);
  });

  it("does not read again for the same change-set", () => {
    const { calls, load } = deferred();
    const controller = new IcicleDiffController({ load });
    controller.setTarget(topic);
    controller.setTarget({ ...topic });
    expect(calls).toHaveLength(1);
  });

  it("drops the answer of a change-set it has moved on from, and its selection", async () => {
    const { calls, load } = deferred();
    const controller = new IcicleDiffController({ load });
    controller.setTarget(topic);
    controller.select(diffId(diffTopics.spacing));
    controller.setTarget(other);
    expect(controller.getSnapshot().selectedId).toBeNull();
    calls[0]!.resolve(sampleTopicDiff());
    await settle();
    expect(controller.getSnapshot().load).toEqual({ status: "loading" });
    calls[1]!.resolve(sampleTopicDiff([], 0));
    await settle();
    expect(controller.getSnapshot().load).toEqual({ status: "ready", nodes: [], hidden: 0 });
  });

  it("goes back to idle when nothing is in view", async () => {
    const { calls, load } = deferred();
    const controller = new IcicleDiffController({ load });
    controller.setTarget(topic);
    controller.setTarget(null);
    calls[0]!.resolve(sampleTopicDiff());
    await settle();
    expect(controller.getSnapshot()).toEqual({ load: { status: "idle" }, selectedId: null });
  });

  it("reads a gone change-set as missing and a failed read as an error that can be retried", async () => {
    const { calls, load } = deferred();
    const controller = new IcicleDiffController({ load });
    controller.setTarget(topic);
    calls[0]!.resolve(null);
    await settle();
    expect(controller.getSnapshot().load).toEqual({ status: "missing" });

    controller.setTarget(other);
    calls[1]!.reject(new Error("changes.errors.unavailable"));
    await settle();
    expect(controller.getSnapshot().load).toEqual({ status: "error" });
    controller.retry();
    expect(controller.getSnapshot().load).toEqual({ status: "loading" });
    expect(calls[2]!.ref).toEqual(other);
    calls[2]!.resolve(sampleTopicDiff());
    await settle();
    expect(controller.getSnapshot().load.status).toBe("ready");
  });

  it("does not retry while a read is in flight", () => {
    const { calls, load } = deferred();
    const controller = new IcicleDiffController({ load });
    controller.setTarget(topic);
    controller.retry();
    expect(calls).toHaveLength(1);
  });

  it("makes no call for a relation pass or an overview write, and none for a diff of another kind", async () => {
    const spy = vi.fn<IcicleDiffLoader>(() => Promise.resolve(null));
    const controller = new IcicleDiffController({ load: spy });
    for (const kind of ["relation", "overview"] as const) {
      controller.setTarget({ kind, id: diffId(5) });
      expect(controller.getSnapshot().load).toEqual({ status: "unsupported" });
    }
    controller.retry();
    controller.refresh();
    expect(spy).not.toHaveBeenCalled();

    const answer = deferred();
    const again = new IcicleDiffController({ load: answer.load });
    again.setTarget(topic);
    answer.calls[0]!.resolve({
      kind: "relation",
      summary: { ...diffSummary, kind: "relation" },
      relations: [],
      hidden: 0
    });
    await settle();
    expect(again.getSnapshot().load).toEqual({ status: "unsupported" });
  });

  it("selects a topic and clears the selection", () => {
    const controller = new IcicleDiffController({ load: deferred().load });
    const seen: Array<string | null> = [];
    controller.subscribe(() => seen.push(controller.getSnapshot().selectedId));
    controller.select(diffId(2));
    controller.select(diffId(2));
    controller.select(null);
    expect(seen).toEqual([diffId(2), null]);
  });

  it("refreshes in place: the diff stays until the new one arrives, and the same content renders nothing", async () => {
    const { calls, load } = deferred();
    const controller = new IcicleDiffController({ load });
    controller.setTarget(topic);
    calls[0]!.resolve(sampleTopicDiff());
    await settle();
    controller.select(diffId(diffTopics.spacing));
    let renders = 0;
    controller.subscribe(() => (renders += 1));

    controller.refresh();
    expect(controller.getSnapshot().load.status).toBe("ready");
    calls[1]!.resolve(sampleTopicDiff());
    await settle();
    expect(renders).toBe(0);

    controller.refresh();
    calls[2]!.resolve(sampleTopicDiff(sampleDiffNodes().slice(0, 3), 1));
    await settle();
    expect(renders).toBe(1);
    const state = controller.getSnapshot();
    expect(state.load.status === "ready" && state.load.nodes).toHaveLength(3);
    expect(state.selectedId).toBe(diffId(diffTopics.spacing));
  });

  it("keeps the diff on screen when a refresh fails", async () => {
    const { calls, load } = deferred();
    const controller = new IcicleDiffController({ load });
    controller.setTarget(topic);
    calls[0]!.resolve(sampleTopicDiff());
    await settle();
    controller.refresh();
    calls[1]!.reject(new Error("boom"));
    await settle();
    expect(controller.getSnapshot().load.status).toBe("ready");
  });

  it("shows the change-set gone when a refresh finds it pruned", async () => {
    const { calls, load } = deferred();
    const controller = new IcicleDiffController({ load });
    controller.setTarget(topic);
    calls[0]!.resolve(sampleTopicDiff());
    await settle();
    controller.refresh();
    calls[1]!.resolve(null);
    await settle();
    expect(controller.getSnapshot().load).toEqual({ status: "missing" });
  });

  it("stops telling a listener that unsubscribed", () => {
    const { load } = deferred();
    const controller = new IcicleDiffController({ load });
    let calls = 0;
    const stop = controller.subscribe(() => (calls += 1));
    controller.select(diffId(1));
    stop();
    controller.select(diffId(2));
    expect(calls).toBe(1);
  });
});
