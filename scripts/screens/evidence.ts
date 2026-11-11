/**
 * What the DOM shows, in the terms the four states are told apart by. Pure over a DOM subtree, so
 * the harness reads it in the page and the tests read it over plain numbers.
 */
import type { ScreenMode } from "../../apps/desktop/src/renderer/workspace/surfaces";

/** What the DOM shows, in the terms the four states are told apart by. */
export interface Evidence {
  alerts: number;
  busy: number;
  /** A status region the person sees (a screen-reader-only live region does not count). */
  statuses: number;
  text: number;
}

export function readEvidence(root: Element): Evidence {
  const visible = (element: Element) => !element.classList.contains("sr-only");
  return {
    alerts: [...root.querySelectorAll('[role="alert"]')].filter(visible).length,
    busy: root.querySelectorAll('[aria-busy="true"]').length,
    statuses: [...root.querySelectorAll('[role="status"]')].filter(visible).length,
    text: (root as HTMLElement).innerText.trim().length
  };
}

/** The reasons a surface is not in `mode` given what the DOM shows; empty when it is. */
export function evidenceReasons(mode: ScreenMode, evidence: Evidence): string[] {
  const reasons: string[] = [];
  if (mode === "loading") {
    if (evidence.alerts > 0) reasons.push("loading shows an alert");
    if (evidence.busy === 0 && evidence.statuses === 0)
      reasons.push("loading shows no busy or status region");
  } else if (mode === "error") {
    if (evidence.alerts === 0) reasons.push("error shows no alert");
  } else {
    if (evidence.alerts > 0) reasons.push(`${mode} shows an alert`);
    if (evidence.busy > 0) reasons.push(`${mode} is still busy`);
    if (evidence.text === 0) reasons.push(`${mode} shows no text`);
  }
  return reasons;
}
