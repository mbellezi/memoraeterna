import { describe, expect, it } from "vitest";

import type { Evidence } from "./evidence";
import {
  resolveFrame,
  stateReasons,
  textSignature,
  untilState,
  type FrameNode,
  type FrameReading
} from "./frame";

const node = (dataset: FrameNode["dataset"] = {}): FrameNode => ({ dataset: { ...dataset } });

describe("which frame reports the state", () => {
  it("takes the frame the surface renders itself, and the stand-in never overrides it", () => {
    const stand = node({ harness: "" });
    const reading = resolveFrame(
      [stand, node({ surface: "note", state: "empty" })],
      stand,
      "note",
      "empty",
      "hosted"
    );
    expect(reading).toEqual({ frame: "own", reasons: [], state: "empty" });
    expect(stand.dataset.state).toBeUndefined();
  });

  it("fails a surface or a state that the own frame reports differently", () => {
    expect(
      resolveFrame([node({ surface: "note", state: "success" })], null, "note", "empty", "panel")
    ).toEqual({
      frame: "own",
      reasons: ["frame says state success, expected empty"],
      state: "success"
    });
    expect(
      resolveFrame([node({ surface: "topic", state: "empty" })], null, "note", "empty", "panel")
        .reasons
    ).toEqual(["frame says surface topic, expected note"]);
    expect(resolveFrame([node({ surface: "note" })], null, "note", "empty", "panel")).toMatchObject(
      {
        reasons: ["frame says state none, expected empty"],
        state: null
      }
    );
  });

  it("labels a hosted screen that has no frame yet with the stand-in", () => {
    const stand = node({ harness: "" });
    expect(resolveFrame([stand], stand, "inbox", "error", "hosted")).toEqual({
      frame: "harness",
      reasons: [],
      state: "error"
    });
    expect(stand.dataset).toMatchObject({ surface: "inbox", state: "error" });
  });

  it("fails every other kind of surface that renders no frame of its own", () => {
    for (const kind of [
      "panel",
      "destination",
      "settings",
      "overlay",
      "context",
      "chrome"
    ] as const) {
      const stand = node({ harness: "" });
      expect(resolveFrame([], stand, "x", "success", kind)).toEqual({
        frame: "none",
        reasons: [`a ${kind} surface renders no frame of its own`],
        state: null
      });
      expect(stand.dataset.surface).toBeUndefined();
    }
  });

  it("fails a hosted screen when the stand-in is gone too", () => {
    expect(resolveFrame([], null, "inbox", "error", "hosted").reasons).toEqual(["no frame"]);
  });
});

describe("when a surface is in its state", () => {
  const evidence: Evidence = { alerts: 0, busy: 0, statuses: 0, text: 5 };
  const own: FrameReading = { frame: "own", reasons: [], state: "success" };
  const reading = (over: Partial<Parameters<typeof stateReasons>[0]> = {}) => ({
    mode: "success" as const,
    ribbon: false,
    ribbonShown: false,
    frame: own,
    evidence,
    mounted: true,
    missing: [],
    ...over
  });

  it("carries the frame's disagreement and the evidence together", () => {
    expect(stateReasons(reading())).toEqual([]);
    expect(
      stateReasons(
        reading({
          frame: {
            frame: "own",
            reasons: ["frame says state empty, expected success"],
            state: "empty"
          },
          evidence: { ...evidence, alerts: 1 }
        })
      )
    ).toEqual(["frame says state empty, expected success", "success shows an alert"]);
  });

  it("does not read evidence when there is no frame, and the frame's reason stands alone", () => {
    expect(
      stateReasons(
        reading({
          frame: {
            frame: "none",
            reasons: ["a panel surface renders no frame of its own"],
            state: null
          }
        })
      )
    ).toEqual(["a panel surface renders no frame of its own"]);
  });

  it("asks an object panel for its path ribbon in success only, and a fixture for every call", () => {
    expect(stateReasons(reading({ ribbon: true }))).toEqual([
      "an object panel shows no path ribbon in success"
    ]);
    expect(stateReasons(reading({ ribbon: true, ribbonShown: true }))).toEqual([]);
    expect(stateReasons(reading({ ribbon: true, mode: "empty" }))).toEqual([]);
    expect(stateReasons(reading({ missing: ["a.b", "c.d"] }))).toEqual(["no fixture for a.b, c.d"]);
    expect(
      stateReasons(
        reading({ missing: ["a.b"], mode: "error", evidence: { ...evidence, alerts: 1 } })
      )
    ).toEqual([]);
  });
});

describe("waiting for the state", () => {
  const wait = { timeoutMs: 500, pollMs: 50, settleMs: 200 };
  const clock = () => {
    let now = 0;
    return { sleep: async (ms: number) => void (now += ms), now: () => now };
  };

  it("passes a surface that reports its state late, once it keeps it through the settle", async () => {
    const time = clock();
    const result = await untilState(
      () => ({ reasons: time.now() < 150 ? ["not yet"] : [] }),
      time.sleep,
      wait
    );
    expect(result.reasons).toEqual([]);
    expect(time.now()).toBe(150 + 200);
  });

  it("fails a surface that is right and then flips within the settle", async () => {
    const time = clock();
    const result = await untilState(
      () => ({ reasons: time.now() >= 200 ? ["flipped to an alert"] : [] }),
      time.sleep,
      wait
    );
    expect(result.reasons).toEqual(["flipped to an alert"]);
  });

  it("gives up after the timeout with the reasons of its last look", async () => {
    const time = clock();
    const result = await untilState(() => ({ reasons: ["never"] }), time.sleep, wait);
    expect(result.reasons).toEqual(["never"]);
    expect(time.now()).toBe(500);
  });
});

describe("the text signature", () => {
  it("tells different text apart and ignores whitespace differences", () => {
    expect(textSignature("Nothing here yet")).not.toBe(textSignature("Three notes"));
    expect(textSignature("a  b\n c")).toBe(textSignature("a b c"));
  });
});
