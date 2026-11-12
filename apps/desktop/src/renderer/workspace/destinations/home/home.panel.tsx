import { destinationRoots } from "../../destinations";
import type { PanelAddress } from "../../state";

/**
 * Home's root in the panel stack. The stack finds it by file (`destinations/<name>/*.panel.tsx`,
 * next to the object panels of `panels/`) and takes it for the address `memora://home`, ahead of
 * the old view that hosted Home until its own root landed.
 */
export const kind = "destination-home";

export function match(address: PanelAddress): boolean {
  return address === destinationRoots.home;
}

/** The stack names a root by its destination. */
export function title(): string {
  return "";
}

/** Home has no compact form: where it would be the previous panel it is a spine. */
export const compact = false;

export { HomeRoot as Component } from "./HomeRoot";
