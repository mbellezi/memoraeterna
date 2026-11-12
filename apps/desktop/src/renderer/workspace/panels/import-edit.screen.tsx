import { useCallback } from "react";

import { writerFixtures } from "../add/add-screen-fixtures";
import type { ScreenModule } from "../surfaces";
import { FramedImport } from "./import-screen-frame";
import { importScrollViewport } from "./import-scroller";
import { sourceFixtureAddress, sourcePanelFixtures } from "./source/source-panel-fixtures";

export const surface = "import-edit";

const sourceId = sourceFixtureAddress.replace("memora://source/", "");
/** The Source panel's "Editar" opens this address: the wizard on that source. */
const editAddress = `memora://import?source=${sourceId}`;

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    ...sourcePanelFixtures(false),
    ...writerFixtures(true),
    "ingestion.enrichMetadata": [],
    "settings.getApp": { metadataEnrichmentEnabled: true }
  },
  // The source to edit is gone: the panel says so and offers the Library.
  empty: {
    ...sourcePanelFixtures(true),
    ...writerFixtures(true),
    "ingestion.enrichMetadata": [],
    "settings.getApp": { metadataEnrichmentEnabled: true }
  }
};

/**
 * The wizard on a stored source (the Source panel's "Editar"), scrolled to the end of its form so a
 * capture shows the footer on the panel's bottom edge and the scroll bar at the panel's side.
 */
function ImportEditScreen() {
  const scrollToEnd = useCallback(() => {
    const viewport = importScrollViewport(document);
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, []);
  return <FramedImport surface={surface} address={editAddress} onSettled={scrollToEnd} />;
}

export function render() {
  return <ImportEditScreen />;
}
