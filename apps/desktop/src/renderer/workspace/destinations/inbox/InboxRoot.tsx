import { useCallback, useEffect, useEffectEvent, useState } from "react";

import type { InboxKind } from "@app/domain";

import { InboxScreen } from "../../../components/inbox/InboxScreen";
import type { PanelLoadState } from "../../PanelFrame";
import type { PanelProps } from "../../PanelStack";
import { formatView, parseViewAddress } from "../../route";
import { useViewportWidth } from "../../use-workspace";
import { columnWidth } from "../columns";

/**
 * The Inbox destination's root (design record §7.4): the one place for human judgment, hosted from
 * `components/inbox`. Its items open as panels beside it (`onOpen` with the object's address); an
 * Obsidian conflict leads to Settings. As the previous panel of the stack it shows its item list
 * alone, the item that opened the panel beside it marked. The root reports its own `data-surface`
 * and `data-state`, as the stack draws no frame around a root.
 *
 * A kind in the address is a request ("show me this kind"), not a place: the list takes it once it
 * is on screen and the root's address goes back to the plain Inbox. So a second Home row for the
 * same kind is a change of address again and narrows the list again, while a return through the
 * rail, or a restart, leaves the person's own filter alone.
 */

export const surfaceId = "destination-inbox";
/** The root as the previous panel of a stack: its item list alone, reported as a surface of its own. */
export const compactSurfaceId = "destination-inbox-compact";

/** The kind the root's address asks for (`memora://inbox?kind=…`), or undefined for the whole Inbox. */
export function inboxKindOf(address: string): InboxKind | undefined {
  const view = parseViewAddress(address);
  return view?.view === "inbox" ? view.kind : undefined;
}

export function InboxRoot({ t, address, mode, active, onState, onOpen }: PanelProps) {
  const [state, setState] = useState<PanelLoadState>("loading");
  const reportState = useCallback((next: PanelLoadState) => setState(next), []);
  useEffect(() => {
    onState(state);
  }, [onState, state]);
  const width = useViewportWidth();
  const compact = mode === "compact";
  const kind = inboxKindOf(address);
  const spend = useEffectEvent(() => onOpen(formatView({ view: "inbox" }), { replace: true }));
  // The list's own effect (a child's) has applied the kind by now, so the request can be spent.
  useEffect(() => {
    if (kind !== undefined && active && !compact) spend();
  }, [kind, active, compact]);

  return (
    <section
      data-surface={compact ? compactSurfaceId : surfaceId}
      data-state={state}
      aria-label={t("inbox.title")}
      className="flex h-full min-h-0 min-w-0 flex-col gap-3 px-6 py-5 max-[1179px]:px-4"
    >
      <h1 className="m-0 font-reading text-2xl font-semibold text-foreground">
        {t("inbox.title")}
      </h1>
      <div className="min-h-0 min-w-0 flex-1">
        <InboxScreen
          t={t}
          active={active}
          compact={compact}
          keyBar={!compact}
          kind={kind}
          listWidth={columnWidth("inboxList", width)}
          onState={reportState}
          onNavigate={() => undefined}
          onOpenAddress={(address) => onOpen(address)}
          onOpenConnections={() =>
            onOpen(formatView({ view: "settings", section: "integrations" }))
          }
        />
      </div>
    </section>
  );
}
