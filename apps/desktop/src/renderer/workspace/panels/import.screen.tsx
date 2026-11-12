import { useCallback, useState, type CSSProperties } from "react";

import { writerFixtures } from "../add/add-screen-fixtures";
import { PanelFrame, type PanelLoadState } from "../PanelFrame";
import { screenTranslator } from "../screen-locale";
import { layoutCustomProperties } from "../shell-model";
import type { ScreenModule } from "../surfaces";
import { useViewportWidth } from "../use-workspace";
import { Component, kind } from "./import.panel";
import { sourceFixtureAddress, sourcePanelFixtures } from "./source/source-panel-fixtures";

export const surface = kind;

const t = screenTranslator();
const noop = () => undefined;

const sourceId = sourceFixtureAddress.replace("memora://source/", "");
/** The Source panel's "Editar" opens this address: the wizard on that source. */
const address = `memora://import?source=${sourceId}`;

const appSettings = { metadataEnrichmentEnabled: true };

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    ...sourcePanelFixtures(false),
    ...writerFixtures(true),
    "settings.getApp": appSettings
  },
  // The source to edit is gone: the panel says so and offers the Library.
  empty: {
    ...sourcePanelFixtures(true),
    ...writerFixtures(true),
    "settings.getApp": appSettings
  }
};

/** The advanced import panel in its real frame, on the desk beside one spine. */
function FramedImport() {
  const [state, setState] = useState<PanelLoadState>("loading");
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
          address={address}
          kind={null}
          kindLabel={t("addFlow.importPanel.title")}
          title={t("addFlow.importPanel.title")}
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
          onOpen={noop}
        >
          <Component
            t={t}
            address={address}
            mode="full"
            active
            onState={report}
            onPlace={noop}
            onOpen={noop}
          />
        </PanelFrame>
      </div>
    </div>
  );
}

export function render() {
  return <FramedImport />;
}
