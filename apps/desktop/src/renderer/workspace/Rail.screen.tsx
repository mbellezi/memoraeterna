import type { CSSProperties } from "react";

import { inboxCounts } from "../components/activity/activity-fixtures";
import { ConnectedRail } from "./Rail";
import { layoutCustomProperties } from "./shell-model";
import { screenTranslator } from "./screen-locale";
import type { ScreenModule } from "./surfaces";

/** The shell and the rail fill the window: the screens tool shows them edge to edge. */
export const fullWindow = true;

export const surface = "rail";

const t = screenTranslator();
const noop = () => undefined;

export const fixtures: ScreenModule["fixtures"] = {
  success: { "inbox.counts": inboxCounts(3) },
  empty: { "inbox.counts": inboxCounts(0) }
};

/** The rail on its own (Biblioteca, its widest word, is current), with the custom properties the shell would write. */
export function render() {
  return (
    <div
      className="h-screen bg-background text-foreground"
      style={layoutCustomProperties(window.innerWidth) as CSSProperties}
    >
      <ConnectedRail t={t} place="library" onGo={noop} onOpenLegacy={noop} />
    </div>
  );
}
