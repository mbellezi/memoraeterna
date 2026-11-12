import { useId, type Ref } from "react";
import { formatObjectAddress } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { EmptyState } from "../../../components/ui/empty-state";
import { ErrorState } from "../../../components/ui/error-state";
import { LoadingState, Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import type { QuestionListItemView } from "../../../../shared/ipc-questions";
import { useObjectPreview } from "../../ObjectLink";
import { titleOf } from "../../ObjectLinkModel";
import { AskComposer } from "./AskComposer";
import type { LauncherSnapshot } from "./ask-launcher";
import { askTextState, type ScopeRead } from "./ask-scope";
import { answerDate } from "./StatusBand";

/**
 * The Ask panel (design record §6.4, §5.6): where a question is written. It is the way in for the
 * Cmd-K "?" trigger, the Perguntar tab and "Ask about this topic": an address with words asks at
 * once (the panel then becomes the Question's own page), and one without them shows the field, the
 * scope that will be asked and the questions asked recently. It draws the four states of the panel
 * contract: the question being sent, what this is and what to do when nothing was asked yet, one
 * quiet failure in place that keeps the words, and the field with the recent questions.
 */

export interface AskLauncherViewProps {
  t: Translator;
  mode: "full" | "compact";
  snapshot: LauncherSnapshot;
  scope: ScopeRead;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onOpen: (address: string, options?: { replace?: boolean }) => void;
  inputRef?: Ref<HTMLTextAreaElement> | undefined;
}

/** The four states of the panel, as its frame is told. */
export function launcherState(
  snapshot: LauncherSnapshot,
  scope: ScopeRead
): "loading" | "empty" | "error" | "success" {
  if (scope.status === "unsupported" || snapshot.send.status === "error") return "error";
  if (snapshot.send.status === "asking" || snapshot.recents.status === "loading") return "loading";
  return snapshot.recents.items.length === 0 ? "empty" : "success";
}

/** The scope line: what will be asked about, always written. */
function ScopeLine({ t, scope }: { t: Translator; scope: ScopeRead }) {
  const object = scope.status === "ok" ? scope.object : null;
  const preview = useObjectPreview(object ?? "", object !== null);
  let text: string | null = null;
  if (scope.status === "ok") {
    if (scope.scope.kind === "library") text = t("askPanel.launcher.scope.library");
    else if (preview.state.status === "ready")
      text = t(
        scope.scope.kind === "topic"
          ? "askPanel.launcher.scope.topic"
          : "askPanel.launcher.scope.source",
        {
          values: {
            title: titleOf(
              preview.state.item,
              t(scope.scope.kind === "topic" ? "objects.kinds.topic" : "objects.kinds.source")
            )
          }
        }
      );
  }
  if (text === null) return <p className="m-0 h-5" aria-hidden="true" />;
  return (
    <p className="m-0 flex min-w-0 items-baseline gap-1.5 text-sm text-secondary-foreground">
      <span className="font-medium text-foreground">{t("askPanel.launcher.scope.label")}:</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </p>
  );
}

function RecentRow({
  t,
  item,
  onOpen
}: {
  t: Translator;
  item: QuestionListItemView;
  onOpen: AskLauncherViewProps["onOpen"];
}) {
  const date = answerDate(t, item.createdAt);
  return (
    <li>
      <button
        type="button"
        onClick={(event) =>
          onOpen(
            formatObjectAddress({ kind: "question", id: item.id }),
            event.altKey ? { replace: true } : undefined
          )
        }
        className={cn(
          "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground",
          "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
        )}
      >
        <ObjectKindGlyph
          kind="question"
          size={14}
          className={cn("mt-[3px]", objectKindTextClass.question)}
        />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 [overflow-wrap:anywhere]" title={item.text}>
            {item.text}
          </span>
        </span>
        {date ? (
          <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
            {date}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export function AskLauncherView(props: AskLauncherViewProps) {
  const { t, mode, snapshot, scope, value, onChange, onSend, onOpen, inputRef } = props;
  const compact = mode === "compact";
  const sending = snapshot.send.status === "asking";
  const recentId = useId();

  if (compact)
    return (
      <div className="grid min-w-0 gap-2">
        <h1 className="m-0 font-reading text-lg leading-snug font-semibold text-foreground">
          {t("askPanel.launcher.heading")}
        </h1>
        <ScopeLine t={t} scope={scope} />
      </div>
    );

  return (
    <section aria-label={t("askPanel.launcher.heading")} className="grid min-w-0 max-w-2xl gap-6">
      <header className="grid min-w-0 max-w-(--measure) gap-1.5">
        <h1 className="m-0 flex items-start gap-2 font-reading text-xl font-semibold text-foreground [text-wrap:balance]">
          <ObjectKindGlyph
            kind="question"
            size={20}
            className={cn("mt-[5px]", objectKindTextClass.question)}
          />
          {t("askPanel.launcher.heading")}
        </h1>
        <p className="m-0 text-sm text-secondary-foreground [text-wrap:pretty]">
          {t("askPanel.launcher.lead")}
        </p>
      </header>

      {scope.status === "unsupported" ? (
        <ErrorState
          t={t}
          className="max-w-(--measure)"
          message={t("askPanel.launcher.scope.unsupported")}
          kept={t("askPanel.launcher.scope.unsupportedKept")}
        />
      ) : (
        <div className="grid min-w-0 gap-2">
          <ScopeLine t={t} scope={scope} />
          <AskComposer
            t={t}
            roomy
            hints
            value={value}
            inputRef={inputRef}
            onChange={onChange}
            onSend={onSend}
            busy={sending}
            label={t("askPanel.launcher.draftLabel")}
            placeholder={t("askPanel.launcher.placeholder")}
            sendLabel={t("askPanel.launcher.submit")}
          />
          {sending ? (
            <p role="status" className="m-0 text-sm text-secondary-foreground">
              {t("askPanel.launcher.starting")}
            </p>
          ) : null}
        </div>
      )}

      {snapshot.send.status === "error" ? (
        <ErrorState
          t={t}
          className="max-w-(--measure)"
          message={t("askPanel.launcher.error.message")}
          kept={t("askPanel.launcher.error.kept")}
          retryLabel={t("shell.actions.retry")}
          {...(askTextState(value) === "ok" ? { onRetry: onSend } : {})}
        />
      ) : null}

      {snapshot.send.status === "error" &&
      snapshot.recents.status === "ready" &&
      snapshot.recents.items.length === 0 ? null : (
        <section aria-labelledby={recentId} className="grid min-w-0 max-w-(--measure) gap-1">
          <h2 id={recentId} className="m-0 text-sm font-semibold text-foreground">
            {t("askPanel.launcher.recent.heading")}
          </h2>
          {snapshot.recents.status === "loading" ? (
            <LoadingState t={t}>
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-start gap-2 px-2 py-2">
                  <Skeleton className="mt-[3px] size-3.5 shrink-0" />
                  <Skeleton className={row === 1 ? "w-2/3" : "w-5/6"} />
                </div>
              ))}
            </LoadingState>
          ) : snapshot.recents.items.length === 0 ? (
            <EmptyState headline={t("askPanel.launcher.empty.headline")}>
              {t("askPanel.launcher.empty.body")}
            </EmptyState>
          ) : (
            <ul
              aria-label={t("askPanel.launcher.recent.label")}
              className="m-0 -mx-2 grid list-none p-0"
            >
              {snapshot.recents.items.map((item) => (
                <RecentRow key={item.id} t={t} item={item} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
