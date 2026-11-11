import { initialState, workspaceStateVersion, type WorkspaceState } from "./state";

/**
 * The workspace layout is a per-device convenience kept in `localStorage` (docs/f5-decisions.md
 * D8): never in settings, backups or the database. Every read and write is best effort; a missing,
 * unreadable or invalid value starts from the defaults.
 */

/** `memora.workspace.v1`: a device-local layout key, not a setting (D8), versioned with its shape. */
export const workspaceStorageKey = `memora.workspace.v${workspaceStateVersion}`;
/** At most one write per this many milliseconds (cal.). */
export const workspaceSaveDelayMs = 500;

/** The part of `Storage` the workspace uses, so tests need no DOM. */
export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): WorkspaceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored value parsed as JSON, or null when there is none or it cannot be read. */
export function readPersistedWorkspace(
  storage: WorkspaceStorage | null = browserStorage()
): unknown {
  try {
    const raw = storage?.getItem(workspaceStorageKey);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** The state to start from: the stored one under the Home rule, or the defaults. */
export function loadWorkspace(
  now: Date = new Date(),
  storage: WorkspaceStorage | null = browserStorage(),
  options: { timeZone?: string } = {}
): WorkspaceState {
  return initialState(now, readPersistedWorkspace(storage), options);
}

/** Writes the state now; false when the storage refuses it (full, blocked or missing). */
export function saveWorkspace(
  state: WorkspaceState,
  storage: WorkspaceStorage | null = browserStorage()
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(workspaceStorageKey, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export interface WorkspaceSaver {
  /** Remembers `state` and writes it within the save delay; later calls replace it. */
  save(state: WorkspaceState): void;
  /** Writes the pending state now (on unload). */
  flush(): void;
  /** Drops the pending write. */
  cancel(): void;
}

export interface WorkspaceSaverOptions {
  storage?: WorkspaceStorage | null;
  delayMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Saves on change at most once per `delayMs`, always the latest state. One timer, no polling. */
export function createWorkspaceSaver(options: WorkspaceSaverOptions = {}): WorkspaceSaver {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const delayMs = options.delayMs ?? workspaceSaveDelayMs;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let pending: WorkspaceState | null = null;
  let timer: unknown = null;

  const flush = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (pending === null) return;
    const state = pending;
    pending = null;
    saveWorkspace(state, storage);
  };

  return {
    save(state) {
      pending = state;
      if (timer === null) timer = setTimer(flush, delayMs);
    },
    flush,
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
    }
  };
}
