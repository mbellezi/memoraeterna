import { useEffect } from "react";
import { parseObjectAddress } from "@app/domain";

import { useStableCallback } from "../lib/stable-callback";
import type { WorkspaceState } from "./state";

/**
 * Pinning the object of the top panel in the navigator (design record 5.4: the pin icon and
 * Cmd-D). A pin is the view history's pin: the object was recorded when its page opened, and the
 * navigator's "Pinned" lists it. The same command unpins a pinned object.
 */

interface PinApi {
  list: (input?: { limit?: number }) => Promise<{ address: string; pinned: boolean }[]>;
  setPinned: (address: string, pinned: boolean) => Promise<unknown>;
}

/** Pins `address`, or unpins it when it is pinned. Resolves with the pinned state it left. */
export async function togglePin(api: PinApi, address: string): Promise<boolean | null> {
  if (!parseObjectAddress(address)) return null;
  const entries = await api.list({ limit: 200 });
  const pinned = !(entries.find((entry) => entry.address === address)?.pinned ?? false);
  await api.setPinned(address, pinned);
  return pinned;
}

/** The pin the panel frame offers: absent for a view address, which has nothing to pin. */
export function pinOf(address: string): (() => void) | undefined {
  if (!parseObjectAddress(address)) return undefined;
  return () => {
    const api = typeof window === "undefined" ? undefined : window.app?.viewHistory;
    if (api) void togglePin(api, address).catch(() => undefined);
  };
}

/** The address of the top panel of a stack, or null when the root is on top. */
export function topAddress(workspace: WorkspaceState): string | null {
  if (workspace.destination === "settings") return null;
  const stack = workspace.stacks[workspace.destination];
  const panel = stack.panels[stack.focus];
  return panel?.history[panel.index] ?? null;
}

const editable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Cmd-D pins or unpins the top panel's object (never in a text field). */
export function usePinShortcut(workspace: WorkspaceState): void {
  const toggle = useStableCallback(() => {
    const address = topAddress(workspace);
    if (address) pinOf(address)?.();
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || editable(event.target)) return;
      if (!event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return;
      if (event.code !== "KeyD") return;
      event.preventDefault();
      toggle();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toggle]);
}
