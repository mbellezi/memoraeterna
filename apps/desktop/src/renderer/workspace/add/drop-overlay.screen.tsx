import { useEffect, useState } from "react";

import { fixtures as shellFixtures, render as renderShell } from "../Shell.screen";
import { screenTranslator } from "../screen-locale";
import type { ScreenModule } from "../surfaces";
import { DropOverlay } from "./DropOverlay";
import { writerFixtures } from "./add-screen-fixtures";
import { AddFlow } from "./add-flow";
import { useAddFlowSnapshot } from "./use-add-flow";

export const surface = "drop-overlay";

/** The overlay is fixed over the window: the capture is the window, so it is the whole window's width. */
export const fullWindow = true;

const t = screenTranslator();
const noop = () => undefined;

export const fixtures: ScreenModule["fixtures"] = {
  success: { ...shellFixtures.success, ...writerFixtures(true) },
  empty: { ...shellFixtures.empty, ...writerFixtures(false) }
};

/**
 * Two files over the shell (the real shell is the window under the overlay). The browser hides the
 * names of a drag, so the card counts. The mode it reports is the one the flow reads, as in the app.
 */
function DropScreen() {
  const [flow] = useState(
    () =>
      new AddFlow({
        api: () => window.app,
        openSource: noop,
        openImportPanel: noop,
        storage: null
      })
  );
  const snapshot = useAddFlowSnapshot(flow);
  useEffect(() => {
    void flow.ensureReadiness();
  }, [flow]);
  return (
    <>
      <DropOverlay t={t} count={2} mode={snapshot.mode} readiness={snapshot.readiness} />
      {renderShell()}
    </>
  );
}

export function render() {
  return <DropScreen />;
}
