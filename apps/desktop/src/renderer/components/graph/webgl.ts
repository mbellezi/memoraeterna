/** The part of a canvas the probe uses, so a test needs no DOM. */
export interface ProbeCanvas {
  getContext(type: string): unknown;
}

/**
 * Whether this window can draw WebGL (a GPU blocklist, a remote session or a sandbox can refuse
 * it). Sigma throws when it cannot get a context; probing first lets a view fall back to its text
 * alternative before a renderer, a worker or a layout is built. The probe's context is released.
 */
export function isWebGLAvailable(
  createCanvas: () => ProbeCanvas = () => document.createElement("canvas")
): boolean {
  try {
    const canvas = createCanvas();
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!context) return false;
    (context as { getExtension?: (name: string) => { loseContext?: () => void } | null })
      .getExtension?.("WEBGL_lose_context")
      ?.loseContext?.();
    return true;
  } catch {
    return false;
  }
}
