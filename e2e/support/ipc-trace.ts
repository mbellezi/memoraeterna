// Reads the main process's IPC trace (F5 T137, spec 3.14) from a journey. The app records it only
// when started unpackaged with `MEMORA_IPC_TRACE=1` (`launchMemora` sets it) and once T171 installs
// `M/services/dev/ipc-trace.ts` first in `M/index.ts`; before that `readIpcTrace` answers null.
import type { ElectronApplication } from "@playwright/test";

export interface IpcTraceEntry {
  channel: string;
  /** `Date.now()` in main; the renderer shares the clock. */
  at: number;
}

/** Must equal `ipcTraceGlobalKey` of `M/services/dev/ipc-trace.ts`. */
export const ipcTraceGlobalKey = "__memoraIpcTrace";

/** The channel of an Inbox verdict; must equal `ipcChannels.inboxAct`. */
export const inboxActChannel = "app:inbox:act";

interface RingLike {
  entries(): IpcTraceEntry[];
  clear(): void;
  dropped: number;
}

/** The trace, oldest first, and how many entries fell out of the ring; null when tracing is off. */
export async function readIpcTrace(
  electronApp: ElectronApplication
): Promise<{ entries: IpcTraceEntry[]; dropped: number } | null> {
  return electronApp.evaluate((_electron, key) => {
    const ring = (globalThis as unknown as Record<string, RingLike | undefined>)[key];
    return ring ? { entries: ring.entries(), dropped: ring.dropped } : null;
  }, ipcTraceGlobalKey);
}

export async function clearIpcTrace(electronApp: ElectronApplication): Promise<boolean> {
  return electronApp.evaluate((_electron, key) => {
    const ring = (globalThis as unknown as Record<string, RingLike | undefined>)[key];
    ring?.clear();
    return ring !== undefined;
  }, ipcTraceGlobalKey);
}

/**
 * The invocations no cause explains: those not preceded, within `windowMs`, by a cause (a bus
 * event or a gesture, as `Date.now()` times). J-idle (X4 b) requires none.
 */
export function uncausedInvocations(
  entries: readonly IpcTraceEntry[],
  causes: readonly number[],
  windowMs = 1_000
): IpcTraceEntry[] {
  const sorted = [...causes].sort((a, b) => a - b);
  return entries.filter((entry) => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sorted[middle]! <= entry.at) low = middle + 1;
      else high = middle;
    }
    const latest = low > 0 ? sorted[low - 1]! : undefined;
    return latest === undefined || entry.at - latest > windowMs;
  });
}
