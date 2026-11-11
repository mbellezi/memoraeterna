/**
 * Which frame a surface reports its state from, and when it is in the state. Pure over plain
 * objects (a `dataset` and numbers), so the harness reads it in the page and the tests read it
 * without a DOM.
 */
import type { ScreenMode, SurfaceKind } from "../../apps/desktop/src/renderer/workspace/surfaces";
import { evidenceReasons, type Evidence } from "./evidence";

export type FrameSource = "own" | "harness" | "none";

/** What the check reads of an element: its `data-*` attributes. */
export interface FrameNode {
  dataset: {
    surface?: string | undefined;
    state?: string | undefined;
    harness?: string | undefined;
  };
}

export interface FrameReading {
  frame: FrameSource;
  reasons: string[];
  state: string | null;
}

/**
 * `frames` are the elements that carry `data-surface`, `stand` is the harness's own wrapper. A frame
 * the surface renders itself (a panel inside `PanelFrame`) wins, and a disagreement with the
 * expected surface or state fails. Only a hosted screen (an existing screen the shell hosts, which
 * has no frame yet) may be labelled by the stand-in; every other kind of surface must render its own
 * frame, or no frame is a failure and the stand-in never decides for it.
 */
export function resolveFrame(
  frames: readonly FrameNode[],
  stand: FrameNode | null,
  id: string,
  mode: ScreenMode,
  kind: SurfaceKind
): FrameReading {
  const own = frames.find((element) => element.dataset.harness === undefined);
  if (own) {
    const reasons: string[] = [];
    if (own.dataset.surface !== id)
      reasons.push(`frame says surface ${own.dataset.surface ?? ""}, expected ${id}`);
    const state = own.dataset.state ?? null;
    if (state !== mode) reasons.push(`frame says state ${state ?? "none"}, expected ${mode}`);
    return { frame: "own", reasons, state };
  }
  if (kind !== "hosted")
    return {
      frame: "none",
      reasons: [`a ${kind} surface renders no frame of its own`],
      state: null
    };
  if (!stand) return { frame: "none", reasons: ["no frame"], state: null };
  stand.dataset.surface = id;
  stand.dataset.state = mode;
  return { frame: "harness", reasons: [], state: mode };
}

export interface StateReading {
  mode: ScreenMode;
  /** An object panel: its success state shows the path ribbon. */
  ribbon: boolean;
  ribbonShown: boolean;
  frame: FrameReading;
  evidence: Evidence;
  /** The stand-in wrapper still holds the page. */
  mounted: boolean;
  missing: readonly string[];
}

/** Every reason the surface is not (yet) in the state; empty when it is. */
export function stateReasons(reading: StateReading): string[] {
  const { mode } = reading;
  const reasons = [...reading.frame.reasons];
  if (reading.frame.frame !== "none" && reading.mounted)
    reasons.push(...evidenceReasons(mode, reading.evidence));
  if (mode === "success" && reading.ribbon && !reading.ribbonShown)
    reasons.push("an object panel shows no path ribbon in success");
  if ((mode === "success" || mode === "empty") && reading.missing.length > 0)
    reasons.push(`no fixture for ${reading.missing.join(", ")}`);
  return reasons;
}

export interface Wait {
  timeoutMs: number;
  pollMs: number;
  settleMs: number;
}

/**
 * Polls `check` until it has no reasons (or the time is up). A surface that is right is checked
 * once more after `settleMs`, because a surface that is right and then flips (a late failure) is
 * not in the state.
 */
export async function untilState<T extends { reasons: string[] }>(
  check: () => T,
  sleep: (ms: number) => Promise<void>,
  wait: Wait
): Promise<T> {
  let last = check();
  for (let waited = 0; last.reasons.length > 0 && waited < wait.timeoutMs; waited += wait.pollMs) {
    await sleep(wait.pollMs);
    last = check();
  }
  if (last.reasons.length === 0) {
    await sleep(wait.settleMs);
    last = check();
  }
  return last;
}

/** A short signature of the text a surface shows (not a secret; it only tells two states apart). */
export function textSignature(text: string): string {
  let hash = 5381;
  const normalized = text.replace(/\s+/gu, " ").trim();
  for (let index = 0; index < normalized.length; index += 1)
    hash = ((hash * 33) ^ normalized.charCodeAt(index)) >>> 0;
  return `${normalized.length}:${hash.toString(16)}`;
}
