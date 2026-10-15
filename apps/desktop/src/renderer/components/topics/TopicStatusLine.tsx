import { Info, LoaderCircle } from "lucide-react";
import type { Translator } from "@app/i18n";
import { Button } from "../ui/button";
import { reembedOffer, type ReembedState, type StatusLine } from "./topic-status";

export interface TopicStatusLineProps {
  t: Translator;
  lines: readonly StatusLine[];
  reembed: ReembedState;
  onAskReembed: () => void;
  onConfirmReembed: () => void;
  onCancelReembed: () => void;
}

function lineText(t: Translator, line: StatusLine, format: (value: number) => string): string {
  switch (line.kind) {
    case "building":
      return line.items > 0
        ? t("topics.status.building", {
            values: { placed: format(line.placed), items: format(line.items) }
          })
        : t("topics.status.buildingStart");
    case "blocked":
      return t(`topics.status.blocked.${line.reason}`);
    case "dailyCap":
      return t("topics.status.dailyCap");
  }
}

/**
 * One quiet line per thing the engine is waiting for: the first build, a missing or changed
 * embedding model, no ranking model, the day's naming budget. It informs and never blocks; the one
 * action is "Re-embed library", asked for with a confirmation because it can be a long, remote job.
 * The container is a polite live region, so a change in the status is announced.
 */
export function TopicStatusLine({
  t,
  lines,
  reembed,
  onAskReembed,
  onConfirmReembed,
  onCancelReembed
}: TopicStatusLineProps) {
  const format = (value: number) => new Intl.NumberFormat(t.locale).format(value);
  const offered = reembedOffer(lines);
  const showOffer = offered !== null && reembed !== "queued";
  const notes = offered ?? 0;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t("topics.status.label")}
      className="grid gap-1"
    >
      {lines.map((line) => (
        <p
          key={line.kind === "blocked" ? `blocked:${line.reason}` : line.kind}
          className="flex items-start gap-2 rounded-md bg-soft px-2 py-1.5 text-xs leading-5 text-secondary-foreground"
        >
          {line.kind === "building" ? (
            <LoaderCircle
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            />
          ) : (
            <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span className="min-w-0 [overflow-wrap:anywhere]">{lineText(t, line, format)}</span>
        </p>
      ))}
      {reembed === "queued" ? (
        <p className="rounded-md bg-soft px-2 py-1.5 text-xs leading-5 text-secondary-foreground">
          {t("topics.status.reembedQueued")}
        </p>
      ) : null}
      {showOffer && reembed === "idle" ? (
        <Button type="button" variant="link" className="justify-start" onClick={onAskReembed}>
          {t("topics.status.reembed")}
        </Button>
      ) : null}
      {showOffer && reembed === "failed" ? (
        <div className="grid gap-1">
          <p role="alert" className="px-2 text-xs leading-5 text-danger">
            {t("topics.status.reembedFailed")}
          </p>
          <Button type="button" variant="link" className="justify-start" onClick={onAskReembed}>
            {t("topics.status.reembed")}
          </Button>
        </div>
      ) : null}
      {showOffer && (reembed === "confirming" || reembed === "working") ? (
        <div
          role="group"
          aria-label={t("topics.status.reembed")}
          className="grid gap-2 rounded-md border border-border-strong p-2"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || reembed !== "confirming") return;
            event.stopPropagation();
            onCancelReembed();
          }}
        >
          <p className="text-xs leading-5 text-foreground">
            {t("topics.status.reembedAsk", { values: { count: format(notes) } })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="primary"
              disabled={reembed === "working"}
              onClick={onConfirmReembed}
            >
              {reembed === "working"
                ? t("topics.status.reembedWorking")
                : t("topics.status.reembedConfirm")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={reembed === "working"}
              onClick={onCancelReembed}
            >
              {t("shell.actions.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
