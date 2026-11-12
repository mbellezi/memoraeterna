import { useCallback, useEffect, useState, type CSSProperties } from "react";

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
/** What Adicionar's "Mais opções de importação…" opens: the wizard at its first step, Origem. */
const newAddress = "memora://import";
/** The Source panel's "Editar" opens this address: the wizard on that source. */
const editAddress = `memora://import?source=${sourceId}`;

const appSettings = { metadataEnrichmentEnabled: true };

/** What the wizard's suggested-metadata block answers once it has looked the title up. */
const enrichmentFixtures = {
  success: [
    {
      id: "complete-streets",
      provider: "crossref",
      title: "Complete streets: lessons from two Andean cities",
      creators: [{ name: "R. Andrade" }, { name: "L. Quispe" }],
      year: 2023,
      values: {},
      provenance: {}
    }
  ],
  empty: []
};

/** `ImportView` looks metadata up 900 ms after the title settles; the frame waits for that answer. */
const enrichmentSettleMs = 1300;

export const fixtures: ScreenModule["fixtures"] = {
  // The first-time path opens the wizard at Origem; the screen finds the stored source (the edit
  // address) only to tell this state from the one below.
  success: {
    ...sourcePanelFixtures(false),
    ...writerFixtures(true),
    "ingestion.enrichMetadata": enrichmentFixtures.success,
    "settings.getApp": appSettings
  },
  // The source to edit is gone: the panel says so and offers the Library.
  empty: {
    ...sourcePanelFixtures(true),
    ...writerFixtures(true),
    "ingestion.enrichMetadata": enrichmentFixtures.empty,
    "settings.getApp": appSettings
  }
};

/**
 * Whether the source to edit exists, for the screen only: the new import (no source) never has an
 * empty state, so the screen shows the edit address when the source is gone and the new import
 * otherwise (loading and error read the same on either).
 */
function useScreenAddress(): string {
  const [address, setAddress] = useState(newAddress);
  useEffect(() => {
    let live = true;
    void window.app.knowledge
      .getSourceDetail(sourceId)
      .then((source) => live && source === null && setAddress(editAddress))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return address;
}

/** The advanced import panel in its real frame, on the desk beside one spine. */
function FramedImport() {
  const address = useScreenAddress();
  const [reported, setState] = useState<PanelLoadState>("loading");
  // A settled form looks things up after a pause: success shows once that answer is in.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (reported !== "success") return undefined;
    const timer = window.setTimeout(() => setSettled(true), enrichmentSettleMs);
    return () => window.clearTimeout(timer);
  }, [reported]);
  const state: PanelLoadState = reported === "success" && !settled ? "loading" : reported;
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
