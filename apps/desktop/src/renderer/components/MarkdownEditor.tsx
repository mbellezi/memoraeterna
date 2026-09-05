import { Fragment, useRef, useState, type ReactNode } from "react";
import {
  Bold, CheckSquare2, Code2, Columns2, Eye, Heading1, Heading2, Italic, Link2,
  List, ListOrdered, Minus, PencilLine, Quote, Strikethrough
} from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";

import { cn } from "../lib/cn";

export type MarkdownEditorMode = "write" | "preview" | "split";

export function MarkdownEditor({
  id,
  value,
  onChange,
  t,
  label,
  required = false,
  minHeightClass = "min-h-80"
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  t: Translator;
  label: string;
  required?: boolean;
  minHeightClass?: string;
}) {
  const [mode, setMode] = useState<MarkdownEditorMode>("write");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const wordCount = value.trim() ? value.trim().split(/\s+/).length : 0;

  function applyMarkdown(before: string, after = before, fallback = "text") {
    const element = textarea.current;
    if (!element) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const selection = value.slice(start, end) || fallback;
    const next = `${value.slice(0, start)}${before}${selection}${after}${value.slice(end)}`;
    onChange(next);
    window.requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + before.length, start + before.length + selection.length);
    });
  }

  function applyLinePrefix(prefix: string, fallback: string) {
    const element = textarea.current;
    if (!element) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const selected = value.slice(lineStart, end) || fallback;
    const transformed = selected.split("\n").map((line) => `${prefix}${line}`).join("\n");
    onChange(`${value.slice(0, lineStart)}${transformed}${value.slice(end)}`);
    window.requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(lineStart + prefix.length, lineStart + transformed.length);
    });
  }

  function insertBlock(block: string) {
    const element = textarea.current;
    if (!element) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const leadingBreak = start > 0 && value[start - 1] !== "\n" ? "\n\n" : "";
    const trailingBreak = end < value.length && value[end] !== "\n" ? "\n\n" : "";
    const next = `${value.slice(0, start)}${leadingBreak}${block}${trailingBreak}${value.slice(end)}`;
    onChange(next);
    window.requestAnimationFrame(() => {
      element.focus();
      const cursor = start + leadingBreak.length + block.length;
      element.setSelectionRange(cursor, cursor);
    });
  }

  const modes: Array<{ id: MarkdownEditorMode; icon: typeof PencilLine }> = [
    { id: "write", icon: PencilLine },
    { id: "preview", icon: Eye },
    { id: "split", icon: Columns2 }
  ];
  const tools: Array<{ key: MessageKey; icon: typeof Bold; action: () => void; divider?: boolean }> = [
    { key: "markdown.toolbar.heading1", icon: Heading1, action: () => applyLinePrefix("# ", t("markdown.placeholders.heading")) },
    { key: "markdown.toolbar.heading2", icon: Heading2, action: () => applyLinePrefix("## ", t("markdown.placeholders.heading")) },
    { key: "markdown.toolbar.bold", icon: Bold, action: () => applyMarkdown("**", "**", t("markdown.placeholders.text")) },
    { key: "markdown.toolbar.italic", icon: Italic, action: () => applyMarkdown("_", "_", t("markdown.placeholders.text")) },
    { key: "markdown.toolbar.strikethrough", icon: Strikethrough, action: () => applyMarkdown("~~", "~~", t("markdown.placeholders.text")) },
    { key: "markdown.toolbar.link", icon: Link2, action: () => applyMarkdown("[", "](https://)", t("markdown.placeholders.link")), divider: true },
    { key: "markdown.toolbar.list", icon: List, action: () => applyLinePrefix("- ", t("markdown.placeholders.listItem")) },
    { key: "markdown.toolbar.orderedList", icon: ListOrdered, action: () => applyLinePrefix("1. ", t("markdown.placeholders.listItem")) },
    { key: "markdown.toolbar.checklist", icon: CheckSquare2, action: () => applyLinePrefix("- [ ] ", t("markdown.placeholders.listItem")) },
    { key: "markdown.toolbar.quote", icon: Quote, action: () => applyLinePrefix("> ", t("markdown.placeholders.quote")), divider: true },
    { key: "markdown.toolbar.code", icon: Code2, action: () => applyMarkdown("`", "`", t("markdown.placeholders.code")) },
    { key: "markdown.toolbar.codeBlock", icon: Code2, action: () => insertBlock(`\`\`\`\n${t("markdown.placeholders.codeBlock")}\n\`\`\``) },
    { key: "markdown.toolbar.rule", icon: Minus, action: () => insertBlock("---"), divider: true }
  ];

  return <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/80 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/70">
      <label htmlFor={id} className="px-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
        {label}{required ? " *" : ""}
      </label>
      <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-950" role="tablist" aria-label={t("markdown.modeLabel")}>
        {modes.map(({ id: item, icon: Icon }) => <button
          key={item}
          type="button"
          role="tab"
          aria-selected={mode === item}
          onClick={() => setMode(item)}
          className={cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition", mode === item ? "bg-slate-900 text-white shadow-sm dark:bg-slate-100 dark:text-slate-950" : "text-slate-500 hover:text-slate-900 dark:hover:text-slate-100")}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />{t(`markdown.modes.${item}` as MessageKey)}
        </button>)}
      </div>
    </div>
    {mode !== "preview" ? <div className="flex flex-wrap gap-1 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
      {tools.map(({ key, icon: Icon, action, divider }) => <Fragment key={key}>
        {divider ? <span className="mx-1 h-6 w-px self-center bg-slate-200 dark:bg-slate-700" aria-hidden="true" /> : null}
        <button type="button" title={t(key)} aria-label={t(key)} onClick={action} className="grid h-8 w-8 place-items-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-950 dark:hover:bg-slate-800 dark:hover:text-white">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      </Fragment>)}
    </div> : null}
    <div className={cn("grid", mode === "split" && "lg:grid-cols-2")}>
      {mode !== "preview" ? <textarea
        ref={textarea}
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("markdown.placeholder")}
        spellCheck
        className={cn(minHeightClass, "w-full resize-y border-0 bg-white p-5 font-mono text-sm leading-7 text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 dark:bg-slate-950 dark:text-slate-100", mode === "split" && "border-r border-slate-200 dark:border-slate-800")}
      /> : null}
      {mode !== "write" ? <div className={cn(minHeightClass, "overflow-auto bg-white p-5 dark:bg-slate-950")} aria-label={t("markdown.previewLabel")}>
        <MarkdownPreview markdown={value} emptyLabel={t("markdown.emptyPreview")} />
      </div> : null}
    </div>
    <div className="flex justify-between border-t border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-slate-800">
      <span>{t("markdown.markdownSupported")}</span>
      <span>{t("markdown.stats", { values: { words: wordCount, characters: value.length } })}</span>
    </div>
  </div>;
}

export function MarkdownPreview({ markdown, emptyLabel }: { markdown: string; emptyLabel: string }) {
  const blocks = parseBlocks(markdown);
  if (blocks.length === 0) return <p className="text-sm italic text-slate-400">{emptyLabel}</p>;
  return <div className="grid gap-4 text-[15px] leading-7 text-slate-700 dark:text-slate-200">{blocks.map((block, index) => renderBlock(block, index))}</div>;
}

type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "code"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "rule" };

function parseBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ type: "paragraph", text });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().startsWith("```")) {
      if (code) { blocks.push({ type: "code", text: code.join("\n") }); code = null; }
      else { flushParagraph(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { flushParagraph(); blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]! }); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flushParagraph(); blocks.push({ type: "rule" }); continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { flushParagraph(); blocks.push({ type: "quote", text: quote[1]! }); continue; }
    const list = line.match(/^\s*(?:(\d+)[.)]|[-*+])\s+(.+)$/);
    if (list) {
      flushParagraph();
      const ordered = Boolean(list[1]);
      const previous = blocks.at(-1);
      if (previous?.type === "list" && previous.ordered === ordered) previous.items.push(list[2]!);
      else blocks.push({ type: "list", ordered, items: [list[2]!] });
      continue;
    }
    if (!line.trim()) flushParagraph();
    else paragraph.push(line);
  }
  if (code) blocks.push({ type: "code", text: code.join("\n") });
  flushParagraph();
  return blocks;
}

function renderBlock(block: MarkdownBlock, key: number): ReactNode {
  if (block.type === "heading") {
    const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
    return <Tag key={key} className={cn("font-semibold tracking-tight text-slate-950 dark:text-white", block.level === 1 ? "text-3xl" : block.level === 2 ? "text-2xl" : block.level === 3 ? "text-xl" : "text-lg")}>{renderInline(block.text)}</Tag>;
  }
  if (block.type === "paragraph") return <p key={key} className="whitespace-pre-wrap">{renderInline(block.text)}</p>;
  if (block.type === "quote") return <blockquote key={key} className="border-l-4 border-cyan-400 bg-cyan-50/70 py-2 pl-4 pr-3 italic dark:bg-cyan-950/30">{renderInline(block.text)}</blockquote>;
  if (block.type === "code") return <pre key={key} className="overflow-auto rounded-xl bg-slate-950 p-4 text-sm leading-6 text-slate-100"><code>{block.text}</code></pre>;
  if (block.type === "rule") return <hr key={key} className="border-slate-200 dark:border-slate-800" />;
  const Tag = block.ordered ? "ol" : "ul";
  const checklist = !block.ordered && block.items.every((item) => /^\[[ xX]\]\s+/.test(item));
  return <Tag key={key} className={cn("grid gap-1", checklist ? "list-none pl-0" : "pl-6", !checklist && (block.ordered ? "list-decimal" : "list-disc"))}>{block.items.map((item, itemIndex) => {
    const task = item.match(/^\[([ xX])\]\s+(.+)$/);
    return <li key={itemIndex} className={cn(task && "flex items-start gap-2")}>
      {task ? <><input type="checkbox" checked={task[1]!.toLowerCase() === "x"} readOnly tabIndex={-1} className="mt-1.5 accent-cyan-700" />{renderInline(task[2]!)}</> : renderInline(item)}
    </li>;
  })}</Tag>;
}

function renderInline(text: string): ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\(https?:\/\/[^)]+\))/g);
  return tokens.map((token, index) => {
    if (token.startsWith("`") && token.endsWith("`")) return <code key={index} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.9em] dark:bg-slate-800">{token.slice(1, -1)}</code>;
    if ((token.startsWith("**") && token.endsWith("**")) || (token.startsWith("__") && token.endsWith("__"))) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("~~") && token.endsWith("~~")) return <del key={index}>{token.slice(2, -2)}</del>;
    if ((token.startsWith("*") && token.endsWith("*")) || (token.startsWith("_") && token.endsWith("_"))) return <em key={index}>{token.slice(1, -1)}</em>;
    const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer" className="text-cyan-700 underline underline-offset-2 dark:text-cyan-300">{link[1]}</a>;
    return <Fragment key={index}>{token}</Fragment>;
  });
}
