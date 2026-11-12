import { useEffect, useState } from "react";

import { writerFixtures } from "../add/add-screen-fixtures";
import type { ScreenModule } from "../surfaces";
import { FramedImport } from "./import-screen-frame";
import { kind } from "./import.panel";
import { sourceFixtureAddress, sourcePanelFixtures } from "./source/source-panel-fixtures";

export const surface = kind;

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

export const fixtures: ScreenModule["fixtures"] = {
  // The first-time path opens the wizard at Origem; the screen finds the stored source (the edit
  // address) only to tell this state from the ones below.
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
 * Whether the source to edit can be read, for the screen only: a new import has neither an empty
 * nor an error state of its own (it opens with the metadata lookup off when the settings cannot be
 * read). So the screen shows the edit address when the source is gone or cannot be read, and the
 * new import otherwise (loading reads the same on either).
 */
function useScreenAddress(): string {
  const [address, setAddress] = useState(newAddress);
  useEffect(() => {
    let live = true;
    void window.app.knowledge
      .getSourceDetail(sourceId)
      .then((source) => live && source === null && setAddress(editAddress))
      .catch(() => live && setAddress(editAddress));
    return () => {
      live = false;
    };
  }, []);
  return address;
}

function ImportScreen() {
  return <FramedImport surface={surface} address={useScreenAddress()} />;
}

export function render() {
  return <ImportScreen />;
}
