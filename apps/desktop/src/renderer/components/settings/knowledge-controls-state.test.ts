import {
  applyKnowledgeControlsUpdate,
  defaultKnowledgeControls,
  type KnowledgeControls
} from "@app/domain";
import { describe, expect, it } from "vitest";

import {
  createKnowledgeControlsSaver,
  initialKnowledgeControlsState,
  knowledgeControlsReducer,
  monthlyCapMaxUsd,
  parseMonthlyCapInput,
  readKnowledgeControls,
  type KnowledgeControlsAction,
  type KnowledgeControlsState
} from "./knowledge-controls-state";

const run = (actions: KnowledgeControlsAction[], from = initialKnowledgeControlsState) =>
  actions.reduce(knowledgeControlsReducer, from as KnowledgeControlsState);
const ready = (controls: KnowledgeControls = defaultKnowledgeControls) =>
  run([{ type: "loaded", controls }]);

describe("the Knowledge controls state", () => {
  it("starts loading and shows the stored controls once they are read", () => {
    expect(initialKnowledgeControlsState).toEqual({ phase: "loading" });
    expect(ready()).toEqual({
      phase: "ready",
      saved: defaultKnowledgeControls,
      shown: defaultKnowledgeControls,
      saving: 0,
      outcome: "idle"
    });
  });

  it("keeps a failed read visible and retryable", () => {
    const failed = run([{ type: "loadFailed" }]);
    expect(failed).toEqual({ phase: "error" });
    expect(knowledgeControlsReducer(failed, { type: "retry" })).toEqual({ phase: "loading" });
    // A retry only means something from the error state.
    expect(knowledgeControlsReducer(ready(), { type: "retry" })).toEqual(ready());
    // A change cannot be made before the controls are known.
    expect(
      knowledgeControlsReducer({ phase: "loading" }, { type: "edit", change: { paused: true } })
    ).toEqual({ phase: "loading" });
  });

  it("shows a change at once and settles on what main answered", () => {
    const editing = run([{ type: "edit", change: { autonomy: "suggest" } }], ready());
    expect(editing).toMatchObject({
      phase: "ready",
      shown: { autonomy: "suggest" },
      saved: { autonomy: "auto" },
      saving: 1,
      outcome: "idle"
    });
    const saved = knowledgeControlsReducer(editing, {
      type: "saved",
      controls: { ...defaultKnowledgeControls, autonomy: "suggest" }
    });
    expect(saved).toMatchObject({
      shown: { autonomy: "suggest" },
      saved: { autonomy: "suggest" },
      saving: 0,
      outcome: "saved"
    });
  });

  it("puts the last saved value back when a save fails, and says so", () => {
    const failed = run(
      [{ type: "edit", change: { treeShape: "deep" } }, { type: "saveFailed" }],
      ready()
    );
    expect(failed).toMatchObject({
      shown: { treeShape: "balanced" },
      saved: { treeShape: "balanced" },
      saving: 0,
      outcome: "failed"
    });
    // The next change clears the failure.
    expect(
      knowledgeControlsReducer(failed, { type: "edit", change: { paused: true } })
    ).toMatchObject({ outcome: "idle", shown: { paused: true } });
  });

  it("keeps the screen where the person put it while changes are still in flight", () => {
    const state = run(
      [
        { type: "edit", change: { onlyIdle: true } },
        { type: "edit", change: { onlyOnAc: true } },
        { type: "saved", controls: { ...defaultKnowledgeControls, onlyIdle: true } }
      ],
      ready()
    );
    expect(state).toMatchObject({
      saving: 1,
      shown: { onlyIdle: true, onlyOnAc: true },
      saved: { onlyIdle: true, onlyOnAc: false }
    });
    const settled = knowledgeControlsReducer(state, {
      type: "saved",
      controls: { ...defaultKnowledgeControls, onlyIdle: true, onlyOnAc: true }
    });
    expect(settled).toMatchObject({ saving: 0, shown: { onlyIdle: true, onlyOnAc: true } });
  });

  it("ignores an answer that comes when nothing is being edited", () => {
    expect(
      knowledgeControlsReducer(
        { phase: "loading" },
        { type: "saved", controls: defaultKnowledgeControls }
      )
    ).toEqual({ phase: "loading" });
    expect(knowledgeControlsReducer({ phase: "error" }, { type: "saveFailed" })).toEqual({
      phase: "error"
    });
  });
});

describe("reading and saving the controls", () => {
  it("turns a read into the action the reducer takes", async () => {
    expect(await readKnowledgeControls(async () => defaultKnowledgeControls)).toEqual({
      type: "loaded",
      controls: defaultKnowledgeControls
    });
    expect(
      await readKnowledgeControls(async () => {
        throw new Error("offline");
      })
    ).toEqual({ type: "loadFailed" });
  });

  it("saves changes in the order they were made, each shown at once", async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    let stored = defaultKnowledgeControls;
    const actions: KnowledgeControlsAction[] = [];
    const save = createKnowledgeControlsSaver(
      (change) =>
        new Promise((resolve) => {
          calls.push(JSON.stringify(change));
          releases.push(() => {
            stored = applyKnowledgeControlsUpdate(stored, change);
            resolve(stored);
          });
        }),
      (action) => actions.push(action)
    );
    const first = save({ autonomy: "off" });
    const second = save({ paused: true });
    // Both show at once; only the first has gone to main.
    expect(actions.map((action) => action.type)).toEqual(["edit", "edit"]);
    await Promise.resolve();
    expect(calls).toEqual(['{"autonomy":"off"}']);
    releases[0]!();
    await first;
    await Promise.resolve();
    expect(calls).toEqual(['{"autonomy":"off"}', '{"paused":true}']);
    releases[1]!();
    await second;
    expect(actions.map((action) => action.type)).toEqual(["edit", "edit", "saved", "saved"]);
    const final = actions.reduce(knowledgeControlsReducer, ready() as KnowledgeControlsState);
    expect(final).toMatchObject({
      saving: 0,
      shown: { autonomy: "off", paused: true },
      saved: { autonomy: "off", paused: true },
      outcome: "saved"
    });
  });

  it("reports a failed save and still saves the change behind it", async () => {
    let attempt = 0;
    const actions: KnowledgeControlsAction[] = [];
    const save = createKnowledgeControlsSaver(
      async (change) => {
        attempt += 1;
        if (attempt === 1) throw new Error("errors.database.notReady");
        return applyKnowledgeControlsUpdate(defaultKnowledgeControls, change);
      },
      (action) => actions.push(action)
    );
    await Promise.all([save({ treeShape: "deep" }), save({ onlyOnAc: true })]);
    expect(actions.map((action) => action.type)).toEqual(["edit", "edit", "saveFailed", "saved"]);
    expect(
      actions.reduce(knowledgeControlsReducer, ready() as KnowledgeControlsState)
    ).toMatchObject({
      saving: 0,
      outcome: "saved",
      saved: { onlyOnAc: true, treeShape: "balanced" }
    });
  });
});

describe("the monthly cap field", () => {
  it("reads dollars and cents, with a comma or a dot", () => {
    expect(parseMonthlyCapInput("5")).toBe(5);
    expect(parseMonthlyCapInput(" 12.5 ")).toBe(12.5);
    expect(parseMonthlyCapInput("7,25")).toBe(7.25);
    expect(parseMonthlyCapInput("0")).toBe(0);
    expect(parseMonthlyCapInput("1.234")).toBe(1.23);
  });

  it("brings a value into the range and refuses what is not a number", () => {
    expect(parseMonthlyCapInput("999999")).toBe(monthlyCapMaxUsd);
    expect(parseMonthlyCapInput("50", 20)).toBe(20);
    for (const text of ["", " ", "abc", "-1", "1e3", "5 dollars", "1.2.3"])
      expect(parseMonthlyCapInput(text), text).toBeNull();
  });
});
