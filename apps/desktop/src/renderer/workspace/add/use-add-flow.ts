import { useState, useSyncExternalStore } from "react";

import { useStableCallback } from "../../lib/stable-callback";
import { AddFlow, type AddFlowSnapshot } from "./add-flow";

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The app's one Add flow: it lives as long as the window, reads through `window.app`, and calls
 * the app back to show a Source or the import panel. The callbacks may change every render; the
 * flow does not.
 */
export function useAddFlow(callbacks: {
  openSource: (sourceItemId: string) => void;
  openImportPanel: () => void;
}): AddFlow {
  const openSource = useStableCallback(callbacks.openSource);
  const openImportPanel = useStableCallback(callbacks.openImportPanel);
  const [flow] = useState(
    () =>
      new AddFlow({
        api: () => window.app,
        openSource,
        openImportPanel,
        storage: browserStorage()
      })
  );
  return flow;
}

/** The flow's snapshot, re-read when it changes. */
export function useAddFlowSnapshot(flow: AddFlow): AddFlowSnapshot {
  return useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot);
}
