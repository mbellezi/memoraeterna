import { useId, type KeyboardEvent, type Ref } from "react";
import { ArrowUp } from "lucide-react";
import type { Translator } from "@app/i18n";

import { Button } from "../../../components/ui/button";
import { Kbd } from "../../../components/ui/kbd";
import { Tooltip } from "../../../components/ui/tooltip";
import { cn } from "../../../lib/cn";
import { askTextState, questionAskTextLimits } from "./ask-scope";

/**
 * The field a question is written in, for the Ask panel and the follow-up under an answer (and for
 * the context panel's Ask tab, which embeds it). Enter sends, Shift-Enter starts a new line, and a
 * line composed with an input method (an accent being built) is never sent. The words are checked
 * against `questions.ask`'s own bounds, so the field never sends a value the schema would refuse.
 */

export interface AskComposerProps {
  t: Translator;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** A send is under way: the field and the button wait. */
  busy?: boolean;
  /** The label for assistive technology (the field has no visible label). */
  label: string;
  placeholder: string;
  sendLabel: string;
  /** The roomy form of the Ask panel; absent, the one-row form of a follow-up. */
  roomy?: boolean;
  /** Show the Enter and Shift-Enter hints under the field. */
  hints?: boolean;
  inputRef?: Ref<HTMLTextAreaElement> | undefined;
  /**
   * How loud the send button is: primary by default. After a failed send the panel's one "Tentar de
   * novo" is the only labelled action, so the send button steps down to secondary and loses its
   * label (an icon with its name on hover and for a screen reader); Enter still sends.
   */
  submitVariant?: "primary" | "secondary";
  className?: string;
}

/** Whether a key press sends the question: Enter alone, never Shift-Enter or a line being composed. */
export function enterSends(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function AskComposer({
  t,
  value,
  onChange,
  onSend,
  busy = false,
  label,
  placeholder,
  sendLabel,
  roomy = false,
  hints = false,
  inputRef,
  submitVariant = "primary",
  className
}: AskComposerProps) {
  const noteId = useId();
  const state = askTextState(value);
  // A word of guidance only once the person has written something: an empty field says nothing.
  const note =
    value.trim() === ""
      ? null
      : state === "short"
        ? "askPanel.launcher.short"
        : state === "long"
          ? "askPanel.launcher.long"
          : null;
  const canSend = state === "ok" && !busy;

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!enterSends({ ...event, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    if (canSend) onSend();
  };

  const sendButton = (
    <Button
      type="button"
      variant={submitVariant}
      aria-label={sendLabel}
      disabled={!canSend}
      aria-busy={busy}
      onClick={onSend}
      className="h-8 shrink-0 px-2.5"
    >
      <ArrowUp aria-hidden="true" />
      {roomy && submitVariant === "primary" ? sendLabel : null}
    </Button>
  );
  // A button without a visible label keeps its name reachable on hover and focus.
  const iconOnly = !roomy || submitVariant !== "primary";

  return (
    <div className={cn("grid min-w-0 max-w-(--measure) gap-1.5", className)}>
      <div
        className={cn(
          "min-w-0 rounded-lg border border-border-strong bg-surface",
          "focus-within:border-accent focus-within:[box-shadow:0_0_0_2px_var(--surface-selected)]",
          // The roomy field keeps its button in a row of its own under the words, so the text uses
          // the whole measure instead of stopping short of a button beside it.
          roomy ? "grid gap-2 p-3" : "flex items-end gap-2 p-2"
        )}
      >
        <textarea
          ref={inputRef}
          value={value}
          rows={roomy ? 3 : 1}
          maxLength={questionAskTextLimits.max + 200}
          readOnly={busy}
          aria-label={label}
          aria-describedby={note ? noteId : undefined}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={keyDown}
          className={cn(
            "block min-w-0 flex-1 resize-none border-0 bg-transparent p-1 font-reading text-reading text-foreground outline-none",
            "placeholder:text-muted-foreground [field-sizing:content] [overflow-wrap:anywhere]",
            roomy ? "max-h-48 min-h-14" : "max-h-32 min-h-8 text-base"
          )}
        />
        {iconOnly ? (
          // The span keeps the tooltip reachable while the button is disabled (an empty field).
          <Tooltip label={sendLabel} shortcut="↵">
            <span
              className={roomy ? "inline-flex shrink-0 justify-self-end" : "inline-flex shrink-0"}
            >
              {sendButton}
            </span>
          </Tooltip>
        ) : (
          <div className="flex justify-end">{sendButton}</div>
        )}
      </div>
      {note ? (
        <p id={noteId} className="m-0 text-xs text-secondary-foreground">
          {t(note)}
        </p>
      ) : hints ? (
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Kbd>↵</Kbd> {t("askPanel.launcher.hintAsk")}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>⇧↵</Kbd> {t("askPanel.launcher.hintNewline")}
          </span>
        </p>
      ) : null}
    </div>
  );
}
