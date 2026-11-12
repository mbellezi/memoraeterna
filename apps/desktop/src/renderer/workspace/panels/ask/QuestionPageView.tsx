import { useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { ErrorState } from "../../../components/ui/error-state";
import { LoadingState, Skeleton, SkeletonLines } from "../../../components/ui/skeleton";
import { Tooltip } from "../../../components/ui/tooltip";
import { cn } from "../../../lib/cn";
import type { QuestionView } from "../../../../shared/ipc-questions";
import { useObjectPreview } from "../../ObjectLink";
import { titleOf } from "../../ObjectLinkModel";
import { formatView } from "../../route";
import {
  aiPlace,
  citedObjectCount,
  failureKey,
  numberCitations,
  plainText,
  shownAnswer,
  type ShownAnswer
} from "./answer-model";
import { AnswerParagraphView } from "./AnswerParagraph";
import { AskComposer } from "./AskComposer";
import { objectOfScope } from "./ask-scope";
import { MetaClauses } from "./MetaClauses";
import type { LauncherSend } from "./ask-launcher";
import type { QuestionSnapshot } from "./question-controller";
import { PassageTray, SourcesRail, entryElementId } from "./SourcesRail";
import { StatusBand, answerDate } from "./StatusBand";

/**
 * The Question page (design record §6.4, §10.3): the question as the title, one meta line, the
 * status band of the Ask, the answer's paragraphs with citation chips, the sources list ("Evidência
 * desta resposta") and a follow-up field in the same scope. It draws the four states of the panel
 * contract: the skeleton of the page, the answer that found nothing to rest on (with what to do
 * next), one quiet failure in place, and the page, whether the answer is being written or stored.
 * `compact` is the previous panel's form: the question, where the answer stands and its first lines.
 */

export interface QuestionPageViewProps {
  t: Translator;
  snapshot: QuestionSnapshot;
  mode: "full" | "compact";
  /** The window's width: below 1280 px the context is a strip, so a passage tray reads the citations. */
  viewportWidth: number;
  /** Opens an address beside this panel, or in it with the Option key. */
  onOpen: (address: string, options?: { replace?: boolean }) => void;
  onRetry: () => void;
  onStop: () => void;
  onAskAgain: () => void;
  /** The follow-up field's send, and what it is doing. */
  followUp: { send: LauncherSend; onSend: (text: string) => void; onEdit: () => void };
}

/** The place under 1280 px where the tray replaces the Evidência tab (A2). */
export const trayBelow = 1280;

const sectionGap = "grid min-w-0 gap-6";

export function QuestionPageView(props: QuestionPageViewProps) {
  const { t, snapshot, mode } = props;
  const compact = mode === "compact";
  const { load } = snapshot;

  if (load.status === "loading")
    return (
      <LoadingState t={t} className="max-w-(--measure)">
        <Skeleton className={cn("h-6", compact ? "w-4/5" : "w-3/4")} />
        <Skeleton className="w-2/5" />
        {compact ? (
          <SkeletonLines lines={4} className="mt-2" />
        ) : (
          <div className="mt-4 grid gap-5">
            <Skeleton className="h-10 w-full rounded-lg" />
            <SkeletonLines lines={4} />
            <SkeletonLines lines={3} />
          </div>
        )}
      </LoadingState>
    );

  // One cause shows one failure: the previous panel reads the same Question, so it says it quietly
  // and the retry lives on the top panel.
  if (load.status === "error" && compact)
    return (
      <p role="status" className="m-0 text-xs text-muted-foreground">
        {t("askPanel.compact.error")}
      </p>
    );

  if (load.status === "error")
    return (
      <ErrorState
        t={t}
        className="max-w-(--measure)"
        message={t("askPanel.error.message")}
        kept={t("askPanel.error.kept")}
        retryLabel={t("shell.actions.retry")}
        onRetry={props.onRetry}
      />
    );

  if (load.status === "missing")
    return (
      <EmptyState
        variant={compact ? "compact" : "inline"}
        className="max-w-(--measure)"
        headline={t("askPanel.missing.headline")}
      >
        {t("askPanel.missing.body")}
      </EmptyState>
    );

  return <LoadedQuestion {...props} question={load.question} />;
}

/** The meta line's clauses: when it was asked, what about, and which AI wrote it. */
function QuestionMeta({
  t,
  question,
  shown,
  compact
}: {
  t: Translator;
  question: QuestionView;
  shown: ShownAnswer;
  compact: boolean;
}) {
  const object = objectOfScope(question.scope);
  const preview = useObjectPreview(object ?? "", object !== null);
  const date = answerDate(t, question.createdAt);
  const clauses: string[] = [];
  if (date) clauses.push(t("askPanel.meta.asked", { values: { date } }));
  if (question.scope.kind === "library") clauses.push(t("askPanel.meta.scopeLibrary"));
  else if (question.scope.kind === "sources" && question.scope.sourceIds.length > 1)
    clauses.push(
      t("askPanel.meta.scopeSources", { values: { count: question.scope.sourceIds.length } })
    );
  else if (preview.state.status === "ready") {
    const title = titleOf(preview.state.item, t("objects.kinds.topic"));
    clauses.push(
      t(
        question.scope.kind === "topic" ? "askPanel.meta.scopeTopic" : "askPanel.meta.scopeSource",
        {
          values: { title }
        }
      )
    );
  }
  if (shown.stage !== "retrieving" || shown.provenance !== undefined)
    clauses.push(
      t(
        aiPlace(question, shown.provenance) === "cloud"
          ? "askPanel.meta.cloud"
          : "askPanel.meta.local"
      )
    );
  return compact ? (
    // The narrow form lists the clauses, one to a line, with no separators to wrap onto a new line.
    <ul className="m-0 grid list-none gap-0.5 p-0 text-xs text-secondary-foreground">
      {clauses.map((clause) => (
        <li key={clause}>{clause}</li>
      ))}
    </ul>
  ) : (
    <MetaClauses clauses={clauses} className="text-sm text-secondary-foreground" />
  );
}

function VersionPicker({
  t,
  version,
  versions,
  onPick
}: {
  t: Translator;
  version: number;
  versions: number;
  onPick: (version: number) => void;
}) {
  const arrow = cn(
    "inline-grid size-7 shrink-0 place-items-center rounded-md text-secondary-foreground",
    "hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
    "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent [&>svg]:size-4"
  );
  return (
    <div
      role="group"
      aria-label={t("askPanel.versions.label")}
      className="flex items-center gap-1 text-xs text-secondary-foreground"
    >
      <Tooltip label={t("askPanel.versions.previous")}>
        <button
          type="button"
          aria-label={t("askPanel.versions.previous")}
          disabled={version <= 1}
          onClick={() => onPick(version - 1)}
          className={arrow}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
      </Tooltip>
      <span className="tabular-nums">
        {t("askPanel.versions.of", { values: { version, total: versions } })}
      </span>
      <Tooltip label={t("askPanel.versions.next")}>
        <button
          type="button"
          aria-label={t("askPanel.versions.next")}
          disabled={version >= versions}
          onClick={() => onPick(version + 1)}
          className={arrow}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}

function LoadedQuestion({
  t,
  snapshot,
  mode,
  viewportWidth,
  onOpen,
  onStop,
  onAskAgain,
  followUp,
  question
}: QuestionPageViewProps & { question: QuestionView }) {
  const compact = mode === "compact";
  const idBase = useId();
  const headingId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const shown = useMemo(
    () => shownAnswer(question, snapshot.stream, picked),
    [question, snapshot.stream, picked]
  );
  const numbering = useMemo(() => numberCitations(shown.paragraphs), [shown.paragraphs]);
  const { sources, numberOf } = numbering;
  const cited = citedObjectCount(sources);
  const activeEntry = sources.find((entry) => entry.number === active) ?? null;
  const failed = shown.stage === "failed";
  const grounded = shown.paragraphs.length > 0;
  const noGrounding = shown.stage === "done" && !grounded;
  const canStop =
    shown.live && snapshot.action !== "stopping" && snapshot.stream.requestId !== null;
  const canAskAgain = !shown.live && snapshot.action !== "asking";
  const failedAction = snapshot.action === "failed" ? (shown.live ? "stop" : "again") : null;

  const open = (address: string) => (event?: MouseEvent) =>
    onOpen(address, event?.altKey ? { replace: true } : undefined);
  const openCitation = (number: number) => {
    const entry = sources.find((source) => source.number === number);
    if (entry?.open) onOpen(entry.open);
  };

  const title = (
    <h1
      className={cn(
        "m-0 min-w-0 font-reading font-semibold text-foreground [text-wrap:balance] [overflow-wrap:anywhere]",
        compact ? "line-clamp-4 text-lg leading-snug" : "text-xl"
      )}
    >
      {question.text}
    </h1>
  );

  if (compact)
    return (
      <article className="grid min-w-0 gap-3">
        <div className="flex items-start gap-2">
          <ObjectKindGlyph
            kind="question"
            size={16}
            className={cn("mt-1", objectKindTextClass.question)}
          />
          {title}
        </div>
        <QuestionMeta t={t} question={question} shown={shown} compact />
        {grounded ? (
          <p
            className="m-0 line-clamp-6 font-reading text-sm leading-6 text-secondary-foreground"
            title={plainText(shown.paragraphs[0]?.markdown ?? "")}
          >
            {plainText(shown.paragraphs[0]?.markdown ?? "")}
          </p>
        ) : null}
        <p className="m-0 text-xs text-muted-foreground">
          {shown.stage === "retrieving"
            ? t("askPanel.band.retrieving")
            : shown.stage === "answering"
              ? t("askPanel.band.answering")
              : shown.stage === "waitingForProvider"
                ? t("askPanel.band.waiting")
                : null}
        </p>
      </article>
    );

  const body: ReactNode = failed ? (
    <div data-stage="failed" className="grid min-w-0 max-w-(--measure) gap-4">
      <ErrorState
        t={t}
        message={
          failureKey(shown.error)
            ? t(failureKey(shown.error) as "questions.errors.interrupted")
            : t("askPanel.failed.message")
        }
        kept={grounded ? t("askPanel.failed.kept") : t("askPanel.failed.keptNothing")}
        retryLabel={t("shell.actions.retry")}
        {...(canAskAgain ? { onRetry: onAskAgain } : {})}
      />
      {failedAction ? (
        <p role="status" className="m-0 text-xs text-secondary-foreground">
          {t("askPanel.failed.again")}
        </p>
      ) : null}
    </div>
  ) : noGrounding ? (
    <div data-stage="done" className="grid max-w-(--measure)">
      <EmptyState
        headline={t("askPanel.empty.headline")}
        action={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(question.text);
                field.current?.focus();
              }}
            >
              {t("askPanel.empty.rephrase")}
            </Button>
            <Button variant="secondary" onClick={() => onOpen(formatView({ view: "import" }))}>
              {t("askPanel.empty.add")}
            </Button>
          </>
        }
      >
        {t("askPanel.empty.body")}
      </EmptyState>
    </div>
  ) : (
    <StatusBand
      t={t}
      stage={shown.stage}
      sources={cited}
      completedAt={shown.completedAt}
      stale={shown.stale}
      canStop={canStop}
      canAskAgain={canAskAgain}
      onStop={onStop}
      onAskAgain={onAskAgain}
      actionFailed={failedAction}
    />
  );

  return (
    <article
      aria-label={question.text}
      data-question-status={question.status}
      className={cn(sectionGap, "max-w-2xl")}
    >
      <header className="grid min-w-0 gap-1.5">
        <div className="flex items-start gap-2">
          <ObjectKindGlyph
            kind="question"
            size={20}
            className={cn("mt-[5px]", objectKindTextClass.question)}
          />
          {title}
        </div>
        <QuestionMeta t={t} question={question} shown={shown} compact={false} />
      </header>

      {body}

      {noGrounding ? null : (
        <div className="grid min-w-0 max-w-(--measure) gap-4">
          {grounded ? (
            shown.paragraphs.map((paragraph, index) => (
              <AnswerParagraphView
                key={index}
                t={t}
                paragraph={paragraph}
                numberOf={numberOf}
                entryId={(number) => entryElementId(idBase, number)}
                onActivate={setActive}
                onOpen={openCitation}
                activeNumber={active}
              />
            ))
          ) : shown.live ? (
            <SkeletonLines lines={4} />
          ) : null}
          {grounded ? (
            <p className="m-0 text-xs text-muted-foreground [text-wrap:pretty]">
              {t(
                shown.live && question.scope.kind !== "topic"
                  ? "askPanel.answer.savedPlace"
                  : "askPanel.answer.saved"
              )}
            </p>
          ) : null}
          {shown.versions > 1 && !shown.live && shown.version > 0 ? (
            <VersionPicker
              t={t}
              version={shown.version}
              versions={shown.versions}
              onPick={setPicked}
            />
          ) : null}
        </div>
      )}

      <SourcesRail
        t={t}
        sources={sources}
        idBase={idBase}
        headingId={headingId}
        hint={t(viewportWidth < trayBelow ? "askPanel.tray.empty" : "askPanel.sources.hint")}
        active={active}
        onActivate={setActive}
        onOpen={(address) => open(address)()}
      />

      <div className="grid min-w-0 max-w-(--measure) gap-1.5">
        <AskComposer
          t={t}
          value={draft}
          inputRef={field}
          onChange={(value) => {
            followUp.onEdit();
            setDraft(value);
          }}
          onSend={() => followUp.onSend(draft)}
          busy={followUp.send.status === "asking"}
          label={t("askPanel.followUp.label")}
          placeholder={t("askPanel.followUp.placeholder")}
          sendLabel={t("askPanel.followUp.send")}
        />
        {followUp.send.status === "error" ? (
          <p role="status" className="m-0 text-xs text-secondary-foreground">
            {t("askPanel.launcher.error.message")} {t("askPanel.launcher.error.kept")}
          </p>
        ) : null}
      </div>

      {viewportWidth < trayBelow && sources.length > 0 ? (
        <PassageTray t={t} entry={activeEntry} />
      ) : null}
    </article>
  );
}
