import { describe, expect, it } from "vitest";

import { pairKey, pickFreePairs } from "./seed-inbox.js";
import { noteAddress, stackOf, StepLog } from "./workspace-steps.js";

const panel = (...history: string[]) => ({ id: history[0], history, index: history.length - 1 });

describe("stackOf", () => {
  const state = {
    version: 1,
    destination: "explore",
    stacks: {
      explore: {
        root: "memora://explore",
        focus: 1,
        panels: [panel("memora://note/a"), panel("memora://note/b0", "memora://note/b")]
      }
    }
  };

  it("lists the address each panel shows now, left to right, with the focus", () => {
    expect(stackOf(state, "explore")).toEqual({
      root: "memora://explore",
      panels: ["memora://note/a", "memora://note/b"],
      focus: 1
    });
  });

  it("is null for a destination or a shape it does not know", () => {
    expect(stackOf(state, "inbox")).toBeNull();
    expect(stackOf(null, "explore")).toBeNull();
    expect(stackOf({ stacks: { explore: { root: "x", panels: [{}] } } }, "explore")).toBeNull();
    expect(stackOf({ stacks: { explore: { panels: [] } } }, "explore")).toBeNull();
  });

  it("names a note address", () => {
    expect(noteAddress("0f1e")).toBe("memora://note/0f1e");
  });
});

describe("the Inbox seed's note pairs", () => {
  it("takes the first pairs that no relation links yet, in order, each once", () => {
    const ids = ["a", "b", "c", "d"];
    const taken = new Set([pairKey("b", "a"), pairKey("c", "d")]);
    expect(pickFreePairs(ids, taken, 3)).toEqual([
      ["a", "c"],
      ["a", "d"],
      ["b", "c"]
    ]);
  });

  it("keys a pair the same way in either order", () => {
    expect(pairKey("x", "y")).toBe(pairKey("y", "x"));
  });

  it("refuses when the notes make fewer pairs than asked", () => {
    expect(() => pickFreePairs(["a", "b", "c"], new Set([pairKey("a", "b")]), 3)).toThrow(
      /Only 2 free note pairs among 3 notes; 3 needed/u
    );
  });
});

describe("StepLog", () => {
  const scan = (drawnTheme: "light" | "dark") => ({
    checked: 1,
    failures: [],
    unverifiable: [],
    drawnTheme
  });
  const fake = () => {
    const calls: string[] = [];
    const session = {
      electronApp: { evaluate: async () => undefined },
      page: { bringToFront: async () => undefined }
    };
    const capture = async (_session: unknown, _spec: string, _index: number, step: string) => {
      calls.push(`capture ${step}`);
      return { step, screenshots: [], contrast: { light: scan("light"), dark: scan("dark") } };
    };
    const followTheme = async () => {
      calls.push("follow system theme");
    };
    return { calls, session, capture, followTheme };
  };

  it("makes the app follow the window's scheme once, before its first capture", async () => {
    const { calls, session, capture, followTheme } = fake();
    const steps = new StepLog(session as never, "j4", {
      capture: capture as never,
      followTheme
    });
    await steps.step("origin-note");
    await steps.step("hover-card");
    expect(calls).toEqual(["follow system theme", "capture origin-note", "capture hover-card"]);
    expect(steps.contrastFailures()).toEqual([]);
  });

  it("leaves the theme alone when the journey sets it itself", async () => {
    const { calls, session, capture, followTheme } = fake();
    const steps = new StepLog(session as never, "j7", {
      themeSetByJourney: true,
      capture: capture as never,
      followTheme
    });
    await steps.step("general-theme-system");
    expect(calls).toEqual(["capture general-theme-system"]);
  });
});
