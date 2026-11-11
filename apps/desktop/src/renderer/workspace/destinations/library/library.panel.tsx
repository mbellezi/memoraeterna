import type { Translator } from "@app/i18n";

import { LibraryRoot } from "./LibraryRoot";
import { librarySurface } from "./LibraryRoot";
import { parseViewAddress } from "../../route";
import type { PanelAddress } from "../../state";

/**
 * The Library's root as a panel module (the stack's registration shape, `PanelStack.tsx`): it takes
 * the Library's view address, so it comes before the old Library screen that the legacy panel
 * hosts for every destination whose own root has not landed yet. The stack mounts it once as the
 * root of the Library's stack and gives it the density it keeps per device.
 */

export const kind = librarySurface;

export function match(address: PanelAddress): boolean {
  return parseViewAddress(address)?.view === "library";
}

/** The root is named by its destination; the stack never asks the page for a title. */
export function title(_summary: unknown, t: Translator): string {
  return t("libraryTable.title");
}

export const Component = LibraryRoot;
