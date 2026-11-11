import type { KeyboardEventHandler, ReactNode, Ref } from "react";
import { Circle, PauseCircle, Undo2 } from "lucide-react";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { Kbd } from "../ui/kbd";
import type { PillGlyph, PillView } from "./activity-model";
import { RunningRing, SolidCheck, SolidTriangle } from "./solid-glyphs";

/**
 * What the pill shows in place of its left part for eight seconds or so after the person (or the
 * system) changed something that can be undone: the verb and the object, and "Undo" (design record
 * §5.2). It is the undo toast as an extension of the pill, never a card over the content.
 */
export interface PillNotice {
  /** The sentence ("Renamed to Micronutrients."), already in the interface language. */
  text: string;
  /** Undo is offered: the notice names a change-set and no later change depends on it. */
  canUndo: boolean;
  pending: boolean;
  /** A later change depends on it: the pill says so instead of offering Undo. */
  blocked: boolean;
  failed: boolean;
  onUndo: () => void;
  /** Escape on the notice clears it; the pill returns at once. */
  onDismiss: () => void;
  /** Hovering or focusing the notice keeps it; leaving it starts the wait again. */
  onHold: (held: boolean) => void;
}

export interface ActivityPillProps {
  t: Translator;
  view: PillView;
  open: boolean;
  /** The drawer this button opens; referenced only while it is shown. */
  drawerId: string;
  ref?: Ref<HTMLButtonElement>;
  /** The notice's own element: focus goes here when the pill button is not on screen. */
  noticeRef?: Ref<HTMLDivElement>;
  onToggle: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  /** Home drops the needs-you clause: its "Precisa de você" column shows the same thing. */
  hideNeedsYou?: boolean;
  /** At compact width the "waiting" clause drops first. */
  compact?: boolean;
  notice?: PillNotice | null;
}

const glyphs = {
  check: { render: () => <SolidCheck className="text-success" /> },
  working: { render: () => <RunningRing /> },
  waiting: {
    render: () => <PauseCircle aria-hidden="true" className="size-4 shrink-0 text-warning" />
  },
  attention: { render: () => <SolidTriangle className="text-warning" /> },
  error: { render: () => <SolidTriangle className="text-danger" /> },
  loading: {
    render: () => (
      // Static: the one moving mark is the running ring, for live work only (design §5.12).
      <Circle
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground [stroke-dasharray:3_3]"
      />
    )
  }
} as const satisfies Record<PillGlyph, { render: () => ReactNode }>;

/** "3 need you": the count always in words, never a bare number. */
export function needsYouText(t: Translator, count: number): string {
  const key =
    new Intl.PluralRules(t.locale).select(count) === "one"
      ? "workspace.status.needsYouOne"
      : "workspace.status.needsYouMany";
  return t(key, { values: { count: new Intl.NumberFormat(t.locale).format(count) } });
}

/** "3 waiting". */
export function waitingText(t: Translator, count: number): string {
  return t("workspace.status.waiting", {
    values: { count: new Intl.NumberFormat(t.locale).format(count) }
  });
}

/** The whole sentence of the pill: what it names, the waiting clause and the needs-you clause. */
export function pillSentence(
  t: Translator,
  view: PillView,
  options: { hideNeedsYou?: boolean; compact?: boolean } = {}
): { main: string; waiting: string | null; needsYou: string | null } {
  return {
    main: view.text,
    waiting: view.waiting > 0 && !options.compact ? waitingText(t, view.waiting) : null,
    needsYou: view.badge > 0 && !options.hideNeedsYou ? needsYouText(t, view.badge) : null
  };
}

const shellBase = "inline-flex h-8 min-w-0 max-w-full items-center rounded-full border text-sm";
/** At compact width the pill spends less on padding and gaps, so its phrase stays whole. */
const shellOf = (compact: boolean) => cn(shellBase, compact ? "gap-1.5 px-2.5" : "gap-2 px-3");

function NeedsYou({ text }: { text: string }) {
  return (
    <>
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
      <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-warning">
        <SolidTriangle className="size-3" />
        {text}
      </span>
    </>
  );
}

/**
 * The status slot's pill (design record §5.2): it names the work in a sentence, always one line, and
 * says in words how many things wait for the person. Colour backs the glyph and the sentence, never
 * replaces them; the full sentence is the button's name and tooltip, and the drawer it opens holds
 * the rest. After an undoable change it turns into the undo extension for a few seconds.
 */
export function ActivityPill({
  t,
  view,
  open,
  drawerId,
  ref,
  noticeRef,
  onToggle,
  onKeyDown,
  hideNeedsYou = false,
  compact = false,
  notice = null
}: ActivityPillProps) {
  const sentence = pillSentence(t, view, { hideNeedsYou, compact });
  const needsYou = sentence.needsYou;

  if (notice) {
    // At compact width the needs-you clause waits: the notice lasts a few seconds, the Inbox badge
    // in the rail says the same, and the Undo link and the sentence need the room (design §3).
    const noticeNeedsYou = compact ? null : needsYou;
    const problem = notice.failed ? "failed" : notice.blocked ? "blocked" : null;
    return (
      // The announcement is the host's always-mounted live region: one that appears with its text
      // is not spoken. Everything here can shrink or truncate, so the pill never outgrows its slot.
      <div
        ref={noticeRef}
        tabIndex={-1}
        data-activity-notice=""
        className={cn(
          shellOf(compact),
          "overflow-hidden border-accent bg-surface text-foreground focus-visible:outline-2",
          "focus-visible:outline-accent"
        )}
        onMouseEnter={() => notice.onHold(true)}
        onMouseLeave={() => notice.onHold(false)}
        onFocus={() => notice.onHold(true)}
        onBlur={() => notice.onHold(false)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          notice.onDismiss();
        }}
      >
        {problem === "failed" ? (
          <SolidTriangle className="text-danger" />
        ) : problem === "blocked" ? (
          <SolidTriangle className="text-warning" />
        ) : (
          <SolidCheck className="text-success" />
        )}
        <span className="min-w-0 shrink-[4] truncate" title={notice.text}>
          {notice.text}
        </span>
        {notice.canUndo ? (
          <button
            type="button"
            disabled={notice.pending}
            aria-keyshortcuts="U"
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-sm font-medium text-accent",
              "hover:text-accent-hover focus-visible:outline-2 focus-visible:outline-offset-0",
              "focus-visible:outline-accent disabled:opacity-60"
            )}
            onClick={notice.onUndo}
          >
            <Undo2 aria-hidden="true" className="size-4" />
            {notice.pending ? t("topics.ops.toast.undoing") : t("topics.ops.toast.undo")}
            <Kbd>U</Kbd>
          </button>
        ) : null}
        {notice.blocked ? (
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            title={t("topics.ops.toast.blocked")}
          >
            {t("topics.ops.toast.blocked")}
          </span>
        ) : null}
        {notice.failed ? (
          <span
            className="min-w-0 truncate text-xs text-danger"
            title={t("topics.ops.toast.failed")}
          >
            {t("topics.ops.toast.failed")}
          </span>
        ) : null}
        {noticeNeedsYou ? <NeedsYou text={noticeNeedsYou} /> : null}
      </div>
    );
  }

  // The tooltip and the accessible name hold the whole sentence, the time left and the waiting count.
  const full = [view.full, sentence.waiting].filter(Boolean).join(" · ");
  const name = t("activity.pill.label", { values: { status: full } });
  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={open}
      aria-controls={open ? drawerId : undefined}
      aria-label={needsYou ? `${name} ${needsYou}` : name}
      title={needsYou ? `${full}. ${needsYou}` : full}
      className={cn(
        shellOf(compact),
        "border-border-strong text-secondary-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        // `cn` does not merge classes: one background and one border at a time.
        open ? "bg-accent-soft" : "bg-surface hover:bg-soft"
      )}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      {glyphs[view.glyph].render()}
      <span className="min-w-0 truncate font-medium text-foreground">{view.text}</span>
      {sentence.waiting ? (
        // Its own span: only the main phrase truncates, the clause stays whole or drops at compact width.
        <span className="shrink-0 whitespace-nowrap text-secondary-foreground">
          · {sentence.waiting}
        </span>
      ) : null}
      {needsYou ? <NeedsYou text={needsYou} /> : null}
    </button>
  );
}

/**
 * What the always-mounted live region says for a notice: the sentence, then what the person can do
 * (Undo, with its key) or why they cannot. The region exists before the text, so it is spoken.
 */
export function noticeAnnouncement(t: Translator, notice: PillNotice | null): string {
  if (notice === null) return "";
  const parts = [notice.text];
  if (notice.canUndo) parts.push(`${t("topics.ops.toast.undo")} U`);
  if (notice.blocked) parts.push(t("topics.ops.toast.blocked"));
  if (notice.failed) parts.push(t("topics.ops.toast.failed"));
  return parts.join(" ");
}
