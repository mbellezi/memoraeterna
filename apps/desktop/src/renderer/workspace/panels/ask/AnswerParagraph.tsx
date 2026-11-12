import { Fragment, type ReactNode } from "react";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph } from "../../../components/glyphs";
import { cn } from "../../../lib/cn";
import { ObjectLink, useObjectLinkContext } from "../../ObjectLink";
import { parseMarkdownObjectLink } from "../../ObjectLinkModel";
import { splitParagraph, type AnswerParagraph as Paragraph } from "./answer-model";

/**
 * One paragraph of an answer, in the reading serif, with its citations as chips (design record
 * §10.3). A chip is inline and 20 tall, holds the source glyph and its number, and attaches to the
 * word before it with a no-break thin space; punctuation follows it directly. On hover or focus it
 * turns accent and asks the sources list to expand its passage (`onActivate`); a click or Enter
 * opens the passage beside (`onOpen`). It draws no card: the passage is read in the sources list or
 * the tray, never over the answer.
 */

/** The no-break thin space that binds a chip to the word before it. */
const thinSpace = " ";

const inlinePattern = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(memora:\/\/[^)\s]+\))/g;

/** The words of a run, with the Markdown a model writes inside a sentence turned into marks. */
function renderWords(text: string, keyBase: string): ReactNode[] {
  return text.split(inlinePattern).map((token, index) => {
    const key = `${keyBase}:${index}`;
    if (token.startsWith("**") && token.endsWith("**") && token.length > 4)
      return <strong key={key}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("`") && token.endsWith("`") && token.length > 2)
      return (
        <code
          key={key}
          className="rounded-sm bg-soft px-1 py-0.5 font-mono text-[0.9em] text-foreground"
        >
          {token.slice(1, -1)}
        </code>
      );
    if (token.startsWith("*") && token.endsWith("*") && token.length > 2)
      return <em key={key}>{token.slice(1, -1)}</em>;
    const link = token.startsWith("[") ? parseMarkdownObjectLink(token) : null;
    if (link) return <AnswerLink key={key} {...link} />;
    return <Fragment key={key}>{token}</Fragment>;
  });
}

/** `[text](memora://…)` opens the object beside the panel; outside a panel it is its text. */
function AnswerLink({ label, address }: { label: string; address: string }) {
  const context = useObjectLinkContext();
  if (!context) return <>{label}</>;
  return <ObjectLink address={address}>{label}</ObjectLink>;
}

export interface CitationChipProps {
  t: Translator;
  number: number;
  /** The id of the sources-list entry this chip stands for. */
  entryId: string;
  active: boolean;
  onActivate: (number: number) => void;
  onOpen: (number: number) => void;
}

export function CitationChip({
  t,
  number,
  entryId,
  active,
  onActivate,
  onOpen
}: CitationChipProps) {
  return (
    <button
      type="button"
      data-citation={number}
      data-active={active ? "" : undefined}
      aria-label={t("askPanel.chip.labelPlain", { values: { number } })}
      aria-controls={entryId}
      aria-current={active ? "true" : undefined}
      onMouseEnter={() => onActivate(number)}
      onFocus={() => onActivate(number)}
      onClick={() => onOpen(number)}
      className={cn(
        "ml-[0.12em] inline-flex h-5 scroll-mb-40 items-center gap-0.5 rounded-sm border px-1 align-baseline font-sans text-xs leading-none font-medium tabular-nums",
        "cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
        active
          ? "border-accent bg-accent-soft text-accent"
          : "border-border bg-soft text-secondary-foreground hover:border-accent hover:text-accent"
      )}
    >
      <ObjectKindGlyph kind="source" size={12} />
      {number}
    </button>
  );
}

export interface AnswerParagraphProps extends Omit<
  CitationChipProps,
  "number" | "entryId" | "active"
> {
  paragraph: Paragraph;
  /** The number of the chip that is hovered or focused, or null. */
  activeNumber: number | null;
  numberOf: ReadonlyMap<number, number>;
  entryId: (number: number) => string;
  /** This is the last paragraph so far and more is being written: a caret follows its words. */
  writing?: boolean;
}

export function AnswerParagraphView({
  paragraph,
  numberOf,
  entryId,
  activeNumber,
  writing = false,
  ...chip
}: AnswerParagraphProps) {
  const pieces = splitParagraph(paragraph, numberOf);
  return (
    <p
      data-answer-paragraph=""
      className="m-0 font-reading text-reading text-foreground [text-wrap:pretty] [overflow-wrap:anywhere]"
    >
      {pieces.map((piece, index) =>
        piece.type === "text" ? (
          <Fragment key={index}>{renderWords(piece.text, `t${index}`)}</Fragment>
        ) : (
          <Fragment key={index}>
            {/* A chip binds to the word before it: the space between them is a thin no-break one. */}
            {piece.attached ? thinSpace : null}
            <CitationChip
              {...chip}
              number={piece.number}
              entryId={entryId(piece.number)}
              active={activeNumber === piece.number}
            />
          </Fragment>
        )
      )}
      {writing ? (
        <span
          aria-hidden="true"
          data-answer-caret=""
          className="ml-1 inline-block h-[1.05em] w-0.5 translate-y-[0.2em] rounded-full bg-accent"
        />
      ) : null}
    </p>
  );
}
