import { describe, expect, it, vi } from "vitest";

import { parseDeepLink, type DeepLink } from "../../../../shared/obsidian-deep-link";
import { defaultWorkspace, reduce, type WorkspaceAction, type WorkspaceState } from "../../state";
import { planDeepLink, watchDeepLinks, type DeepLinkApi } from "./deep-link";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const link = (raw: string): DeepLink => {
  const parsed = parseDeepLink(raw);
  if (!parsed) throw new Error(`not a deep link: ${raw}`);
  return parsed;
};

function run(state: WorkspaceState, actions: readonly WorkspaceAction[]) {
  return actions.reduce((next, action) => reduce(next, action), state);
}

const start = () => defaultWorkspace("2026-11-12");
const inPlace = (destination: WorkspaceState["destination"]) =>
  reduce(start(), { type: "go", destination });

describe("where a deep link opens its object", () => {
  it("pushes the object in Explore from any other place", () => {
    const address = `memora://topic/${uuid(4)}`;
    for (const place of ["home", "map", "settings", "explore"] as const) {
      const state = run(inPlace(place), planDeepLink(link(address), inPlace(place)).actions);
      expect(state.destination, place).toBe("explore");
      expect(
        state.stacks.explore.panels.map((panel) => panel.history[0]),
        place
      ).toEqual([address]);
      expect(state.stacks.explore.focus, place).toBe(0);
    }
  });

  it("opens in the Library or the Inbox when the person is there", () => {
    const address = `memora://note/${uuid(21)}`;
    for (const place of ["library", "inbox"] as const) {
      const before = inPlace(place);
      const plan = planDeepLink(link(address), before);
      expect(plan.actions.some((action) => action.type === "go")).toBe(false);
      const state = run(before, plan.actions);
      expect(state.destination).toBe(place);
      expect(state.stacks[place].panels[0]?.history[0]).toBe(address);
      expect(state.stacks.explore.panels).toHaveLength(0);
    }
  });

  it("pushes beside the focused panel, and focuses an address that is already open", () => {
    let state = inPlace("explore");
    state = run(state, planDeepLink(link(`memora://source/${uuid(11)}`), state).actions);
    state = run(state, planDeepLink(link(`memora://note/${uuid(21)}`), state).actions);
    expect(state.stacks.explore.panels.map((panel) => panel.history[0])).toEqual([
      `memora://source/${uuid(11)}`,
      `memora://note/${uuid(21)}`
    ]);
    state = run(state, planDeepLink(link(`memora://source/${uuid(11)}`), state).actions);
    expect(state.stacks.explore.panels).toHaveLength(2);
    expect(state.stacks.explore.focus).toBe(0);
  });

  it("carries the anchor of a legacy relation link into the panel's address", () => {
    const relation = uuid(77);
    const raw = `memora://open/source/${uuid(11)}?relation=${relation}`;
    const state = run(inPlace("home"), planDeepLink(link(raw), inPlace("home")).actions);
    expect(state.stacks.explore.panels[0]?.history[0]).toBe(
      `memora://source/${uuid(11)}#relation=${relation}`
    );
  });

  it("opens nothing for a retired wiki page: Explore shows the notice", () => {
    const plan = planDeepLink(link(`memora://open/wiki/${uuid(9)}`), inPlace("map"));
    expect(plan.notice).toBe("retiredWiki");
    const state = run(inPlace("map"), plan.actions);
    expect(state.destination).toBe("explore");
    expect(state.stacks.explore.panels).toHaveLength(0);
  });
});

describe("following the links the main process sends", () => {
  const object = link(`memora://topic/${uuid(4)}`);

  it("opens a link that arrives, and the one that started the app, and stops with the window", async () => {
    let listener: (link: DeepLink) => void = () => undefined;
    const stop = vi.fn();
    const api: DeepLinkApi = {
      onOpen: (next) => {
        listener = next;
        return stop;
      },
      pendingOpen: () => Promise.resolve(object)
    };
    const seen: DeepLink[] = [];
    const off = watchDeepLinks(
      () => api,
      (next) => seen.push(next)
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([object]);
    listener(object);
    expect(seen).toHaveLength(2);
    off();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("opens nothing when the pending read answers after the window is gone, or fails", async () => {
    let resolve: (value: DeepLink | null) => void = () => undefined;
    const late = new Promise<DeepLink | null>((done) => (resolve = done));
    const seen: DeepLink[] = [];
    const off = watchDeepLinks(
      () => ({ onOpen: () => () => undefined, pendingOpen: () => late }),
      (next) => seen.push(next)
    );
    off();
    resolve(object);
    await late;
    expect(seen).toEqual([]);
    const failing = watchDeepLinks(
      () => ({ onOpen: () => () => undefined, pendingOpen: () => Promise.reject(new Error("x")) }),
      (next) => seen.push(next)
    );
    await Promise.resolve();
    failing();
    expect(seen).toEqual([]);
  });

  it("does nothing where the bridge does not exist", () => {
    expect(() =>
      watchDeepLinks(
        () => undefined,
        () => undefined
      )()
    ).not.toThrow();
  });
});
