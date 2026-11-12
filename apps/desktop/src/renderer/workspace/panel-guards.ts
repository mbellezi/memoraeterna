import { reduce, type WorkspaceAction, type WorkspaceState } from "./state";

/**
 * Leaving a panel that holds unsaved work. A panel that can hold a draft (the Note panel's edit)
 * registers a guard under its key; the workspace's dispatch asks every guard whose panel the action
 * would unmount, before the action runs. An action unmounts a panel when it closes it, when it
 * changes the address it shows (Back, Forward, a redirect), and when the layout folds it into a
 * spine (a panel is drawn only while it is full or compact). A panel that stays mounted, whatever
 * its mode, keeps its draft and is never asked.
 */

/** Asks, if there is something to lose, then calls `go`; with nothing to lose it calls `go` now. */
export type LeaveGuard = (go: () => void) => void;

/** The key of a panel in the host (its destination and its id). */
export const panelKey = (destination: string, panelId: string): string =>
  `${destination}:${panelId}`;

const guards = new Map<string, LeaveGuard>();
/** The keys of the panels drawn (full or compact) for a workspace state; the host sets it. */
type DrawnProbe = (state: WorkspaceState) => ReadonlySet<string>;
let probe: DrawnProbe | null = null;

/** Registers (or, with null, removes) the guard of the panel with this key. */
export function setPanelGuard(key: string, guard: LeaveGuard | null): void {
  if (guard) guards.set(key, guard);
  else guards.delete(key);
}

/** The host tells how a state would be laid out; returns the function that withdraws it. */
export function setDrawnProbe(next: DrawnProbe): () => void {
  probe = next;
  return () => {
    if (probe === next) probe = null;
  };
}

const addressOf = (state: WorkspaceState, destination: string, panelId: string): string | null => {
  if (destination === "settings" || !(destination in state.stacks)) return null;
  const panel = state.stacks[destination as keyof WorkspaceState["stacks"]].panels.find(
    (entry) => entry.id === panelId
  );
  return panel ? (panel.history[panel.index] ?? "") : null;
};

/** The guards of the panels that `next` would unmount, relative to `state`. */
export function guardsAtRisk(state: WorkspaceState, next: WorkspaceState): LeaveGuard[] {
  if (guards.size === 0 || state === next) return [];
  let drawnBefore: ReadonlySet<string> | null = null;
  let drawnAfter: ReadonlySet<string> | null = null;
  const risky: LeaveGuard[] = [];
  for (const [key, guard] of guards) {
    const at = key.indexOf(":");
    const destination = key.slice(0, at);
    const panelId = key.slice(at + 1);
    const before = addressOf(state, destination, panelId);
    if (before === null) continue;
    const after = addressOf(next, destination, panelId);
    if (after === null || after !== before) {
      risky.push(guard);
      continue;
    }
    // Still there at the same address: unmounted only when its layout folds it into a spine, and
    // only the stack on screen changes its layout.
    if (state.destination !== destination || next.destination !== destination || !probe) continue;
    drawnBefore ??= probe(state);
    drawnAfter ??= probe(next);
    if (drawnBefore.has(key) && !drawnAfter.has(key)) risky.push(guard);
  }
  return risky;
}

/** Runs the guards one after the other; `proceed` runs when every one let the move go. */
export function runGuards(list: readonly LeaveGuard[], proceed: () => void): void {
  const [first, ...rest] = list;
  if (!first) proceed();
  else first(() => runGuards(rest, proceed));
}

/** `dispatch` that asks the panels with unsaved work first. `current` reads the state of the moment. */
export function guardDispatch(
  current: { current: WorkspaceState },
  dispatch: (action: WorkspaceAction) => void
): (action: WorkspaceAction) => void {
  return (action) => {
    const state = current.current;
    const next = reduce(state, action);
    runGuards(guardsAtRisk(state, next), () => {
      // A move that follows in the same tick (a link's "go", then "open") reads this one's result.
      current.current = reduce(current.current, action);
      dispatch(action);
    });
  };
}
