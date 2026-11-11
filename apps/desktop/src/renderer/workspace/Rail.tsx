import type { ComponentType, ReactNode } from "react";
import {
  Columns3,
  House,
  Inbox,
  LayoutDashboard,
  Library,
  SlidersHorizontal,
  TriangleAlert
} from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";

import { cn } from "../lib/cn";
import type { LegacyViewId } from "../../shared/app-menu";
import { Skeleton, useAfterDelay, skeletonDelayMs } from "../components/ui/skeleton";
import { Tooltip } from "../components/ui/tooltip";
import type { DestinationId, WorkspacePlace } from "./destinations";
import { LegacyMenu } from "./LegacyMenu";
import { railCurrentClass, railItemClass } from "./rail-styles";
import { railDestinations } from "./shell-model";
import type { Read } from "./shell-stores";
import { useInboxCount } from "./use-shell-data";

/** The glyph of each destination: an outline icon, never alone (the word is always under it). */
const destinationGlyphs = {
  home: House,
  explore: Columns3,
  library: Library,
  inbox: Inbox,
  map: LayoutDashboard
} as const satisfies Record<DestinationId, ComponentType<{ className?: string }>>;

const railWords = {
  home: "workspace.rail.home",
  explore: "workspace.rail.explore",
  library: "workspace.rail.library",
  inbox: "workspace.rail.inbox",
  map: "workspace.rail.map"
} as const satisfies Record<DestinationId, MessageKey>;

const fullNames = {
  home: "workspace.destinations.home",
  explore: "workspace.destinations.explore",
  library: "workspace.destinations.library",
  inbox: "workspace.destinations.inbox",
  map: "workspace.destinations.map"
} as const satisfies Record<DestinationId, MessageKey>;

/** The most the badge counts to; above it reads "99+". */
export const railBadgeCap = 99;

/** What the rail says about the Inbox count in a sentence, in the interface language. */
export function inboxWaitingText(t: Translator, count: number): string {
  const key =
    new Intl.PluralRules(t.locale).select(count) === "one"
      ? "workspace.rail.inboxWaitingOne"
      : "workspace.rail.inboxWaitingMany";
  return t(key, { values: { count: new Intl.NumberFormat(t.locale).format(count) } });
}

/** The rail's state, for the frame: what the Inbox count read says. */
export function railState(inbox: Read<number>): "loading" | "empty" | "error" | "success" {
  if (inbox.status === "loading") return "loading";
  if (inbox.status === "error") return "error";
  return inbox.value > 0 ? "success" : "empty";
}

export interface RailProps {
  t: Translator;
  place: WorkspacePlace;
  /** An old view is on screen: the "Old screens" item is current and no destination is. */
  legacyView?: LegacyViewId | null;
  /** How many items wait in the Inbox; the badge is the one filled count in the app. */
  inbox: Read<number>;
  onGo: (place: WorkspacePlace) => void;
  onOpenLegacy: (view: LegacyViewId) => void;
  /** Opening the Inbox after a failed count reads it again. */
  onRetryInbox?: () => void;
}

/**
 * The rail (design record §5.1): the mark, the five worded destinations, a spacer, the quiet "Old
 * screens" item while old views remain, and Ajustes. It never shows only icons. Its frame reports
 * the state of the one thing it reads, the Inbox count: loading, a failed count, none waiting, or
 * a badge; the rail itself is static.
 */
export function Rail({
  t,
  place,
  legacyView = null,
  inbox,
  onGo,
  onOpenLegacy,
  onRetryInbox
}: RailProps) {
  const state = railState(inbox);
  return (
    <nav
      aria-label={t("workspace.rail.label")}
      data-surface="rail"
      data-state={state}
      data-region="rail"
      className="flex h-full w-(--rail-w) shrink-0 flex-col items-center gap-1 border-r border-border bg-background pb-3"
    >
      <div className="flex h-(--top-h) shrink-0 items-center justify-center" title={t("app.title")}>
        <span
          aria-hidden="true"
          className="grid size-8 place-items-center rounded-lg bg-accent font-reading text-lg font-semibold text-accent-foreground"
        >
          M
        </span>
      </div>
      {railDestinations.map((destination, index) => {
        const Glyph = destinationGlyphs[destination];
        const current = legacyView === null && place === destination;
        const isInbox = destination === "inbox";
        const waiting = isInbox && inbox.status === "ready" ? inbox.value : 0;
        const name = t(fullNames[destination]);
        const label = waiting > 0 ? `${name}, ${inboxWaitingText(t, waiting)}` : name;
        return (
          <Tooltip key={destination} label={name} shortcut={`⌘${index + 1}`} side="right">
            <button
              type="button"
              aria-label={label}
              aria-current={current ? "page" : undefined}
              aria-keyshortcuts={`Meta+${index + 1}`}
              className={cn(railItemClass, current && railCurrentClass)}
              onClick={() => {
                if (isInbox && inbox.status === "error") onRetryInbox?.();
                onGo(destination);
              }}
            >
              <Glyph aria-hidden="true" className="size-5" />
              <span>{t(railWords[destination])}</span>
              {isInbox ? <InboxMark t={t} inbox={inbox} /> : null}
            </button>
          </Tooltip>
        );
      })}
      <div className="flex-1" />
      <LegacyMenu t={t} current={legacyView} onOpen={onOpenLegacy} />
      <Tooltip label={t("workspace.rail.settings")} shortcut="⌘," side="right">
        <button
          type="button"
          aria-label={t("workspace.rail.settings")}
          aria-current={legacyView === null && place === "settings" ? "page" : undefined}
          aria-keyshortcuts="Meta+,"
          className={cn(
            railItemClass,
            legacyView === null && place === "settings" && railCurrentClass
          )}
          onClick={() => onGo("settings")}
        >
          <SlidersHorizontal aria-hidden="true" className="size-5" />
          <span>{t("workspace.rail.settings")}</span>
        </button>
      </Tooltip>
    </nav>
  );
}

/** The Inbox's own mark: the count, a quiet marker while it is read, or one that says it failed. */
function InboxMark({ t, inbox }: { t: Translator; inbox: Read<number> }): ReactNode {
  const shown = useAfterDelay(skeletonDelayMs);
  const position = "absolute left-8 top-1";
  if (inbox.status === "loading")
    return (
      <span role="status" aria-busy="true" className={position}>
        <span className="sr-only">{t("workspace.rail.inboxLoading")}</span>
        {shown ? <Skeleton className="h-5 w-5 rounded-full" /> : null}
      </span>
    );
  if (inbox.status === "error")
    return (
      <span
        role="alert"
        title={t("workspace.rail.inboxFailed")}
        className={cn(position, "grid size-5 place-items-center rounded-full text-warning")}
      >
        <TriangleAlert aria-hidden="true" className="size-4" />
        <span className="sr-only">{t("workspace.rail.inboxFailed")}</span>
      </span>
    );
  if (inbox.value === 0) return null;
  const text = inbox.value > railBadgeCap ? `${railBadgeCap}+` : String(inbox.value);
  return (
    <span
      aria-hidden="true"
      className={cn(
        position,
        "h-5 min-w-5 rounded-full bg-warning px-1 text-center text-xs font-bold leading-5 tabular-nums text-surface",
        "shadow-[0_0_0_2px_var(--surface-canvas)]"
      )}
    >
      {text}
    </span>
  );
}

/** The rail wired to the window's Inbox count: what the app and the `rail` screen render. */
export function ConnectedRail(props: Omit<RailProps, "inbox" | "onRetryInbox">) {
  const inbox = useInboxCount();
  return <Rail {...props} inbox={inbox} onRetryInbox={inbox.retry} />;
}
