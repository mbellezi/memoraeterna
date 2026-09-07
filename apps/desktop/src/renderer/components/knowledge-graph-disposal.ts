import type Sigma from "sigma";

/** Stop Sigma immediately, but let the compositor retire its removed canvases before context loss. */
export function disposeConnectionGraphRenderer(renderer: Pick<Sigma, "getCanvases" | "kill">): void {
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
    for (const extension of extensions.keys()) extension.loseContext = () => { pending.add(extension); };
    renderer.kill();
  } finally {
    for (const [extension, loseContext] of extensions) extension.loseContext = loseContext;
    if (pending.size > 0) releaseAfterPaint(() => {
      for (const extension of pending) extension.loseContext();
      pending.clear();
    });
  }
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
