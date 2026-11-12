import { useCallback, useState, type CSSProperties } from "react";

import type { RibbonPlace } from "../PathRibbon";
import { PanelFrame, type PanelLoadState } from "../PanelFrame";
import { screenTranslator } from "../screen-locale";
import { layoutCustomProperties } from "../shell-model";
import type { ScreenModule } from "../surfaces";
import { useViewportWidth } from "../use-workspace";
import { Component, kind } from "./source.panel";
import {
  sourceFixtureAddress,
  sourceFixtureTitle,
  sourcePanelFixtures
} from "./source/source-panel-fixtures";

export const surface = kind;

const t = screenTranslator();
const noop = () => undefined;

export const fixtures: ScreenModule["fixtures"] = {
  success: sourcePanelFixtures(false),
  empty: sourcePanelFixtures(true)
};

/**
 * The real Source panel in its real frame, on the desk beside one spine: the frame writes the
 * state the panel reports and draws the ribbon from `objects.locate`; the panel reads the source
 * and its strip through the fake `window.app`. The frame's surface id is this screen's.
 */
function FramedSource() {
  const [state, setState] = useState<PanelLoadState>("loading");
  const [place, setPlace] = useState<RibbonPlace>("placed");
  const [focusMode, setFocusMode] = useState(false);
  const report = useCallback((next: PanelLoadState) => setState(next), []);
  const width = useViewportWidth();
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
          address={sourceFixtureAddress}
          kind="source"
          kindLabel={t("objects.kinds.source")}
          title={sourceFixtureTitle}
          mode="full"
          top
          state={state}
          canBack={false}
          canForward={false}
          onBack={noop}
          onForward={noop}
          onClose={noop}
          focusMode={focusMode}
          onToggleFocusMode={() => setFocusMode((value) => !value)}
          onPin={noop}
          onOpen={noop}
          ribbonPlace={place}
        >
          <Component
            t={t}
            address={sourceFixtureAddress}
            mode="full"
            active
            onState={report}
            onPlace={(next) => setPlace(next.place)}
            onOpen={noop}
          />
        </PanelFrame>
      </div>
    </div>
  );
}

export function render() {
  return <FramedSource />;
}
