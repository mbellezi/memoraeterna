import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GraphHoverIntent,
  GraphWheelMotion,
  boundedGraphWheelRatio,
  captureGraphWheelEvent,
  graphZoomOutRatio,
  softenGraphZoomDelta,
  zoomOutCenteringStrength
} from "./knowledge-graph-interaction";

describe("graph hover intent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(["node", "edge"] as const)("highlights a %s after 100 ms even while moving inside it", (type) => {
    const highlight = vi.fn();
    const preview = vi.fn();
    const intent = new GraphHoverIntent(highlight, preview);
    intent.enter({ type, key: "a", x: 0, y: 0 });
    highlight.mockClear();
    preview.mockClear();
    vi.advanceTimersByTime(70);
    intent.move({ x: 1, y: 1 });
    vi.advanceTimersByTime(29);
    expect(highlight).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(highlight).toHaveBeenCalledWith({ type, key: "a", x: 1, y: 1 });
    expect(preview).not.toHaveBeenCalled();
    vi.advanceTimersByTime(970);
    expect(preview).toHaveBeenCalledOnce();
    intent.dispose();
  });

  it("cancels pending highlights and popups throughout a drag, including stale leave events", () => {
    const highlight = vi.fn();
    const preview = vi.fn();
    const intent = new GraphHoverIntent(highlight, preview);
    intent.enter({ type: "node", key: "a", x: 0, y: 0 });
    vi.advanceTimersByTime(50);
    intent.suspend();
    highlight.mockClear(); preview.mockClear();
    intent.enter({ type: "edge", key: "ab", x: 1, y: 1 });
    intent.move({ x: 3, y: 3 });
    vi.advanceTimersByTime(2_000);
    expect(highlight).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    intent.resume();
    intent.enter({ type: "node", key: "b", x: 0, y: 0 });
    intent.leave("node", "a");
    vi.advanceTimersByTime(100);
    expect(highlight).toHaveBeenLastCalledWith({ type: "node", key: "b", x: 0, y: 0 });
    intent.dispose();
    preview.mockClear();
    vi.advanceTimersByTime(2_000);
    expect(preview).not.toHaveBeenCalled();
  });

  it("does not highlight targets crossed in less than 100 ms", () => {
    const highlight = vi.fn();
    const intent = new GraphHoverIntent(highlight, vi.fn());
    intent.enter({ type: "node", key: "a", x: 0, y: 0 });
    vi.advanceTimersByTime(80);
    intent.leave("node", "a");
    vi.advanceTimersByTime(1_000);
    expect(highlight.mock.calls.every(([target]) => target === null)).toBe(true);
    intent.dispose();
  });
});

describe("inertial graph wheel motion", () => {
  const wheel = { deltaY: -100, deltaMode: 0, ctrlKey: false, shiftKey: false };

  it("starts fast on the first frame, then strictly decelerates to rest without further input", () => {
    const motion = new GraphWheelMotion();
    motion.push(wheel, 0);
    const deltas = [];
    for (let now = 16; now <= 800; now += 16) deltas.push(Math.abs(motion.advance(now)));
    expect(1 - Math.exp(-deltas[0]!)).toBeGreaterThan(0.12);
    for (let index = 1; index < deltas.length; index += 1) expect(deltas[index]).toBeLessThanOrEqual(deltas[index - 1]!);
    expect(motion.active).toBe(false);
    expect(deltas.at(-1)).toBe(0);
  });

  it("renders intermediate zooms during rapid input and never builds an unlimited destination backlog", () => {
    const motion = new GraphWheelMotion();
    let ratio = 1;
    const frames: number[] = [];
    for (let now = 0; now <= 800; now += 4) {
      if (now <= 120) motion.push(wheel, now);
      if (now > 0 && now % 16 === 0) {
        const delta = motion.advance(now, { ratio, minimum: 0.08, maximum: 8 });
        expect(Math.abs(delta)).toBeLessThanOrEqual(1.68);
        ratio *= Math.exp(delta);
        frames.push(ratio);
      }
    }
    expect(frames[0]).toBeLessThan(0.21);
    expect(frames[0]).toBeGreaterThan(0.18);
    expect(new Set(frames).size).toBeGreaterThan(5);
    expect(motion.active).toBe(false);
    const one = new GraphWheelMotion();
    const burst = new GraphWheelMotion();
    one.push(wheel, 0);
    for (let i = 0; i < 1_000; i += 1) burst.push(wheel, 0);
    expect(Math.abs(burst.advance(16))).toBeGreaterThan(Math.abs(one.advance(16)) * 1.5);
  });

  it("does not jump after a slow frame or catch up after being backgrounded", () => {
    const motion = new GraphWheelMotion();
    motion.push(wheel, 0);
    motion.advance(16);
    expect(Math.abs(motion.advance(100))).toBeLessThan(1.1);
    expect(motion.advance(400)).toBe(0);
    expect(motion.active).toBe(false);
    motion.push(wheel, 1_000);
    expect(motion.advance(990)).toBe(0);
    expect(motion.advance(1_016)).toBeLessThan(0);
  });

  it("has equivalent travel at 60 and 120 Hz and reverses immediately", () => {
    const travel = (frame: number) => {
      const motion = new GraphWheelMotion();
      motion.push(wheel, 0);
      let delta = 0;
      for (let now = frame; now <= 800; now += frame) delta += motion.advance(now);
      return delta;
    };
    expect(travel(1000 / 60)).toBeCloseTo(travel(1000 / 120), 3);
    const motion = new GraphWheelMotion();
    motion.push(wheel, 0);
    expect(motion.advance(16)).toBeLessThan(0);
    motion.push({ ...wheel, deltaY: 100 }, 17);
    expect(motion.advance(32)).toBeGreaterThan(0);
    motion.cancel();
    expect(motion.advance(48)).toBe(0);
  });

  it("normalizes units continuously, preserves small inputs and offers Shift precision", () => {
    const firstFrame = (deltaY: number, deltaMode = 0, shiftKey = false, ctrlKey = false) => {
      const motion = new GraphWheelMotion();
      motion.push({ deltaY, deltaMode, ctrlKey, shiftKey }, 0);
      return motion.advance(16);
    };
    expect(firstFrame(120)).toBeCloseTo(firstFrame(3, 1));
    expect(firstFrame(0.2)).toBeGreaterThan(0);
    expect(firstFrame(0.2)).toBeLessThan(firstFrame(4));
    expect(Math.abs(firstFrame(15.99) - firstFrame(16.01))).toBeLessThan(0.001);
    expect(firstFrame(100, 0, true)).toBeCloseTo(firstFrame(100) / 4);
    expect(firstFrame(0.2, 0, false, true)).toBeGreaterThan(firstFrame(0.2));
    expect(firstFrame(0)).toBe(0);
  });

  it("accelerates high-cadence input while preserving gentle low-delta control", () => {
    const slow = new GraphWheelMotion();
    slow.push({ ...wheel, deltaY: -0.5 }, 0);
    const slowTravel = Math.abs(slow.advance(16));
    const rapid = new GraphWheelMotion();
    for (let now = 0; now <= 16; now += 4) rapid.push({ ...wheel, deltaY: -4 }, now);
    const rapidTravel = Math.abs(rapid.advance(16));
    expect(slowTravel).toBeLessThan(0.01);
    expect(rapidTravel).toBeGreaterThan(slowTravel * 20);
    expect(rapidTravel).toBeGreaterThan(0.05);
  });

  it("tracks changing free-wheel speed without flattening consecutive events at a ceiling", () => {
    const motion = new GraphWheelMotion();
    motion.push({ ...wheel, deltaY: -20 }, 0);
    const slow = Math.abs(motion.advance(16));
    motion.push({ ...wheel, deltaY: -80 }, 17);
    const fast = Math.abs(motion.advance(32));
    motion.push({ ...wheel, deltaY: -20 }, 33);
    const slowing = Math.abs(motion.advance(48));
    expect(fast).toBeGreaterThan(slow * 2.5);
    expect(slowing).toBeLessThan(fast / 2.5);
  });

  it("eases into both zoom boundaries and stops exactly at a reached boundary", () => {
    const far = softenGraphZoomDelta(0.4, { ratio: 1, minimum: 0.08, maximum: 4 });
    const near = softenGraphZoomDelta(0.4, { ratio: 3.8, minimum: 0.08, maximum: 4 });
    expect(far).toBeGreaterThan(0.35);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(far / 4);
    expect(softenGraphZoomDelta(0.4, { ratio: 4, minimum: 0.08, maximum: 4 })).toBe(0);
    expect(softenGraphZoomDelta(-0.4, { ratio: 0.08, minimum: 0.08, maximum: 4 })).toBe(0);
  });

  it("never lets the zoom-out ceiling force zoom-in to its final limit", () => {
    expect(boundedGraphWheelRatio(0.4, -0.12, 0.08, 0.08)).toBeCloseTo(0.4 * Math.exp(-0.12));
    expect(boundedGraphWheelRatio(0.4, -4, 0.08, 0.08)).toBe(0.08);
    expect(boundedGraphWheelRatio(0.4, 1, 0.08, 0.6)).toBe(0.6);
  });

  it("derives the zoom-out boundary from a 50% viewport fit and centers only near it", () => {
    expect(graphZoomOutRatio(1, { width: 400, height: 200 }, { width: 1_000, height: 800 })).toBeCloseTo(0.8);
    expect(graphZoomOutRatio(2, { width: 200, height: 100 }, { width: 1_000, height: 800 })).toBeCloseTo(0.8);
    expect(graphZoomOutRatio(1, { width: 400, height: 200 }, { width: 1_000, height: 800 }, 100)).toBeCloseTo(1);
    expect(zoomOutCenteringStrength(1, 4)).toBe(0);
    expect(zoomOutCenteringStrength(3.8, 4)).toBeGreaterThan(0.9);
    expect(zoomOutCenteringStrength(4, 4)).toBe(1);
  });
});

describe("graph wheel event ownership", () => {
  it("stops the native event before Sigma can start its default zoom animation", () => {
    const event = { preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    captureGraphWheelEvent(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });
});
