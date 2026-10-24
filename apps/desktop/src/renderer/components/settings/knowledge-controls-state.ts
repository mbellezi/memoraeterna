// The state of Settings › Knowledge's six controls (F4 D13, T98) as a pure reducer, so the screen's
// loading, error and saving behaviour is tested in node. The controls always have values (every
// field has its default), so there is no empty state: a library nobody configured shows the
// defaults. A change shows at once and is saved in the order it was made; one that fails puts the
// last saved value back and says so.
import {
  defaultGardenerConfig,
  type KnowledgeControls,
  type KnowledgeControlsUpdate
} from "@app/domain";

export type KnowledgeControlsState =
  | { phase: "loading" }
  | { phase: "error" }
  | {
      phase: "ready";
      /** What the main process holds. */
      saved: KnowledgeControls;
      /** What the screen shows: the saved controls with the changes still being saved. */
      shown: KnowledgeControls;
      /** Changes sent and not answered yet. */
      saving: number;
      /** How the last save ended; cleared by the next change. */
      outcome: "idle" | "saved" | "failed";
    };

export type KnowledgeControlsAction =
  | { type: "loaded"; controls: KnowledgeControls }
  | { type: "loadFailed" }
  | { type: "retry" }
  | { type: "edit"; change: KnowledgeControlsUpdate }
  | { type: "saved"; controls: KnowledgeControls }
  | { type: "saveFailed" };

export const initialKnowledgeControlsState: KnowledgeControlsState = { phase: "loading" };

/** The controls with a change laid over them; a field the change does not name stays. */
function withChange(controls: KnowledgeControls, change: KnowledgeControlsUpdate) {
  const next: Record<string, unknown> = { ...controls };
  for (const [key, value] of Object.entries(change)) if (value !== undefined) next[key] = value;
  return next as unknown as KnowledgeControls;
}

export function knowledgeControlsReducer(
  state: KnowledgeControlsState,
  action: KnowledgeControlsAction
): KnowledgeControlsState {
  switch (action.type) {
    case "loaded":
      return {
        phase: "ready",
        saved: action.controls,
        shown: action.controls,
        saving: 0,
        outcome: "idle"
      };
    case "loadFailed":
      return { phase: "error" };
    case "retry":
      return state.phase === "error" ? { phase: "loading" } : state;
    case "edit":
      if (state.phase !== "ready") return state;
      return {
        ...state,
        shown: withChange(state.shown, action.change),
        saving: state.saving + 1,
        outcome: "idle"
      };
    case "saved": {
      if (state.phase !== "ready") return state;
      const saving = Math.max(0, state.saving - 1);
      // Changes still in flight keep the screen where the person put it.
      return {
        ...state,
        saved: action.controls,
        shown: saving === 0 ? action.controls : state.shown,
        saving,
        outcome: "saved"
      };
    }
    case "saveFailed": {
      if (state.phase !== "ready") return state;
      const saving = Math.max(0, state.saving - 1);
      return {
        ...state,
        shown: saving === 0 ? state.saved : state.shown,
        saving,
        outcome: "failed"
      };
    }
  }
}

/** The highest monthly cap that can be set. */
export const monthlyCapMaxUsd = defaultGardenerConfig.controls.monthlyCapMaxUsd;

/**
 * A cap typed by the person, in dollars and cents, or null when it is not a number. A comma counts
 * as the decimal mark; a value outside the range is brought into it.
 */
export function parseMonthlyCapInput(text: string, max: number = monthlyCapMaxUsd): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/u.test(normalized)) return null;
  const value = Math.round(Number(normalized) * 100) / 100;
  return Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : null;
}

/** Reads the controls and says how it went, as the action the reducer takes. */
export async function readKnowledgeControls(
  get: () => Promise<KnowledgeControls>
): Promise<KnowledgeControlsAction> {
  try {
    return { type: "loaded", controls: await get() };
  } catch {
    return { type: "loadFailed" };
  }
}

/**
 * Saves each change in the order it was made: the screen shows it at once (`edit`), the answer of
 * main replaces it (`saved`), and a failure puts the last saved value back (`saveFailed`) without
 * stopping the changes behind it. The returned promise settles when that change is done.
 */
export function createKnowledgeControlsSaver(
  update: (change: KnowledgeControlsUpdate) => Promise<KnowledgeControls>,
  dispatch: (action: KnowledgeControlsAction) => void
): (change: KnowledgeControlsUpdate) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (change) => {
    dispatch({ type: "edit", change });
    tail = tail.then(async () => {
      try {
        dispatch({ type: "saved", controls: await update(change) });
      } catch {
        dispatch({ type: "saveFailed" });
      }
    });
    return tail;
  };
}
