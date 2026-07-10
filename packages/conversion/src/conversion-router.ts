import { extname } from "node:path";

import {
  convertCsv,
  convertJson,
  convertLocalHtml,
  convertMarkdown,
  convertNotebook,
  convertPlainText,
  convertWebHtml,
  convertXml
} from "./native-converters.js";
import type { DoclingClient } from "./docling-client.js";
import type { ConversionInput, MarkdownConversionResult } from "./types.js";
import { convertZip } from "./zip-converter.js";

export interface ConversionRouterOptions {
  doclingClient?: DoclingClient;
  materializeForDocling?: (input: ConversionInput) => Promise<{ path: string; cleanup: () => Promise<void> }>;
}

const complexExtensions = new Set([
  ".pdf", ".docx", ".pptx", ".xlsx", ".epub", ".odt", ".ods", ".odp",
  ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".webp"
]);

function sniffExtension(input: ConversionInput): string {
  const extension = extname(input.fileName ?? "").toLowerCase();
  if (extension) return extension;
  const bytes = input.data;
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return ".pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return ".zip";
  return "";
}

export class ConversionRouter {
  public constructor(private readonly options: ConversionRouterOptions = {}) {}

  public async convert(input: ConversionInput, signal?: AbortSignal): Promise<MarkdownConversionResult> {
    if (signal?.aborted) throw new DOMException("Conversion canceled.", "AbortError");
    const extension = sniffExtension(input);
    const mime = input.mimeType?.toLowerCase();
    if (extension === ".zip" || mime === "application/zip") {
      return convertZip(input, (entry) => this.convert(entry, signal));
    }
    if (input.sourceUrl && (extension === ".html" || mime === "text/html")) return convertWebHtml(input);
    if (extension === ".md" || extension === ".markdown" || mime === "text/markdown") return convertMarkdown(input);
    if (extension === ".csv" || mime === "text/csv") return convertCsv(input);
    if (extension === ".json" || mime === "application/json") return convertJson(input);
    if ([".xml", ".rss", ".atom"].includes(extension) || mime?.includes("xml")) return convertXml(input);
    if (extension === ".ipynb" || mime === "application/x-ipynb+json") return convertNotebook(input);
    if ([".html", ".htm"].includes(extension) || mime === "text/html") return convertLocalHtml(input);
    if ([".txt", ""].includes(extension) || mime?.startsWith("text/")) return convertPlainText(input);
    if (complexExtensions.has(extension)) return this.convertWithDocling(input, signal);
    throw new Error("errors.common.unsupportedFile");
  }

  private async convertWithDocling(input: ConversionInput, signal?: AbortSignal): Promise<MarkdownConversionResult> {
    if (!this.options.doclingClient || !this.options.materializeForDocling) {
      throw new Error("errors.conversion.doclingUnavailable");
    }
    const materialized = await this.options.materializeForDocling(input);
    try {
      return await this.options.doclingClient.convert(materialized.path, input.profile ?? "standard", signal);
    } finally {
      await materialized.cleanup();
    }
  }
}
