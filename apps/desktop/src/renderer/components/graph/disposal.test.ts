import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDisposer, disposeConnectionGraphRenderer } from "./disposal";

describe("connection graph GPU disposal", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  beforeEach(() => {
    vi.useFakeTimers();
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id)
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const paint = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  };
  const fixture = (webgl2 = true) => {
    const extensions = Array.from({ length: 3 }, () => ({
      loseContext: vi.fn(),
      restoreContext: vi.fn()
    }));
    const originalMethods = extensions.map((extension) => extension.loseContext);
    const canvases = Object.fromEntries(
      ["edges", "nodes", "hoverNodes"].map((id, index) => [
        id,
        {
          getContext: vi.fn((kind: string) =>
            kind === (webgl2 ? "webgl2" : "webgl")
              ? { getExtension: () => extensions[index] }
              : null
          )
        }
      ])
    ) as unknown as Record<string, HTMLCanvasElement>;
    const renderer = {
      getCanvases: () => canvases,
      kill: vi.fn(() => extensions.forEach((extension) => extension.loseContext()))
    };
    return { renderer, extensions, originalMethods };
  };

  it.each([true, false])(
    "stops Sigma now and loses all contexts only after a paint opportunity (WebGL2: %s)",
    (webgl2) => {
      const { renderer, extensions, originalMethods } = fixture(webgl2);
      disposeConnectionGraphRenderer(renderer);
      expect(renderer.kill).toHaveBeenCalledOnce();
      extensions.forEach((extension, index) =>
        expect(extension.loseContext).toBe(originalMethods[index])
      );
      originalMethods.forEach((lose) => expect(lose).not.toHaveBeenCalled());
      paint();
      originalMethods.forEach((lose) => expect(lose).not.toHaveBeenCalled());
      paint();
      originalMethods.forEach((lose) => expect(lose).toHaveBeenCalledOnce());
      vi.advanceTimersByTime(1000);
      originalMethods.forEach((lose) => expect(lose).toHaveBeenCalledOnce());
      expect(frames.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("releases contexts in a bounded time even when background frames stop", () => {
    const { renderer, originalMethods } = fixture();
    disposeConnectionGraphRenderer(renderer);
    paint();
    vi.advanceTimersByTime(250);
    originalMethods.forEach((lose) => expect(lose).toHaveBeenCalledOnce());
    expect(frames.size).toBe(0);
    paint();
    originalMethods.forEach((lose) => expect(lose).toHaveBeenCalledOnce());
  });

  it("does not delay an unrelated live renderer's context loss", () => {
    const retiring = fixture();
    const active = fixture();
    disposeConnectionGraphRenderer(retiring.renderer);
    active.extensions[0]!.loseContext();
    expect(active.originalMethods[0]).toHaveBeenCalledOnce();
    retiring.originalMethods.forEach((lose) => expect(lose).not.toHaveBeenCalled());
    vi.advanceTimersByTime(250);
  });

  it("restores the native methods and releases requested contexts even if Sigma cleanup throws", () => {
    const { renderer, extensions, originalMethods } = fixture();
    renderer.kill.mockImplementation(() => {
      extensions[0]!.loseContext();
      throw new Error("cleanup failed");
    });
    expect(() => disposeConnectionGraphRenderer(renderer)).toThrow("cleanup failed");
    extensions.forEach((extension, index) =>
      expect(extension.loseContext).toBe(originalMethods[index])
    );
    vi.advanceTimersByTime(250);
    expect(originalMethods[0]).toHaveBeenCalledOnce();
  });

  it("still destroys a renderer when the context-loss extension is unavailable", () => {
    const renderer = {
      getCanvases: () =>
        ({ nodes: { getContext: () => ({ getExtension: () => null }) } }) as unknown as Record<
          string,
          HTMLCanvasElement
        >,
      kill: vi.fn()
    };
    disposeConnectionGraphRenderer(renderer);
    expect(renderer.kill).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the graph disposer", () => {
  it("runs each step once, last added first, however many times it is asked", () => {
    const order: string[] = [];
    const disposer = createDisposer();
    disposer.add(() => order.push("layout"));
    disposer.add(() => order.push("listeners"));
    disposer.add(() => order.push("renderer"));
    expect(disposer.disposed).toBe(false);
    disposer.dispose();
    disposer.dispose();
    disposer.dispose();
    expect(order).toEqual(["renderer", "listeners", "layout"]);
    expect(disposer.disposed).toBe(true);
  });

  it("lets a failing step fail alone and still runs the others", () => {
    const ran: string[] = [];
    const disposer = createDisposer();
    disposer.add(() => ran.push("first"));
    disposer.add(() => {
      throw new Error("release failed");
    });
    disposer.add(() => ran.push("last"));
    expect(() => disposer.dispose()).not.toThrow();
    expect(ran).toEqual(["last", "first"]);
  });

  it("releases at once what a late setup built after the view was gone", () => {
    const disposer = createDisposer();
    disposer.dispose();
    const release = vi.fn();
    disposer.add(release);
    expect(release).toHaveBeenCalledOnce();
    disposer.dispose();
    expect(release).toHaveBeenCalledOnce();
  });
});
