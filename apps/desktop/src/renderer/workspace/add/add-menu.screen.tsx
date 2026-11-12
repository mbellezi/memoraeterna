import { useEffect, useState } from "react";

import { screenTranslator } from "../screen-locale";
import type { ScreenModule } from "../surfaces";
import { AddMenu } from "./AddMenu";
import { writerFixtures } from "./add-screen-fixtures";
import { AddFlow } from "./add-flow";

export const surface = "add-menu";

const t = screenTranslator();
const noop = () => undefined;

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    ...writerFixtures(true),
    // The picker was canceled: nothing is added and nothing is said.
    "ingestion.extractFileMetadata": null
  },
  empty: {
    ...writerFixtures(false),
    "ingestion.extractFileMetadata": null
  }
};

function newFlow() {
  return new AddFlow({
    api: () => window.app,
    openSource: noop,
    openImportPanel: noop,
    storage: null
  });
}

/** The title bar's right end, where Adicionar sits. */
function Strip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-12 min-w-0 flex-1 items-start justify-end pr-1 pt-2">{children}</div>
  );
}

/**
 * Adicionar over the window's desk: the menu open on the right (its state is the surface's state:
 * reading the mode, no model ready, the mode unreadable, or all well), and on the left a second
 * Adicionar whose file picker is used the moment it shows, so a failed add is seen in place under
 * its button. In the loading state that second one is reading; in the others the picker is canceled
 * or fails.
 */
function AddScreen() {
  const [menuFlow] = useState(newFlow);
  const [pickFlow] = useState(newFlow);
  useEffect(() => {
    void menuFlow.ensureReadiness();
    void pickFlow.pickFile();
  }, [menuFlow, pickFlow]);
  return (
    <div className="flex min-h-[560px] flex-row-reverse gap-6 bg-background">
      <Strip>
        <AddMenu t={t} flow={menuFlow} portal={false} openMenu />
      </Strip>
      <Strip>
        <AddMenu t={t} flow={pickFlow} portal={false} />
      </Strip>
    </div>
  );
}

export function render() {
  return <AddScreen />;
}
