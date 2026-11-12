import type { Translator } from "@app/i18n";

import { parseViewAddress } from "../../route";
import { destinationTitleKeys } from "../../shell-model";
import { InboxRoot, surfaceId } from "./InboxRoot";

/**
 * The Inbox's registration in the panel stack: the stack finds the files of each destination's
 * folder that end in `.panel.tsx`, beside the object panels, so the destination takes its root
 * surface with no registry to edit. The root is not a panel: the stack draws it without a frame.
 */

export const kind = surfaceId;

export function match(address: string): boolean {
  return parseViewAddress(address)?.view === "inbox";
}

export function title(_summary: unknown, t: Translator): string {
  return t(destinationTitleKeys.inbox);
}

export const Component = InboxRoot;
