import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CircleCheck } from "lucide-react";
import { formatObjectAddress } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import type { QuestionListItemView } from "../../../shared/ipc-questions";
import { ErrorState } from "../../components/ui/error-state";
import { LoadingState, Skeleton } from "../../components/ui/skeleton";
import { useAppEvent } from "../../lib/app-events";
import { useStableCallback } from "../../lib/stable-callback";
import { AskComposer } from "../panels/ask/AskComposer";
import { AskLauncherController } from "../panels/ask/ask-launcher";
import { askTextState } from "../panels/ask/ask-scope";
import { answerDate } from "../panels/ask/StatusBand";
import {
  askTabState,
  askTarget,
  earlierQuestions,
  indexedLine,
  primaryTopic,
  type AskTarget,
  type AskVariant,
  type IndexedLine
} from "./ask-tab-model";
import {
  ContextEmpty,
  ContextError,
  ContextFrame,
  ContextHeading,
  ContextRow,
  GroupHeading,
  useReportedCount,
  useReportedState,
  type ContextTabProps
} from "./context-parts";
import { useContextRead, useLocate, useResolved, type Read } from "./context-reads";

/**
 * The Perguntar tab (design record §5.6, §20.1 row 17; D14): Ask scoped to the object in focus, in
 * the panel the Ask page is made of (the field, the scope and the questions asked before). D14 has
 * three scopes only, so a note asks the topic it is in, and an entity or a question asks the
 * library; the heading and its line always say which, and an Ask never widens its scope without
 * saying so. An Ask stores its Question at once and the page of that Question opens beside the
 * focused panel, where the answer streams. Nothing here calls a model: only `questions.ask` does.
 */
export const tab = "ask";
export const surface = "context-ask";

const titles = {
  source: "contextPanel.ask.title.source",
  topic: "contextPanel.ask.title.topic",
  note: "contextPanel.ask.title.note",
  noteUnplaced: "contextPanel.ask.title.library",
  entity: "contextPanel.ask.title.entity",
  library: "contextPanel.ask.title.library"
} as const satisfies Record<AskVariant, MessageKey>;

const descriptions = {
  source: "contextPanel.ask.description.source",
  topic: "contextPanel.ask.description.topic",
  note: "contextPanel.ask.description.note",
  noteUnplaced: "contextPanel.ask.description.noteUnplaced",
  entity: "contextPanel.ask.description.entity",
  library: "contextPanel.ask.description.library"
} as const satisfies Record<AskVariant, MessageKey>;

/** The heading and the one line that says what the answer will use. */
export function AskHeading({ t, target }: { t: Translator; target: AskTarget }) {
  const untitled = t("panelFrame.ribbon.untitled");
  const values = { topic: target.topicTitle?.trim() || untitled };
  return (
    <ContextHeading
      title={t(titles[target.variant], { values })}
      description={t(descriptions[target.variant])}
    />
  );
}

/** "You can already ask: the 142 passages are indexed. The notes are still arriving." */
export function IndexedNotice({ t, line }: { t: Translator; line: IndexedLine }) {
  const text =
    line.kind === "indexing"
      ? t("contextPanel.ask.indexing")
      : [
          t(line.count === 1 ? "contextPanel.ask.indexedOne" : "contextPanel.ask.indexedOther", {
            values: { count: new Intl.NumberFormat(t.locale).format(line.count) }
          }),
          line.arriving ? t("contextPanel.ask.notesArriving") : null
        ]
          .filter(Boolean)
          .join(" ");
  return (
    <p className="m-0 flex items-start gap-1.5 text-xs leading-5 text-secondary-foreground [text-wrap:pretty]">
      {line.kind === "indexed" ? (
        <CircleCheck aria-hidden="true" className="mt-[3px] size-3 flex-none text-success" />
      ) : null}
      <span className="min-w-0">{text}</span>
    </p>
  );
}

/** What the tab is while the scope is not known: the heading and the field, shaped like themselves. */
function AskLoadingScope({ t }: { t: Translator }) {
  return (
    <LoadingState t={t} className="gap-3">
      <div className="grid gap-1.5">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/5" />
      </div>
      <Skeleton className="h-12 w-full rounded-lg" />
    </LoadingState>
  );
}

function EarlierLoading({ t }: { t: Translator }) {
  return (
    <LoadingState t={t} className="gap-3">
      {[0, 1].map((row) => (
        <div key={row} className="grid gap-1.5">
          <Skeleton className={row === 0 ? "h-3.5 w-11/12" : "h-3.5 w-3/4"} />
          <Skeleton className="h-3 w-1/4" />
        </div>
      ))}
    </LoadingState>
  );
}

export interface AskViewProps {
  t: Translator;
  kind: ContextTabProps["kind"];
  /** The scope: still being read (a note's place), failed, or known. */
  scope: { status: "loading" } | { status: "error" } | { status: "ready"; target: AskTarget };
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  sendFailed: boolean;
  /** Only a source has a milestone line. */
  indexed: IndexedLine | null;
  earlier: Read<readonly QuestionListItemView[]>;
  onOpen: ContextTabProps["onOpen"];
  onRetryScope: () => void;
  onRetryEarlier: () => void;
}

/** The tab's surface from what it reads; its own frame writes the state the screens tool checks. */
export function AskView(props: AskViewProps) {
  const { t, kind, scope, value, sending, sendFailed, earlier } = props;
  const rows = earlier.status === "ready" ? earlier.value : [];
  const state = askTabState({
    scope: scope.status,
    sendFailed,
    earlier: earlier.status === "ready" ? "ready" : earlier.status,
    earlierCount: rows.length
  });
  return (
    <ContextFrame surface={surface} state={state}>
      {scope.status === "loading" ? (
        <AskLoadingScope t={t} />
      ) : scope.status === "error" ? (
        <>
          <ContextHeading
            title={t("contextPanel.ask.title.pending")}
            description={t("contextPanel.ask.description.pending")}
          />
          <ContextError
            t={t}
            message="contextPanel.ask.errors.scope"
            kept={kind}
            onRetry={props.onRetryScope}
          />
        </>
      ) : (
        <>
          <AskHeading t={t} target={scope.target} />
          <div className="grid gap-2">
            <AskComposer
              t={t}
              value={value}
              onChange={props.onChange}
              onSend={props.onSend}
              busy={sending}
              label={t("askPanel.launcher.draftLabel")}
              placeholder={t("askPanel.launcher.placeholder")}
              sendLabel={t("askPanel.launcher.submit")}
            />
            {sending ? (
              <p role="status" className="m-0 text-xs text-secondary-foreground">
                {t("askPanel.launcher.starting")}
              </p>
            ) : null}
            {props.indexed ? <IndexedNotice t={t} line={props.indexed} /> : null}
          </div>
          {sendFailed ? (
            <ErrorState
              t={t}
              className="mt-3"
              message={t("askPanel.launcher.error.message")}
              kept={t("askPanel.launcher.error.kept")}
              retryLabel={t("shell.actions.retry")}
              {...(askTextState(value) === "ok" ? { onRetry: props.onSend } : {})}
            />
          ) : null}
          <div className="mt-5">
            {earlier.status === "loading" ? (
              <EarlierLoading t={t} />
            ) : earlier.status === "error" ? (
              sendFailed ? null : (
                <ErrorState
                  t={t}
                  message={t("contextPanel.ask.errors.earlier")}
                  kept={t("contextPanel.ask.errors.earlierKept")}
                  retryLabel={t("shell.actions.retry")}
                  onRetry={props.onRetryEarlier}
                />
              )
            ) : rows.length === 0 ? (
              <ContextEmpty>{t("contextPanel.ask.empty")}</ContextEmpty>
            ) : (
              <section aria-label={t("contextPanel.ask.earlier.label")}>
                <GroupHeading>{t("contextPanel.ask.earlier.heading")}</GroupHeading>
                {rows.map((item) => (
                  <ContextRow
                    key={item.id}
                    t={t}
                    object={{
                      address: formatObjectAddress({ kind: "question", id: item.id }),
                      kind: "question",
                      title: item.text
                    }}
                    path={false}
                    meta={[answerDate(t, item.createdAt)].filter((part) => part !== "")}
                    onOpen={props.onOpen}
                  />
                ))}
              </section>
            )}
          </div>
        </>
      )}
    </ContextFrame>
  );
}

export function AskTab(props: ContextTabProps) {
  const { t, kind, id, address, active, onOpen, onState } = props;
  // A note asks the topic it is in: where it is, read before the field appears.
  const placed = useLocate(address, active && kind === "note");
  const primary =
    kind !== "note"
      ? null
      : placed.read.status === "ready"
        ? primaryTopic(placed.read.value)
        : undefined;
  const target = askTarget(kind, id, primary);
  const scope: AskViewProps["scope"] =
    kind === "note" && placed.read.status === "error"
      ? { status: "error" }
      : target
        ? { status: "ready", target }
        : { status: "loading" };

  // An entity's name goes into the field, to be asked about or rewritten.
  const resolved = useResolved(kind === "entity" ? [address] : [], { active, path: false });
  const name = kind === "entity" ? (resolved.get(address)?.title ?? "").trim() : "";
  const [value, setValue] = useState("");
  const touched = useRef(false);
  useEffect(() => {
    if (name !== "" && !touched.current) setValue(name);
  }, [name]);

  // The questions already asked of this scope; a new one reads the list again.
  const scopeKey = target ? JSON.stringify(target.scope) : "";
  const list = useContextRead<readonly QuestionListItemView[]>({
    key: `ask-earlier:${scopeKey}`,
    active: active && target !== null,
    follow: [],
    load: async (app) => (await app.questions.list({ limit: 50 })).items
  });
  const earlier: Read<readonly QuestionListItemView[]> =
    list.read.status === "ready" && target
      ? { status: "ready", value: earlierQuestions(list.read.value, target.scope) }
      : list.read.status === "ready"
        ? { status: "loading" }
        : list.read;

  // The Question exists: its page opens beside the focused panel, and the field is free again.
  const asked = useStableCallback((questionId: string) => {
    setValue("");
    touched.current = false;
    list.reread();
    onOpen(formatObjectAddress({ kind: "question", id: questionId }));
  });
  const [controller] = useState(
    () =>
      new AskLauncherController({
        api: () => (typeof window === "undefined" ? undefined : window.app?.questions),
        onAsked: asked
      })
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const send = useStableCallback(() => {
    if (!target || askTextState(value) !== "ok") return;
    controller.ask({ text: value, scope: target.scope });
  });

  // The source's milestone line: its passages are searchable before any note exists.
  const progress = useContextRead({
    key: `ask-progress:${id}`,
    active: active && kind === "source",
    follow: [address],
    load: (app) => app.library.sourceProgress({ sourceId: id })
  });
  // The passages are counted as they are indexed: a running job tells, nothing polls.
  useAppEvent("job.progress", progress.reread, active && kind === "source");
  const indexed =
    kind === "source" && progress.read.status === "ready" ? indexedLine(progress.read.value) : null;

  const sendFailed = snapshot.send.status === "error";
  const state = askTabState({
    scope: scope.status,
    sendFailed,
    earlier: earlier.status === "ready" ? "ready" : earlier.status,
    earlierCount: earlier.status === "ready" ? earlier.value.length : 0
  });
  useReportedState(state, onState);
  useReportedCount(null, props.onCount);
  return (
    <AskView
      t={t}
      kind={kind}
      scope={scope}
      value={value}
      onChange={(next) => {
        touched.current = true;
        controller.clearError();
        setValue(next);
      }}
      onSend={send}
      sending={snapshot.send.status === "asking"}
      sendFailed={sendFailed}
      indexed={indexed}
      earlier={earlier}
      onOpen={onOpen}
      onRetryScope={placed.retry}
      onRetryEarlier={list.retry}
    />
  );
}
export { AskTab as Component };
