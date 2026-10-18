import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRenderer,
  constructRenderer,
  createDisposer,
  disposeConnectionGraphRenderer
} from "./disposal";

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

describe("a renderer that fails to be built", () => {
  /** A container that behaves like the DOM one: appending adds a child, `remove` takes it out. */
  const fakeContainer = () => {
    const children: Array<{
      getContext: (kind: string) => unknown;
      remove: () => void;
    }> = [];
    const lost: string[] = [];
    const append = (name: string, kinds: string[]) => {
      const layer = {
        getContext: (kind: string) =>
          kinds.includes(kind)
            ? { getExtension: () => ({ loseContext: () => lost.push(name) }) }
            : null,
        remove: () => {
          const at = children.indexOf(layer);
          if (at >= 0) children.splice(at, 1);
        }
      };
      children.push(layer);
      return layer;
    };
    return { container: { children }, children, lost, append };
  };

  it("leaves the container empty, with every context it made lost, and raises the error", () => {
    const { container, children, lost, append } = fakeContainer();
    // Sigma makes the layers, then its edge programs throw.
    const construct = vi.fn(() => {
      append("edges", ["webgl2"]);
      append("edgeLabels", ["2d"]);
      append("nodes", ["webgl2"]);
      append("hoverNodes", ["webgl2"]);
      throw new Error("Unsupported Sigma edge shader");
    });
    expect(() => constructRenderer(container, construct)).toThrow("Unsupported Sigma edge shader");
    expect(children).toHaveLength(0);
    expect([...lost].sort()).toEqual(["edges", "hoverNodes", "nodes"]);
  });

  it("releases a WebGL 1 context too, and a layer that cannot give its context back", () => {
    const { container, children, lost, append } = fakeContainer();
    expect(() =>
      constructRenderer(container, () => {
        append("edges", ["webgl"]);
        const broken = append("nodes", []);
        broken.getContext = () => {
          throw new Error("no context");
        };
        throw new Error("no context for the nodes");
      })
    ).toThrow("no context for the nodes");
    expect(children).toHaveLength(0);
    expect(lost).toEqual(["edges"]);
  });

  it("touches nothing that was there before, and nothing at all when the renderer was built", () => {
    const { container, children, lost, append } = fakeContainer();
    const before = append("mine", ["webgl2"]);
    expect(() =>
      constructRenderer(container, () => {
        append("edges", ["webgl2"]);
        throw new Error("failed");
      })
    ).toThrow("failed");
    expect(children).toEqual([before]);
    expect(lost).toEqual(["edges"]);

    const built = { kill: vi.fn() };
    expect(
      constructRenderer(container, () => {
        append("nodes", ["webgl2"]);
        return built;
      })
    ).toBe(built);
    expect(children).toHaveLength(2);
    expect(lost).toEqual(["edges"]);
  });

  it("registers the renderer's disposal at once, so a step that throws later still kills it", () => {
    const { container, append } = fakeContainer();
    const disposer = createDisposer();
    const order: string[] = [];
    const kill = vi.fn(() => order.push("renderer"));
    const setup = () => {
      buildRenderer(container, disposer, () => {
        append("edges", ["webgl2"]);
        return { getCanvases: () => ({}), kill } as never;
      });
      disposer.add(() => order.push("worker"));
      // The step after the renderer and the worker fails (a layout that cannot start).
      throw new Error("Layout failed");
    };
    expect(setup).toThrow("Layout failed");
    disposer.dispose();
    expect(kill).toHaveBeenCalledOnce();
    expect(order).toEqual(["worker", "renderer"]);
  });

  it("registers nothing when the renderer was not built", () => {
    const { container, children, append } = fakeContainer();
    const disposer = createDisposer();
    const add = vi.spyOn(disposer, "add");
    expect(() =>
      buildRenderer(container, disposer, () => {
        append("edges", ["webgl2"]);
        throw new Error("failed");
      })
    ).toThrow("failed");
    expect(add).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);
  });
});
