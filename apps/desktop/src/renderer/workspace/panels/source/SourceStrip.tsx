import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Search } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";

import { RunningRing, SolidCheck, SolidTriangle } from "../../../components/activity/solid-glyphs";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import type { CostRead, RunActionState } from "./source-controller";
import { splitSentence } from "./source-panel-model";
import {
  minutesOf,
  rulerLabelsShown,
  type StripKind,
  type StripModel,
  type StripStep,
  type StripSection
} from "./source-strip-model";

/**
 * The live generation strip of the Source panel (design record 6.2): it replaces the old Jobs
 * screen for one source. While work runs it shows the header, the six steps and the section ruler;
 * when the work ends it is one line; an error, a wait for the person and a pause each say what
 * happened and what is kept. It draws the model of `source-strip-model.ts` and keeps no state of
 * its own beyond the ruler's measured width.
 */

export interface StripActions {
  /** "perguntar a esta fonte": opens the Ask scoped to this source. */
  onAsk: () => void;
  /** "Gerar notas" and "Tentar de novo". */
  onRun: (request: "notes" | "retry") => void;
  /** "Escolher o modelo": opens the AI settings. */
  onChooseModel: () => void;
}

const box = "mb-6 rounded-xl border border-border bg-background";

/**
 * The items of a meta line, separated by "·" (design record 13): each item draws its own separator
 * before it, and the line clips the one that would start a line, so a line never starts or ends on
 * a separator. The text of the items is the caller's.
 */
export function MetaLine({ items, className }: { items: readonly string[]; className?: string }) {
  return (
    <p className={cn("m-0 overflow-hidden [text-wrap:pretty]", className)}>
      <span className="-ml-4 flex flex-wrap items-baseline">
        {items.map((item, index) => (
          <span
            key={`${index}:${item}`}
            className={cn(
              "relative ml-4 min-w-0",
              "before:absolute before:-left-2.5 before:text-muted-foreground before:content-['·']"
            )}
          >
            {item}
          </span>
        ))}
      </span>
    </p>
  );
}

const nbsp = " ";

/** "desde 09:12 · faltam cerca de 3 min · modelo local, sem custo": only the parts that are known. */
export function stripMeta(model: StripModel, cost: CostRead, t: Translator): string[] {
  const items: string[] = [];
  if (model.startedAt) {
    const time = new Intl.DateTimeFormat(t.locale, { hour: "2-digit", minute: "2-digit" }).format(
      Date.parse(model.startedAt)
    );
    items.push(t("sourcePage.strip.since", { values: { time } }));
  }
  if (model.remainingMs !== null) {
    const minutes = minutesOf(model.remainingMs);
    items.push(
      minutes >= 90
        ? t("sourcePage.strip.remainingHours", { values: { count: Math.round(minutes / 60) } })
        : t("sourcePage.strip.remainingMinutes", { values: { count: minutes } })
    );
  }
  if (cost.status === "ready") {
    const { estimate } = cost;
    if (estimate.billing === "local") items.push(t("sourcePage.strip.cost.local"));
    else if (estimate.billing === "subscription")
      items.push(t("sourcePage.strip.cost.subscription"));
    else if (estimate.billing === "per_token") {
      const amount = new Intl.NumberFormat(t.locale, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2
      })
        .format(estimate.usd)
        .replace(/\s/gu, nbsp);
      items.push(
        t(
          estimate.known
            ? "sourcePage.strip.cost.perToken"
            : "sourcePage.strip.cost.perTokenEstimated",
          {
            values: { amount }
          }
        )
      );
    }
  }
  return items;
}

/** The node of a step on the thread: done fills, running rings, pending is hollow, failed is marked. */
function StepNode({ state }: { state: StripStep["state"] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute top-0 left-0 grid size-3 place-items-center rounded-full border-2",
        state === "done" && "border-muted-foreground bg-muted-foreground",
        state === "running" && "border-accent bg-surface",
        state === "pending" && "border-border-strong bg-surface",
        state === "notApplicable" && "border-dashed border-border-strong bg-surface",
        state === "failed" && "border-danger bg-danger"
      )}
    />
  );
}

function Steps({ steps, t }: { steps: readonly StripStep[]; t: Translator }) {
  return (
    <ol className="m-0 grid list-none grid-cols-3 gap-y-4 p-0 @md:grid-cols-6">
      {steps.map((step) => (
        <li
          key={step.id}
          data-step={step.id}
          data-state={step.state}
          className={cn(
            "relative min-w-0 pt-5 pr-2 text-xs leading-4",
            "before:absolute before:top-[5px] before:right-0 before:left-3 before:h-0.5 before:bg-(--thread)",
            "last:before:hidden @max-md:nth-3:before:hidden",
            step.state === "done" && "before:bg-muted-foreground"
          )}
        >
          <StepNode state={step.state} />
          <b className="block text-sm leading-5 font-semibold text-foreground">{t(step.label)}</b>
          {step.value ? (
            <span
              className={cn(
                "block [text-wrap:pretty]",
                step.state === "running" || step.state === "failed"
                  ? "font-medium text-foreground"
                  : "text-secondary-foreground"
              )}
            >
              {t(step.value.key, step.value.values ? { values: step.value.values } : undefined)}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

const hatch: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, var(--accent) 0 2px, var(--surface-selected) 2px 5px)"
};

function Ruler({ sections, t }: { sections: readonly StripSection[]; t: Translator }) {
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = row.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [sections.length]);
  if (sections.length === 0) return null;
  const shown = rulerLabelsShown(sections, width);
  const stateWords: Record<StripSection["state"], MessageKey> = {
    done: "sourcePage.strip.ruler.done",
    reading: "sourcePage.strip.ruler.reading",
    pending: "sourcePage.strip.ruler.pending"
  };
  return (
    <>
      <p className="m-0 mt-4 text-xs text-muted-foreground">
        {t("sourcePage.strip.ruler.caption")}
      </p>
      <div
        ref={row}
        role="list"
        aria-label={t("sourcePage.strip.ruler.label")}
        className="mt-1 flex items-start gap-1"
      >
        {sections.map((section, index) => (
          <div
            key={`${index}:${section.title}`}
            role="listitem"
            data-section-state={section.state}
            title={`${section.title} · ${t(stateWords[section.state])}`}
            aria-label={`${section.title}: ${t(stateWords[section.state])}`}
            className="grid min-w-0 gap-1"
            style={{ flex: `${section.widthPct} 1 0%` }}
          >
            <i
              className={cn(
                "block h-2 rounded-sm border",
                section.state === "done" && "border-muted-foreground bg-muted-foreground",
                section.state === "reading" && "border-accent",
                section.state === "pending" && "border-border bg-surface-hover"
              )}
              style={section.state === "reading" ? hatch : undefined}
            />
            {shown[index] ? (
              <span className="block truncate text-xs leading-4 text-secondary-foreground">
                {section.title}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

const needsYouKeys: Partial<Record<string, MessageKey>> = {
  "no_model.no_route": "sourcePage.strip.needsYou.noRoute"
};

/** The one sentence an error names: the stage as words, never the error's text. */
const stageKeys: Record<string, MessageKey> = {
  conversion: "sourcePage.strip.stages.conversion",
  structureDetection: "sourcePage.strip.stages.structure",
  structureReview: "sourcePage.strip.stages.structure",
  materialization: "sourcePage.strip.stages.structure",
  chunking: "sourcePage.strip.stages.chunking",
  embedding: "sourcePage.strip.stages.embedding",
  summarization: "sourcePage.strip.stages.summarization",
  aggregateSummarization: "sourcePage.strip.stages.summarization",
  atomicNotes: "sourcePage.strip.stages.atomicNotes",
  knowledgeGraph: "sourcePage.strip.stages.knowledgeGraph",
  atomicNoteMatching: "sourcePage.strip.stages.atomicNoteMatching",
  sourceMatching: "sourcePage.strip.stages.sourceMatching"
};

export function SourceStrip({
  t,
  model,
  cost,
  action,
  actions
}: {
  t: Translator;
  model: StripModel;
  cost: CostRead;
  action: RunActionState;
  actions: StripActions;
}) {
  const busy = action.status === "pending";
  const failed =
    action.status === "failed" ? (
      <p role="alert" className="m-0 mt-2 text-xs text-secondary-foreground">
        {t("sourcePage.strip.actionFailed")}
      </p>
    ) : null;
  const kind: StripKind = model.kind;
  if (kind === "none") return null;

  if (kind === "running") {
    const milestone = splitSentence(
      t("sourcePage.strip.milestone", { values: { link: "{link}" } }),
      "{link}"
    );
    return (
      <section
        role="group"
        aria-label={t("sourcePage.strip.group")}
        data-strip="running"
        className={cn(box, "@container p-4")}
      >
        <div className="mb-4 flex items-start gap-3">
          <RunningRing className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <p className="m-0 text-sm leading-5 font-semibold text-foreground">
              {t("sourcePage.strip.title")}
            </p>
            <MetaLine
              items={stripMeta(model, cost, t)}
              className="text-xs leading-5 text-secondary-foreground"
            />
            {model.canAsk && milestone ? (
              <p className="m-0 text-xs leading-5 text-secondary-foreground [text-wrap:pretty]">
                {milestone[0]}
                <button
                  type="button"
                  onClick={actions.onAsk}
                  className="rounded-sm text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {t("sourcePage.strip.milestoneLink")}
                </button>
                {milestone[1]}
              </p>
            ) : null}
          </div>
        </div>
        <Steps steps={model.steps} t={t} />
        <Ruler sections={model.sections} t={t} />
      </section>
    );
  }

  if (kind === "done")
    return (
      <section
        role="group"
        aria-label={t("sourcePage.strip.group")}
        data-strip="done"
        className={cn(
          box,
          "flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm text-secondary-foreground"
        )}
      >
        <SolidCheck className="text-success" />
        <MetaLine
          className="min-w-0 flex-1 [&>span>span:first-child]:font-medium [&>span>span:first-child]:text-foreground"
          items={[
            model.tookMs !== null && model.tookMs >= 30_000
              ? t("sourcePage.strip.doneIn", { values: { count: minutesOf(model.tookMs) } })
              : t("sourcePage.strip.doneUnderMinute"),
            t(
              model.notes === 1
                ? "sourcePage.strip.values.notesDoneOne"
                : "sourcePage.strip.values.notesDone",
              { values: { count: model.notes } }
            ),
            t(
              model.relations === 1
                ? "sourcePage.strip.values.relationsDoneOne"
                : "sourcePage.strip.values.relationsDone",
              { values: { count: model.relations } }
            )
          ]}
        />
      </section>
    );

  const message = (children: ReactNode, glyph: ReactNode, buttons?: ReactNode, kept?: string) => (
    <section
      role="group"
      aria-label={t("sourcePage.strip.group")}
      data-strip={kind}
      className={cn(box, "flex items-start gap-3 p-4")}
    >
      <span className="mt-0.5">{glyph}</span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-sm font-medium text-foreground [text-wrap:pretty]">{children}</p>
        {kept ? (
          <p className="m-0 mt-1 text-xs text-secondary-foreground [text-wrap:pretty]">{kept}</p>
        ) : null}
        {buttons ? <div className="mt-3 flex flex-wrap items-center gap-2">{buttons}</div> : null}
        {failed}
      </div>
    </section>
  );

  if (kind === "searchable")
    return message(
      t("sourcePage.strip.searchable", { values: { count: model.indexed } }),
      <Search aria-hidden="true" className="size-4 text-secondary-foreground" />,
      <Button variant="secondary" disabled={busy} onClick={() => actions.onRun("notes")}>
        {t("sourcePage.actions.generateNotes")}
      </Button>,
      t("sourcePage.strip.searchableKept")
    );

  if (kind === "needsYou")
    return message(
      t(needsYouKeys[model.blocker ?? ""] ?? "sourcePage.strip.needsYou.other"),
      <SolidTriangle className="text-warning" />,
      <Button variant="secondary" onClick={actions.onChooseModel}>
        {t("sourcePage.strip.needsYou.choose")}
      </Button>,
      t("sourcePage.strip.needsYou.kept")
    );

  if (kind === "paused")
    return message(
      t("sourcePage.strip.paused"),
      <span aria-hidden="true" className="grid size-4 place-items-center text-secondary-foreground">
        <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
          <rect x="4" y="3" width="3" height="10" rx="1" />
          <rect x="9" y="3" width="3" height="10" rx="1" />
        </svg>
      </span>,
      undefined,
      t("sourcePage.strip.pausedKept")
    );

  // error
  const stage = model.failedStage ? stageKeys[model.failedStage] : undefined;
  return message(
    stage
      ? t("sourcePage.strip.failedAt", { values: { stage: t(stage) } })
      : t("sourcePage.strip.stopped"),
    <SolidTriangle className="text-warning" />,
    <Button variant="secondary" disabled={busy} onClick={() => actions.onRun("retry")}>
      {t("shell.actions.retry")}
    </Button>,
    t("sourcePage.strip.failedKept")
  );
}

/** The strip's own loading state: a box of the strip's height with its bars, so nothing jumps. */
export function SourceStripSkeleton() {
  return (
    <div aria-hidden="true" className={cn(box, "grid gap-4 p-4")}>
      <div className="flex items-start gap-3">
        <Skeleton className="mt-1 size-3 rounded-full" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="w-3/5" />
        </div>
      </div>
      <div className="grid grid-cols-6 gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="grid gap-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A read of the strip that failed: one quiet line and one way back (the panel itself still works). */
export function SourceStripError({ t, onRetry }: { t: Translator; onRetry: () => void }) {
  return (
    <section
      role="group"
      aria-label={t("sourcePage.strip.group")}
      data-strip="error-read"
      className={cn(
        box,
        "flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm text-secondary-foreground"
      )}
    >
      <SolidTriangle className="text-warning" />
      <span className="min-w-0 flex-1 [text-wrap:pretty]">{t("sourcePage.errors.progress")}</span>
      <Button variant="ghost" onClick={onRetry}>
        {t("shell.actions.retry")}
      </Button>
    </section>
  );
}
