import { useEffect } from "react";
import { isDestinationId, type DestinationId } from "../destinations";
import type { PanelProps } from "../PanelStack";
import { parseViewAddress } from "../route";
import { legacyHostFor } from "../shell-model";
import type { PanelAddress } from "../state";
import { HostedLegacyView, hostedLegacyView } from "./legacy-views";

/**
 * The legacy root (D6): a destination whose own root has not landed yet shows the old view it
 * hosts (`legacyHostFor`): Explore the Wiki, Home and the Library the Library, the Inbox its
 * screen and the Map the knowledge graph. It lives outside `panels/` so the glob never registers
 * it as an object panel; the app adds it to the stack's registry, after the real panels, so a card
 * that brings a destination's root takes that destination first.
 */

/** The destination a root view address names, or null. */
function destinationOf(address: PanelAddress): DestinationId | null {
  const view = parseViewAddress(address);
  return view && isDestinationId(view.view) ? view.view : null;
}

export const kind = "legacy";

export function match(address: PanelAddress): boolean {
  return destinationOf(address) !== null;
}

/** The stack names a root by its destination; the old view has no title of its own. */
export function title(): string {
  return "";
}

/** Home and the Library share one Library: the old view keeps one history and one target. */
export function rootKey(address: PanelAddress): string {
  const destination = destinationOf(address);
  return destination ? `legacy:${legacyHostFor[destination]}` : `legacy:${address}`;
}

/** An old view has no compact form: where it would be the previous panel it is a spine. */
export const compact = false;

export function Component({ address, active, onState }: PanelProps) {
  const destination = destinationOf(address);
  useEffect(() => {
    onState("success");
  }, [onState]);
  if (!destination) return null;
  return <HostedLegacyView view={hostedLegacyView[legacyHostFor[destination]]} active={active} />;
}
