import type Sigma from "sigma";

/** Stop Sigma immediately, but let the compositor retire its removed canvases before context loss. */
export function disposeConnectionGraphRenderer(
  renderer: Pick<Sigma, "getCanvases" | "kill">
): void {
  const extensions = new Map<WEBGL_lose_context, WEBGL_lose_context["loseContext"]>();
  const pending = new Set<WEBGL_lose_context>();
  // These are the WebGL layers created by Sigma 3; other layers are 2D canvases.
  const canvases = renderer.getCanvases();
  for (const id of ["edges", "nodes", "hoverNodes"]) {
    const canvas = canvases[id];
    if (!canvas) continue;
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const extension = gl?.getExtension("WEBGL_lose_context");
    if (!extension || extensions.has(extension)) continue;
    extensions.set(extension, extension.loseContext);
  }
  try {
    // Sigma has no option to separate kill() from forced context loss. Intercept
    // only these renderer-owned extension objects, only during its synchronous kill.
    for (const extension of extensions.keys())
      extension.loseContext = () => {
        pending.add(extension);
      };
    renderer.kill();
  } finally {
    for (const [extension, loseContext] of extensions) extension.loseContext = loseContext;
    if (pending.size > 0)
      releaseAfterPaint(() => {
        for (const extension of pending) extension.loseContext();
        pending.clear();
      });
  }
}

/** The part of a canvas that setup cleanup uses, so a test needs no DOM. */
export interface RendererLayer {
  getContext?(type: string): unknown;
  remove(): void;
}

/** The part of the element a renderer draws into that setup cleanup uses. */
export interface RendererContainer {
  readonly children: ArrayLike<RendererLayer>;
}

/**
 * Builds a renderer, or leaves the container as it found it. Sigma 3 puts its canvases, with their
 * WebGL contexts, into the container before it builds its programs, so a constructor that throws (a
 * shader it refuses, a context the GPU would not give) hands back no renderer to kill and leaves
 * those layers behind, each holding a context until Chromium's cap starts dropping other graphs'.
 * The layers added since the call are released (context lost first, then removed) and the error
 * goes on to the caller. A renderer that was built is the caller's to dispose.
 */
export function constructRenderer<R>(container: RendererContainer, construct: () => R): R {
  const before = new Set<RendererLayer>(Array.from(container.children));
  try {
    return construct();
  } catch (error) {
    for (const layer of Array.from(container.children)) {
      if (before.has(layer)) continue;
      try {
        const gl = (layer.getContext?.("webgl2") ?? layer.getContext?.("webgl")) as {
          getExtension?: (name: string) => { loseContext?: () => void } | null;
        } | null;
        gl?.getExtension?.("WEBGL_lose_context")?.loseContext?.();
      } catch {
        // A layer that cannot give its context back is still removed.
      }
      layer.remove();
    }
    throw error;
  }
}

/**
 * `constructRenderer`, and the renderer's disposal registered the moment it exists, so whatever a
 * later setup step throws, the disposer still kills the renderer (and the window listener Sigma
 * added). The disposer runs it last, after the listeners and workers added since.
 */
export function buildRenderer<R extends Pick<Sigma, "getCanvases" | "kill">>(
  container: RendererContainer,
  disposer: Pick<ReturnType<typeof createDisposer>, "add">,
  construct: () => R
): R {
  const renderer = constructRenderer(container, construct);
  disposer.add(() => disposeConnectionGraphRenderer(renderer));
  return renderer;
}

function releaseAfterPaint(release: () => void): void {
  let frame: number | null = null;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    window.clearTimeout(fallback);
    release();
  };
  // Background/minimized windows may not receive animation frames.
  const fallback = window.setTimeout(finish, 250);
  frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(finish);
  });
}

/**
 * Teardown that runs once. Steps run in the reverse order they were added, each isolated from the
 * others' failures, and a step added after disposal runs at once (an asynchronous setup that
 * finished after its view unmounted still releases what it just built). `dispose` is safe to call
 * from several places: a React cleanup, a failed setup, a retry.
 */
export function createDisposer() {
  const steps: Array<() => void> = [];
  let disposed = false;
  const run = (step: () => void) => {
    try {
      step();
    } catch {
      // One failing release must not keep the others from running.
    }
  };
  return {
    get disposed() {
      return disposed;
    },
    add(step: () => void): void {
      if (disposed) run(step);
      else steps.push(step);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const step of steps.splice(0).reverse()) run(step);
    }
  };
}
