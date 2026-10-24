import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent
} from "react";
import { formatObjectAddress, type InboxObject } from "@app/domain";
import type { Translator } from "@app/i18n";

import { closePanelPriority, subscribeClosePanel } from "../../lib/close-panel";
import { navigationForAddress } from "../../lib/object-navigation";
import { useObjectOpener, type OpenableNavigation } from "../WhereIsThis";
import { InboxController } from "./inbox-controller";
import { inboxCommand, reclaimsFocus } from "./inbox-keys";
import { InboxView } from "./InboxView";

export interface InboxScreenProps {
  t: Translator;
  /** False while the host view is hidden: nothing loads and nothing listens. */
  active: boolean;
  /** Where "Open" leads: a topic in the Wiki, a note or a source in the Library. */
  onNavigate: (navigation: OpenableNavigation) => void;
  /** Where an Obsidian conflict is solved: Settings, under Connections. */
  onOpenConnections: () => void;
}

/**
 * The Inbox of the shell. The state lives in a controller (tested without a renderer); this host
 * owns the focus: the list takes it when the view is shown, Enter moves it to the detail and
 * Escape back. The keys are read on the screen itself, never on the document, so no other view
 * hears them, and a key typed into a field or a dialog is never a command. The host keeps the
 * screen mounted while hidden, so the selection and the filter survive.
 */
export function InboxScreen({ t, active, onNavigate, onOpenConnections }: InboxScreenProps) {
  const [controller] = useState(() => new InboxController({ api: () => window.app }));
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  /** The keyboard is on this screen: the last focus or press landed inside it. */
  const keyboardHere = useRef(false);
  const idPrefix = `inbox-${useId().replace(/[^a-zA-Z0-9]/gu, "")}`;
  const focusPending = useRef(false);
  const opener = useObjectOpener(onNavigate);

  useEffect(() => {
    controller.show(active);
  }, [controller, active]);

  useEffect(() => () => controller.dispose(), [controller]);

  // Where the keyboard is, followed while the view is shown: removing the focused element (the
  // last item decided, a reload) moves the focus to the body without an event that says so.
  useEffect(() => {
    if (!active) return undefined;
    const follow = (event: Event) => {
      const root = rootRef.current;
      keyboardHere.current = Boolean(
        root && event.target instanceof Node && root.contains(event.target)
      );
    };
    document.addEventListener("focusin", follow);
    document.addEventListener("pointerdown", follow);
    return () => {
      document.removeEventListener("focusin", follow);
      document.removeEventListener("pointerdown", follow);
      keyboardHere.current = false;
    };
  }, [active]);

  // The keys work as soon as the view is shown: the list takes the focus once it has items to show.
  const ready = state.load.status === "ready";
  useEffect(() => {
    focusPending.current = active;
  }, [active]);
  useEffect(() => {
    if (!active || !ready || !focusPending.current) return;
    focusPending.current = false;
    (listRef.current ?? rootRef.current)?.focus({ preventScroll: true });
  }, [active, ready]);

  // The element that held the focus went away with this render: the focus stays on the screen (the
  // list, else the screen itself), so `u` after the last decision, `?` and the moves still work.
  const listShown = ready && state.items.length > 0;
  useEffect(() => {
    if (
      !reclaimsFocus({
        active,
        keyboardHere: keyboardHere.current,
        focused: document.activeElement,
        body: document.body
      })
    )
      return;
    (listRef.current ?? rootRef.current)?.focus({ preventScroll: true });
  }, [active, listShown, state.load.status, state.selectedKey, state.undo, state.actions]);

  // The selected item stays in view as the keys move through a long list.
  useEffect(() => {
    if (!active) return;
    const index = state.items.findIndex((item) => `${item.kind}:${item.id}` === state.selectedKey);
    if (index >= 0) listRef.current?.children.item(index)?.scrollIntoView?.({ block: "nearest" });
  }, [active, state.items, state.selectedKey]);

  // Cmd-W closes the keyboard help when it is the thing that is open.
  useEffect(() => {
    if (!active || !state.helpOpen) return undefined;
    return subscribeClosePanel(() => {
      controller.setHelp(false);
      return true;
    }, closePanelPriority.panel);
  }, [active, controller, state.helpOpen]);

  function onKey(event: KeyboardEvent<HTMLElement>) {
    const command = inboxCommand(event);
    if (!command) return;
    if (command.type === "open") {
      if (detailRef.current) {
        detailRef.current.focus();
        event.preventDefault();
      }
      return;
    }
    if (command.type === "escape") {
      if (state.helpOpen) {
        controller.setHelp(false);
        event.preventDefault();
      } else if (detailRef.current?.contains(event.target as Node)) {
        listRef.current?.focus();
        event.preventDefault();
      }
      return;
    }
    if (controller.command(command)) event.preventDefault();
  }

  function openObject(object: InboxObject) {
    opener.open(navigationForAddress(formatObjectAddress({ kind: object.kind, id: object.id })));
  }

  return (
    <InboxView
      t={t}
      state={state}
      rootRef={rootRef}
      listRef={listRef}
      detailRef={detailRef}
      idPrefix={idPrefix}
      openFailed={opener.openFailed}
      onKey={onKey}
      onRetry={() => controller.retry()}
      onFilter={(filter) => controller.setFilter(filter)}
      onSelect={(key) => controller.select(key)}
      onLoadMore={() => void controller.loadMore()}
      onVerb={(verb) => void controller.act(verb)}
      onUndo={() => void controller.undo()}
      onHideUndo={() => controller.dismissUndo()}
      onToggleHelp={() => controller.setHelp(!state.helpOpen)}
      onRetryDiff={() => controller.retryDiff()}
      onOpenObject={openObject}
      onOpenSettings={onOpenConnections}
    />
  );
}
