import { useState, type CSSProperties } from "react";

import { ContextPanel } from "./ContextPanel";
import { contextFixtures, focusedNote, panelErrorFixtures, t } from "./context/context-fixtures";
import { contextMode } from "./layout-config";
import { layoutCustomProperties } from "./shell-model";
import type { ContextTabId } from "./state";
import type { ScreenModule } from "./surfaces";
import { useViewportWidth } from "./use-workspace";

export const surface = "context-panel";

export const fixtures: ScreenModule["fixtures"] = {
  success: contextFixtures(false),
  empty: contextFixtures(true),
  error: panelErrorFixtures
};

// The panel fills the window beside a stand-in for the top panel, as the shell lays it out.
export const fullWindow = true;

const noop = () => undefined;

/**
 * The real panel beside a stand-in sheet. At 1440 px it is docked; at 960 px it is the 40 px strip
 * with its overlay open over the sheet's right edge (the capture the design record asks for).
 */
function Stage() {
  const width = useViewportWidth();
  const [tab, setTab] = useState<ContextTabId>("connections");
  const [open, setOpen] = useState(true);
  return (
    <div
      className="flex h-screen bg-background"
      style={layoutCustomProperties(width) as CSSProperties}
    >
      <div className="min-w-0 flex-1 overflow-hidden bg-surface px-8 py-6 [box-shadow:var(--shadow-sheet)]">
        <h1 className="m-0 mb-3 max-w-(--measure) font-reading text-xl font-semibold text-foreground">
          Lactic acid inhibits pathogens by lowering the pH
        </h1>
        <p className="m-0 mb-3 max-w-(--measure) font-reading text-reading text-foreground">
          When lactic acid bacteria consume the sugars of a food, the lactic acid they make drives
          the pH down to about 4. At that acidity most of the bacteria that spoil food or cause
          disease cannot multiply.
        </p>
        <p className="m-0 max-w-(--measure) font-reading text-reading text-foreground">
          That is why sauerkraut, yoghurt and pickled vegetables keep for weeks outside the fridge:
          the fermentation itself builds the barrier that protects the food.
        </p>
      </div>
      <ContextPanel
        t={t}
        focus={focusedNote}
        tab={tab}
        onTab={setTab}
        mode={contextMode(width)}
        open={open}
        onOpenChange={setOpen}
        onOpen={noop}
        onLink={noop}
      />
    </div>
  );
}

export function render() {
  return <Stage />;
}
