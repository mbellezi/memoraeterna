import { useCallback, useEffect, useMemo, useState } from "react";
import { formatObjectAddress, parseObjectAddress } from "@app/domain";

import { viewHistoryPinLimitMessage } from "../../shared/view-history";
import { noteHostAddress } from "../components/topics/topic-actions";
import { useStableCallback } from "../lib/stable-callback";
import type { WorkspaceState } from "./state";

/**
 * Pinning the object of the top panel in the navigator (design record 5.4: the pin icon and
 * Cmd-D). A pin is the view history's pin: the object was recorded when its page opened, and the
 * navigator's "Pinned" lists it. The same command unpins a pinned object. The history names an
 * object, never a place inside it, so a panel whose address carries an anchor (a cited passage)
 * pins its object.
 */

interface PinEntry {
  address: string;
  pinned: boolean;
}

/** The part of `window.app.viewHistory` the pin needs. */
export interface PinApi {
  list: (input?: { limit?: number }) => Promise<PinEntry[]>;
  setPinned: (address: string, pinned: boolean) => Promise<unknown>;
  record: (input: {
    kind: "source" | "note" | "topic" | "question" | "entity";
    id: string;
    title: string;
    parentAddress?: string;
  }) => Promise<unknown>;
}

/** What the history needs to record an object it has not seen yet. */
export interface PinSubject {
  title: string;
  /** A note's host: the source it opens in. */
  host?: () => Promise<string | null>;
}

/** The address the history stores for a panel's address: the object, without any anchor; or null. */
export function historyAddressOf(address: string): string | null {
  const parsed = parseObjectAddress(address);
  return parsed ? formatObjectAddress({ kind: parsed.kind, id: parsed.id }) : null;
}

/**
 * Whether the object is pinned. The list always carries every pin (at most ten) besides its recent
 * entries, so the smallest list answers.
 */
export async function isPinned(api: PinApi, address: string): Promise<boolean> {
  const target = historyAddressOf(address);
  if (!target) return false;
  const entries = await api.list({ limit: 1 });
  return entries.some((entry) => entry.address === target && entry.pinned);
}

/**
 * Pins `address`, or unpins it when it is pinned, and resolves with the pinned state it left. An
 * object the history never recorded is recorded first (a note with its host). A refusal (the pin
 * cap, a failed write) rejects.
 */
export async function togglePin(
  api: PinApi,
  address: string,
  subject?: PinSubject
): Promise<boolean | null> {
  const target = historyAddressOf(address);
  const parsed = parseObjectAddress(address);
  if (!target || !parsed) return null;
  const pinned = !(await isPinned(api, address));
  const entry = await api.setPinned(target, pinned);
  if (entry === null && pinned) {
    const host = parsed.kind === "note" && subject?.host ? await subject.host() : null;
    // A note opens from its source: without it the entry could not be listed or opened.
    if (parsed.kind === "note" && host === null) throw new Error("errors.viewHistory.noHost");
    await api.record({
      kind: parsed.kind,
      id: parsed.id,
      title: subject?.title.trim() ? subject.title : parsed.kind,
      ...(host ? { parentAddress: host } : {})
    });
    await api.setPinned(target, true);
  }
  return pinned;
}

/** What went wrong with a pin, for the notice the app shows. */
export type PinFailure = "limit" | "failed";

export function pinFailureOf(error: unknown): PinFailure {
  return error instanceof Error && error.message.includes(viewHistoryPinLimitMessage)
    ? "limit"
    : "failed";
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

/** True for Cmd-D alone: the pin shortcut. */
export function isPinKey(
  event: Pick<KeyboardEvent, "metaKey" | "shiftKey" | "altKey" | "ctrlKey" | "code">
) {
  return (
    event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey && event.code === "KeyD"
  );
}

export interface PinControl {
  isPinned: (address: string) => boolean;
  toggle: (address: string) => void;
}

function desktopApi(): PinApi | undefined {
  return typeof window === "undefined" ? undefined : window.app?.viewHistory;
}

async function titleOf(address: string): Promise<string> {
  const objects = typeof window === "undefined" ? undefined : window.app?.objects;
  const key = historyAddressOf(address) ?? address;
  try {
    return (await objects?.resolveMany({ addresses: [key] }))?.items[key]?.title ?? "";
  } catch {
    return "";
  }
}

async function subjectOf(address: string): Promise<PinSubject> {
  const objects = typeof window === "undefined" ? undefined : window.app?.objects;
  const parsed = parseObjectAddress(address);
  return {
    title: await titleOf(address),
    ...(parsed?.kind === "note" && objects
      ? { host: () => noteHostAddress(objects.locate, parsed.id) }
      : {})
  };
}

/**
 * The pin of the top panel's object for the whole workspace: whether each object that is shown is
 * pinned, the toggle the frame's pin button calls, and Cmd-D on the top object wherever the person
 * is (never in a text field). `enabled` is false while the stack is covered (Settings, an old
 * screen). A refusal is told through `onFailure`, never swallowed.
 */
export function usePins(
  workspace: WorkspaceState,
  enabled: boolean,
  onFailure: (failure: PinFailure) => void
): PinControl {
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const top = topAddress(workspace);
  const topKey = top === null ? null : historyAddressOf(top);
  const notify = useStableCallback(onFailure);

  // The state of the object on top is read when it changes (and when the stack is shown again).
  useEffect(() => {
    const api = desktopApi();
    if (!enabled || !api || !top || !topKey) return undefined;
    let live = true;
    isPinned(api, top)
      .then((value) => {
        if (!live) return;
        setPinned((current) =>
          current.has(topKey) === value
            ? current
            : new Set(value ? [...current, topKey] : [...current].filter((key) => key !== topKey))
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, top, topKey]);

  const toggle = useStableCallback((address: string) => {
    const api = desktopApi();
    const key = historyAddressOf(address);
    if (!api || !key) return;
    void (async () => {
      try {
        const now = await togglePin(api, address, await subjectOf(address));
        if (now === null) return;
        setPinned(
          (current) =>
            new Set(now ? [...current, key] : [...current].filter((entry) => entry !== key))
        );
      } catch (error) {
        notify(pinFailureOf(error));
      }
    })();
  });
  const toggleTop = useStableCallback(() => {
    if (top) toggle(top);
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || editable(event.target) || !isPinKey(event)) return;
      if (!top || !historyAddressOf(top)) return;
      event.preventDefault();
      toggleTop();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled, top, toggleTop]);

  const isPinnedNow = useCallback(
    (address: string) => {
      const key = historyAddressOf(address);
      return key !== null && pinned.has(key);
    },
    [pinned]
  );
  return useMemo(() => ({ isPinned: isPinnedNow, toggle }), [isPinnedNow, toggle]);
}
