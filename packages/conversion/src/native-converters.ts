import { DOMParser, parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";

import { createTextBlocks, normalizeMarkdown, sha256 } from "./markdown-normalizer.js";
import type { ConversionInput, MarkdownConversionResult } from "./types.js";

const textDecoder = new TextDecoder("utf-8", { fatal: false });

function result(markdown: string, engine: string, metadata: Record<string, unknown> = {}): MarkdownConversionResult {
  const normalized = normalizeMarkdown(markdown);
  return {
    status: normalized ? "converted" : "requires_ocr",
    markdown: normalized,
    contentHash: sha256(normalized),
    blocks: createTextBlocks(normalized),
    assets: [],
    engine,
    engineVersion: "1",
    profile: "standard",
    options: {},
    warnings: normalized ? [] : [{
      code: "empty_result",
      messageKey: "errors.conversion.emptyResult",
      recoverable: true
    }],
    quality: { textCoverage: normalized ? 1 : 0 },
    metadata
  };
}

export function convertPlainText(input: ConversionInput): MarkdownConversionResult {
  return result(textDecoder.decode(input.data), "native-text");
}

export function convertMarkdown(input: ConversionInput): MarkdownConversionResult {
  return result(textDecoder.decode(input.data), "native-markdown");
}

export function convertJson(input: ConversionInput): MarkdownConversionResult {
  const value = JSON.parse(textDecoder.decode(input.data)) as unknown;
  const formatted = JSON.stringify(value, null, 2);
  return result(`\`\`\`json\n${formatted}\n\`\`\``, "native-json");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (value || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>").trim();
}

export function convertCsv(input: ConversionInput): MarkdownConversionResult {
  const rows = parseCsv(textDecoder.decode(input.data));
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return result("", "native-csv");
  const normalizedRows = rows.map((row) => Array.from({ length: width }, (_, index) => escapeTableCell(row[index] ?? "")));
  const header = normalizedRows[0] ?? [];
  const body = normalizedRows.slice(1);
  const markdown = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
  return result(markdown, "native-csv", { rowCount: rows.length, columnCount: width });
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+.!-])/g, "\\$1");
}

export function convertXml(input: ConversionInput): MarkdownConversionResult {
  const text = textDecoder.decode(input.data);
  const document = new DOMParser().parseFromString(text, "text/xml");
  if (!document) throw new Error("Invalid XML document.");
  const entries = [...document.querySelectorAll("item, entry")];
  if (entries.length > 0) {
    const markdown = entries.map((entry) => {
      const title = entry.querySelector("title")?.textContent?.trim() ?? "";
      const link = entry.querySelector("link")?.getAttribute("href") ?? entry.querySelector("link")?.textContent?.trim();
      const content = entry.querySelector("content, description, summary")?.textContent?.trim() ?? "";
      return `${title ? `## ${escapeMarkdown(title)}\n\n` : ""}${link ? `[${link}](${link})\n\n` : ""}${content}`;
    }).join("\n\n");
    return result(markdown, "native-xml-feed", { entryCount: entries.length });
  }
  const rootName = document.documentElement?.localName ?? "document";
  return result(`# ${escapeMarkdown(rootName)}\n\n${document.documentElement?.textContent?.trim() ?? ""}`, "native-xml");
}

export function convertNotebook(input: ConversionInput): MarkdownConversionResult {
  const notebook = JSON.parse(textDecoder.decode(input.data)) as {
    cells?: Array<{ cell_type?: string; source?: string | string[]; outputs?: unknown[] }>;
    metadata?: Record<string, unknown>;
  };
  const markdown = (notebook.cells ?? []).map((cell) => {
    const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
    return cell.cell_type === "code" ? `\`\`\`python\n${source.trimEnd()}\n\`\`\`` : source;
  }).join("\n\n");
  return result(markdown, "native-ipynb", { notebookMetadata: notebook.metadata ?? {} });
}

export function convertLocalHtml(input: ConversionInput): MarkdownConversionResult {
  const { document } = parseHTML(textDecoder.decode(input.data));
  for (const element of document.querySelectorAll("script, style, template, nav")) element.remove();
  const title = document.querySelector("title, h1")?.textContent?.trim();
  const body = document.body.textContent.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return result(`${title ? `# ${escapeMarkdown(title)}\n\n` : ""}${body}`, "native-html");
}

export async function convertWebHtml(input: ConversionInput): Promise<MarkdownConversionResult> {
  const { document } = parseHTML(textDecoder.decode(input.data));
  const extracted = await Defuddle(document as unknown as Document, input.sourceUrl, { markdown: true });
  return result(extracted.content, "defuddle", {
    title: extracted.title,
    author: extracted.author,
    description: extracted.description,
    published: extracted.published,
    sourceUrl: input.sourceUrl
  });
}
