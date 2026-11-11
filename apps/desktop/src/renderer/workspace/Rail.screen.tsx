import type { CSSProperties } from "react";
import { createTranslator } from "@app/i18n";

import { inboxCounts } from "../components/activity/activity-fixtures";
import { ConnectedRail } from "./Rail";
import { layoutCustomProperties } from "./shell-model";
import type { ScreenModule } from "./surfaces";

export const surface = "rail";

const t = createTranslator("en");
const noop = () => undefined;

export const fixtures: ScreenModule["fixtures"] = {
  success: { "inbox.counts": inboxCounts(3) },
  empty: { "inbox.counts": inboxCounts(0) }
};

/** The rail on its own, with the custom properties the shell would write for this window. */
export function render() {
  return (
    <div
      className="h-screen bg-background text-foreground"
      style={layoutCustomProperties(window.innerWidth) as CSSProperties}
    >
      <ConnectedRail t={t} place="explore" onGo={noop} onOpenLegacy={noop} />
    </div>
  );
}
