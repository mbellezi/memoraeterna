import { useEffect, useState } from "react";

import { screenTranslator } from "../screen-locale";
import type { ScreenModule } from "../surfaces";
import { AddFailureNotice } from "./AddFailureNotice";
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
  },
  // The picker fails and nothing else does: one failure, told once in the status slot. (The menu's
  // own "could not read the mode" notice is one cause of its own, tested in add-dom.test.tsx.)
  error: writerFixtures(true)
};

function newFlow() {
  return new AddFlow({
    api: () => window.app,
    openSource: noop,
    openImportPanel: noop,
    storage: null
  });
}

/** The title bar's right end: the status slot, where a failed add is told, and Adicionar. */
function Strip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-12 min-w-0 flex-1 items-start justify-end gap-3 pr-1 pt-2">
      {children}
    </div>
  );
}

/**
 * Adicionar over the window's desk. On the left, one whose file picker is used the moment it shows:
 * reading in the loading state, canceled in the others, failed in the error state, told in the
 * status slot beside the button. On the right, the menu held open (its state is the reading of the
 * mode: loading, no model ready, or all well). The first surface in the page gives the capture's
 * state, so the picker's comes first.
 */
function AddScreen() {
  const [menuFlow] = useState(newFlow);
  const [pickFlow] = useState(newFlow);
  useEffect(() => {
    void menuFlow.ensureReadiness();
    void pickFlow.pickFile();
  }, [menuFlow, pickFlow]);
  return (
    <div className="flex min-h-[560px] gap-6 bg-background">
      <Strip>
        <AddFailureNotice t={t} flow={pickFlow} />
        <AddMenu t={t} flow={pickFlow} portal={false} />
      </Strip>
      <Strip>
        <AddMenu t={t} flow={menuFlow} portal={false} openMenu />
      </Strip>
    </div>
  );
}

export function render() {
  return <AddScreen />;
}
