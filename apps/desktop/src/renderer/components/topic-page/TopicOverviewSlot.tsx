import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { FocusEvent, KeyboardEvent } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, RefreshCw, Sparkles, X } from "lucide-react";
import type { TopicOverviewCitation, TopicOverviewState } from "@app/domain";
import type { Translator } from "@app/i18n";

import { Button } from "../ui/button";
import { TopicOverviewController } from "./topic-overview-controller";
import {
  citationLabel,
  citationAddress,
  overviewHint,
  overviewMessage,
  overviewView,
  paragraphSegments,
  relativeWhen,
  sourcesCitedLabel,
  supportView,
  unmarkedCitations,
  type OverviewView,
  type ReadyOverview,
  type SupportTone
} from "./topic-overview-model";
import type { TopicPageActions } from "./topic-page-model";

export interface TopicOverviewSlotProps {
  t: Translator;
  topic: { id: string; title: string };
  /** What the page read: no overview yet, one being written, one ready or a failure. */
  overview: TopicOverviewState;
  /** False while the host view is hidden: the slot loads nothing and holds nothing open. */
  active: boolean;
  actions: TopicPageActions;
}

/**
 * The lazy overview of the topic (T31), between the header and the map of content. Opening a page
 * whose topic has no overview writes one (the only AI call of a Topic page); a cached overview is
 * shown as read, with Update when the topic's notes changed since it was written. Citations open
 * at the exact passage.
 */
export function TopicOverviewSlot({ t, topic, overview, active, actions }: TopicOverviewSlotProps) {
  const [controller] = useState(
    () => new TopicOverviewController({ api: () => window.app.topics })
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );

  useEffect(() => {
    controller.show(topic.id, overview, active);
  }, [controller, topic.id, overview, active]);

  useEffect(() => () => controller.dispose(), [controller]);

  const local = snapshot.local?.topicId === topic.id ? snapshot.local : null;
  return (
    <TopicOverviewSection
      t={t}
      view={overviewView(overview, local)}
      now={snapshot.now}
      actions={actions}
      onWrite={() => controller.write(false)}
      onUpdate={() => controller.write(true)}
      onCancel={() => controller.cancel()}
    />
  );
}

export interface TopicOverviewSectionProps {
  t: Translator;
  view: OverviewView;
  /** The time "written on open, 2 days ago" is counted from. */
  now: number;
  actions: TopicPageActions;
  onWrite: () => void;
  onUpdate: () => void;
  onCancel: () => void;
}

const toneClass: Record<SupportTone, string> = {
  success: "text-success",
  warning: "text-warning",
  neutral: "text-muted-foreground"
};

/** The overview section as its state reads: props in, callbacks out. */
export function TopicOverviewSection(props: TopicOverviewSectionProps) {
  const { t, view } = props;
  const headingId = useId();
  // Nothing to say (no overview service, an unknown topic) or the library root, whose overview
  // would be a summary of everything: the section stays out of the page.
  if (
    view.kind === "absent" &&
    !view.canWrite &&
    (view.reasonKey === null || view.reasonKey === "topics.overview.reasons.root")
  ) {
    return null;
  }
  return (
    <section
      aria-labelledby={headingId}
      aria-busy={view.kind === "writing"}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          {t("topics.overview.title")}
        </h2>
        {view.kind === "ready" ? (
          <span className="text-xs text-muted-foreground">
            {overviewHint(t, view.overview.evidence)}
          </span>
        ) : null}
      </div>
      <OverviewBody {...props} />
    </section>
  );
}

function OverviewBody(props: TopicOverviewSectionProps) {
  const { t, view } = props;
  switch (view.kind) {
    case "absent":
      return (
        <div className="flex flex-wrap items-center gap-3">
          {view.reasonKey ? (
            <p className="text-sm text-muted-foreground">{overviewMessage(t, view.reasonKey)}</p>
          ) : null}
          {view.canWrite ? (
            <Button type="button" onClick={props.onWrite}>
              <Sparkles aria-hidden="true" />
              {t("topics.overview.write")}
            </Button>
          ) : null}
        </div>
      );
    case "writing":
      return (
        <div className="flex flex-col gap-3">
          <div role="status" className="flex flex-wrap items-center gap-3">
            <LoaderCircle
              className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">{t("topics.overview.writing")}</p>
            <Button type="button" variant="ghost" onClick={props.onCancel}>
              <X aria-hidden="true" />
              {t("topics.overview.cancel")}
            </Button>
          </div>
          {view.previous ? (
            <div className="opacity-60">
              <Paragraphs {...props} overview={view.previous} />
            </div>
          ) : (
            <div aria-hidden="true" className="flex max-w-190 flex-col gap-2">
              <div className="h-4 rounded-md bg-soft" />
              <div className="h-4 w-11/12 rounded-md bg-soft" />
              <div className="h-4 w-3/4 rounded-md bg-soft" />
            </div>
          )}
        </div>
      );
    case "failed":
      return (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground">{overviewMessage(t, view.messageKey)}</p>
          <Button type="button" onClick={props.onWrite}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      );
    case "ready":
      return <ReadyOverviewView {...props} overview={view.overview} noticeKey={view.noticeKey} />;
  }
}

function ReadyOverviewView(
  props: TopicOverviewSectionProps & { overview: ReadyOverview; noticeKey: string | null }
) {
  const { t, overview } = props;
  const support = supportView(t, overview.support);
  const SupportIcon = support.busy
    ? LoaderCircle
    : support.tone === "success"
      ? CircleCheck
      : CircleAlert;
  return (
    <div className="flex flex-col gap-3">
      {overview.stale ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-border-strong bg-soft px-3 py-2"
        >
          <CircleAlert className="size-4 text-warning" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm text-foreground">{t("topics.overview.stale")}</p>
          <Button type="button" onClick={props.onUpdate}>
            <RefreshCw aria-hidden="true" />
            {t("topics.overview.update")}
          </Button>
        </div>
      ) : null}
      {props.noticeKey ? (
        <p role="alert" className="text-sm text-danger">
          {overviewMessage(t, props.noticeKey)}
        </p>
      ) : null}
      <Paragraphs {...props} overview={overview} />
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Sparkles className="size-3" aria-hidden="true" />
          {overview.model}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {t("topics.overview.writtenOnOpen", {
            values: { when: relativeWhen(t, overview.writtenAt, new Date(props.now)) }
          })}
        </span>
        <span aria-hidden="true">·</span>
        <span>{sourcesCitedLabel(t, overview.citations)}</span>
        <span aria-hidden="true">·</span>
        <span role="status" className={`inline-flex items-center gap-1 ${toneClass[support.tone]}`}>
          <SupportIcon
            className={`size-3 ${support.busy ? "animate-spin motion-reduce:animate-none" : ""}`}
            aria-hidden="true"
          />
          {support.text}
        </span>
        {overview.stale ? null : (
          <Button type="button" variant="ghost" onClick={props.onUpdate}>
            <RefreshCw aria-hidden="true" />
            {t("topics.overview.update")}
          </Button>
        )}
      </p>
    </div>
  );
}

function Paragraphs(props: TopicOverviewSectionProps & { overview: ReadyOverview }) {
  const { t, overview, actions } = props;
  const unsupported = new Set(overview.support.unsupported);
  const byNumber = new Map(overview.citations.map((citation) => [citation.n, citation]));
  return (
    <div lang={overview.language} className="flex max-w-(--measure) flex-col gap-3">
      {overview.paragraphs.map((paragraph, index) => (
        <p key={index} className="font-reading text-base leading-7 text-foreground">
          {paragraphSegments(paragraph.text, overview.citations).map((segment, at, all) =>
            segment.kind === "text" ? (
              // A numeral sits tight to its word: the space the writer left before it is dropped.
              <span key={at}>
                {all[at + 1]?.kind === "citation" ? segment.text.trimEnd() : segment.text}
              </span>
            ) : (
              <Citations
                key={at}
                t={t}
                numbers={segment.numbers}
                byNumber={byNumber}
                actions={actions}
              />
            )
          )}
          {unmarkedCitations(paragraph, overview.citations).length > 0 ? (
            <>
              {" "}
              <Citations
                t={t}
                numbers={unmarkedCitations(paragraph, overview.citations)}
                byNumber={byNumber}
                actions={actions}
              />
            </>
          ) : null}
          {unsupported.has(index) ? (
            <span
              className="ml-1 inline-flex items-center align-middle text-warning"
              title={t("topics.overview.support.unsupported")}
            >
              <CircleAlert className="size-3.5" aria-hidden="true" />
              <span className="sr-only">{t("topics.overview.support.unsupported")}</span>
            </span>
          ) : null}
        </p>
      ))}
    </div>
  );
}

function Citations({
  t,
  numbers,
  byNumber,
  actions
}: {
  t: Translator;
  numbers: readonly number[];
  byNumber: ReadonlyMap<number, TopicOverviewCitation>;
  actions: TopicPageActions;
}) {
  return (
    <sup className="inline-flex gap-px font-sans">
      {numbers.map((n) => {
        const citation = byNumber.get(n);
        return citation ? (
          <CitationMarker key={n} t={t} citation={citation} actions={actions} />
        ) : null;
      })}
    </sup>
  );
}

/**
 * One citation: the marker opens the passage; hovering or focusing it shows the source and the
 * excerpt in a non-modal card that closes with Escape and never traps focus.
 */
function CitationMarker({
  t,
  citation,
  actions
}: {
  t: Translator;
  citation: TopicOverviewCitation;
  actions: TopicPageActions;
}) {
  const [open, setOpen] = useState(false);
  const cardId = useId();
  const address = citationAddress(citation);
  const openPassage = () => {
    if (address) actions.openAddress(address);
  };
  const onBlur = (event: FocusEvent<HTMLSpanElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setOpen(false);
  };
  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="rounded-sm px-px [font-size:inherit] font-semibold text-accent hover:bg-soft hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        aria-label={citationLabel(t, citation)}
        aria-describedby={open ? cardId : undefined}
        onClick={openPassage}
      >
        {citation.n}
      </button>
      {open ? (
        <span
          id={cardId}
          className={[
            "absolute left-0 top-full z-20 mt-1 flex w-80 max-w-[80vw] flex-col gap-2 rounded-lg",
            "border border-border-strong bg-surface p-3 text-left text-sm font-normal leading-5",
            "text-foreground shadow-lg"
          ].join(" ")}
        >
          <span className="font-semibold [overflow-wrap:anywhere]">
            {citation.sourceTitle || t("topics.overview.citation.unknownSource")}
          </span>
          <span className="line-clamp-6 font-reading text-secondary-foreground [overflow-wrap:anywhere]">
            {citation.excerpt}
          </span>
          {citation.available ? null : (
            <span className="text-xs text-muted-foreground">
              {t("topics.overview.citation.unavailable")}
            </span>
          )}
          {address ? (
            <span>
              <Button type="button" variant="link" onClick={openPassage}>
                {t("topics.overview.citation.open")}
              </Button>
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
