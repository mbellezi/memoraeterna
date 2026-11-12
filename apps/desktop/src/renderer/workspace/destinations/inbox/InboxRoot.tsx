import { useCallback, useEffect, useState } from "react";

import { InboxScreen } from "../../../components/inbox/InboxScreen";
import type { PanelLoadState } from "../../PanelFrame";
import type { PanelProps } from "../../PanelStack";
import { formatView } from "../../route";
import { useViewportWidth } from "../../use-workspace";
import { columnWidth } from "../columns";

/**
 * The Inbox destination's root (design record §7.4): the one place for human judgment, hosted from
 * `components/inbox`. Its items open as panels beside it (`onOpen` with the object's address); an
 * Obsidian conflict leads to Settings. As the previous panel of the stack it shows its item list
 * alone, the item that opened the panel beside it marked. The root reports its own `data-surface`
 * and `data-state`, as the stack draws no frame around a root.
 */

export const surfaceId = "destination-inbox";
/** The root as the previous panel of a stack: its item list alone, reported as a surface of its own. */
export const compactSurfaceId = "destination-inbox-compact";

export function InboxRoot({ t, mode, active, onState, onOpen }: PanelProps) {
  const [state, setState] = useState<PanelLoadState>("loading");
  const reportState = useCallback((next: PanelLoadState) => setState(next), []);
  useEffect(() => {
    onState(state);
  }, [onState, state]);
  const width = useViewportWidth();
  const compact = mode === "compact";

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
