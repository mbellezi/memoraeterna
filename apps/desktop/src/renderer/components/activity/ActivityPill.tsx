import type { KeyboardEventHandler, Ref } from "react";
import { CheckCircle2, CircleAlert, LoaderCircle, PauseCircle, TriangleAlert } from "lucide-react";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import type { PillGlyph, PillView } from "./activity-model";

export interface ActivityPillProps {
  t: Translator;
  view: PillView;
  open: boolean;
  /** The drawer this button opens; referenced only while it is shown. */
  drawerId: string;
  ref?: Ref<HTMLButtonElement>;
  onToggle: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
}

const glyphs = {
  check: { icon: CheckCircle2, tone: "text-success" },
  working: { icon: LoaderCircle, tone: "text-accent" },
  waiting: { icon: PauseCircle, tone: "text-warning" },
  attention: { icon: CircleAlert, tone: "text-warning" },
  error: { icon: TriangleAlert, tone: "text-danger" },
  loading: { icon: LoaderCircle, tone: "text-muted-foreground" }
} as const satisfies Record<PillGlyph, { icon: typeof CheckCircle2; tone: string }>;

/**
 * The shell header's quiet statement of what the Gardener is doing (or why it is not), always one
 * line. Colour backs the glyph and the sentence, never replaces them; the full sentence is the
 * button's name, and the drawer it opens holds the rest.
 */
export function ActivityPill({
  t,
  view,
  open,
  drawerId,
  ref,
  onToggle,
  onKeyDown
}: ActivityPillProps) {
  const { icon: Icon, tone } = glyphs[view.glyph];
  const spins = view.glyph === "working" || view.glyph === "loading";
  const name = t("activity.pill.label", { values: { status: view.text } });
  const badge =
    view.badge > 0
      ? t("activity.pill.badge", {
          values: { count: new Intl.NumberFormat(t.locale).format(view.badge) }
        })
      : null;
  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={open}
      aria-controls={open ? drawerId : undefined}
      aria-label={badge ? `${name} ${badge}` : name}
      title={view.text}
      className={cn(
        "inline-flex h-9 min-w-0 max-w-md items-center gap-2 rounded-lg border border-border-strong",
        "px-3 text-sm text-foreground transition-colors",
        "focus-visible:outline-2 focus-visible:outline-accent",
        // `cn` does not merge classes: one background at a time.
        open ? "bg-accent-soft" : "bg-surface hover:bg-soft"
      )}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-4 shrink-0", tone, spins && "motion-safe:animate-spin")}
      />
      <span className="min-w-0 truncate">{view.text}</span>
      {badge ? (
        <span
          aria-hidden="true"
          className="shrink-0 rounded-full bg-accent px-1.5 text-xs font-medium tabular-nums text-accent-foreground"
        >
          {new Intl.NumberFormat(t.locale).format(view.badge)}
        </span>
      ) : null}
    </button>
  );
}
