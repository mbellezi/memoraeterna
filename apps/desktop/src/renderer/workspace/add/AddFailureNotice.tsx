import type { ReactNode } from "react";
import { X } from "lucide-react";
import type { Translator } from "@app/i18n";

import { SolidTriangle } from "../../components/ui/solid-glyphs";
import { Tooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import { failureKey } from "./add-model";
import type { AddFlow, AddFlowSnapshot } from "./add-flow";
import { useAddFlowSnapshot } from "./use-add-flow";

/** The notice's one plain sentence: the first failure of the run, and how many others there were. */
export function failureMessage(
  t: Translator,
  failure: NonNullable<AddFlowSnapshot["failure"]>
): string {
  const first = t(failureKey(failure), { values: { name: failure.name ?? "" } });
  return failure.more > 0
    ? `${first} ${t("addFlow.failure.more", { values: { count: failure.more } })}`
    : first;
}

/** The notice's shorter whole form, for a slot too narrow for the sentence on one line. */
export function failureShortMessage(
  t: Translator,
  failure: NonNullable<AddFlowSnapshot["failure"]>
): string {
  return t(failure.more > 0 ? "addFlow.failure.shortMany" : "addFlow.failure.shortOne");
}

/** The notice's two controls are small and quiet: a link-like retry and an icon close. */
const noticeControl = cn(
  "inline-flex shrink-0 items-center rounded-md text-xs transition-colors hover:bg-soft",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
);

/**
 * A file that could not be added, told in place in the title bar's status slot (design record 5.2:
 * toasts never float over content, and an error is a plain sentence, what is kept and "Tentar de
 * novo"). One quiet line at the size of the bar's other words: a solid triangle, the sentence, a
 * link to try again and a close. The sentence steps down to a shorter whole form when the slot is
 * too narrow for it on one line, so the bar never grows; what is kept is part of what a screen
 * reader announces. It stays until it is closed, the person tries again or opens the import panel.
 */
export function AddFailureNotice({ t, flow }: { t: Translator; flow: AddFlow }) {
  const { failure } = useAddFlowSnapshot(flow);
  if (!failure) return null;
  const kept = t(failure.saved ? "addFlow.failure.keptSome" : "addFlow.failure.kept");
  return (
    <div
      role="alert"
      data-add-failure=""
      className="@container flex min-w-0 flex-1 items-center justify-end gap-2 text-xs text-secondary-foreground"
    >
      <SolidTriangle className="shrink-0 text-danger" />
      <p className="m-0 min-w-0 whitespace-nowrap font-medium text-foreground">
        <span className="block truncate @[24rem]:hidden" aria-hidden="true">
          {failureShortMessage(t, failure)}
        </span>
        <span
          className="hidden truncate @[24rem]:block"
          aria-hidden="true"
          title={failureMessage(t, failure)}
        >
          {failureMessage(t, failure)}
        </span>
        {/* Whatever the slot shows, a screen reader hears the whole sentence and what is kept. */}
        <span className="sr-only">
          {failureMessage(t, failure)} {kept}
        </span>
      </p>
      <button
        type="button"
        className={cn(noticeControl, "px-1 font-medium text-accent hover:text-accent-hover")}
        onClick={() => void flow.pickFile()}
      >
        {failure.name === null ? t("shell.actions.retry") : t("addFlow.menu.file")}
      </button>
      <Tooltip label={t("addFlow.failure.close")}>
        <button
          type="button"
          aria-label={t("addFlow.failure.close")}
          className={cn(
            noticeControl,
            "size-6 justify-center text-muted-foreground hover:text-foreground"
          )}
          onClick={() => flow.dismissFailure()}
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * The title bar's status slot: the Activity pill, which a failed add replaces until it is closed, so
 * the bar never grows and nothing floats over the page. The pill stays mounted underneath, hidden,
 * so its drawer and its state are not lost.
 */
export function AddStatusSlot({
  t,
  flow,
  children
}: {
  t: Translator;
  flow: AddFlow;
  children: ReactNode;
}) {
  const { failure } = useAddFlowSnapshot(flow);
  return (
    <>
      <div className={cn(failure ? "hidden" : "contents")}>{children}</div>
      <AddFailureNotice t={t} flow={flow} />
    </>
  );
}
