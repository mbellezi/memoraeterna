import { useCallback, useState, type CSSProperties } from "react";
import { createTranslator } from "@app/i18n";

import { fixtureAddresses, panelFixtures, StandInPage } from "./panel-screen-fixtures";
import { PanelFrame, type PanelLoadState } from "./PanelFrame";
import { layoutCustomProperties } from "./shell-model";
import type { ScreenModule } from "./surfaces";
import { useViewportWidth } from "./use-workspace";

export const surface = "panel-frame";

const t = createTranslator("en");
const noop = () => undefined;

export const fixtures: ScreenModule["fixtures"] = {
  success: panelFixtures(false),
  empty: panelFixtures(true)
};

/**
 * One top panel on the desk: the real frame around a stand-in note page, which reads its object
 * through the fake `window.app` and reports its state; the frame writes that state and its path
 * ribbon reads `objects.locate`. The frame's surface id is this screen's, so the check reads it.
 */
function FramedPanel() {
  const [state, setState] = useState<PanelLoadState>("loading");
  const [focusMode, setFocusMode] = useState(false);
  const report = useCallback((next: PanelLoadState) => setState(next), []);
  const width = useViewportWidth();
  // The top panel beside one spine, with the layout constants the shell writes.
  return (
    <div
      className="flex h-full bg-background"
      style={layoutCustomProperties(width) as CSSProperties}
    >
      <div className="w-(--spine-w) shrink-0 border-r border-border" aria-hidden="true" />
      <div className="flex min-w-0 flex-1">
        <PanelFrame
          t={t}
          surface={surface}
          address={fixtureAddresses.topNote}
          kind="note"
          kindLabel={t("objects.kinds.note")}
          title="Lactic acid inhibits pathogens by lowering the pH"
          mode="full"
          top
          state={state}
          canBack
          canForward={false}
          onBack={noop}
          onForward={noop}
          onClose={noop}
          focusMode={focusMode}
          onToggleFocusMode={() => setFocusMode((value) => !value)}
          onPin={noop}
          onOpen={noop}
        >
          <StandInPage
            t={t}
            address={fixtureAddresses.topNote}
            mode="full"
            active
            onState={report}
            onOpen={noop}
          />
        </PanelFrame>
      </div>
    </div>
  );
}

export function render() {
  return <FramedPanel />;
}
