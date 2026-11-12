import { lstat } from "node:fs/promises";
import { basename, extname } from "node:path";

import type { DroppedFile, DroppedKind, DroppedRefusal } from "../../shared/ipc-drop.js";
import { validateAbsolutePath } from "./path-validation.js";

/**
 * Files dropped on the window (F5 D32, T150). The preload resolves each `File` to a path and main
 * validates it here before anything reads it: a regular file (not a folder, a device or a
 * symlink), within the import size cap, of a type the importer takes. A file that passes is turned
 * into the same opaque token a dialog choice yields (`prepareFileMetadata`), so the renderer never
 * sees a path (`rules/security-privacy.md`).
 */

/** The types a drop accepts, by extension. A zip is not one: an archive expands into many files. */
const acceptedExtensions: Readonly<Record<string, DroppedKind>> = {
  ".pdf": "pdf",
  ".epub": "epub",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".html": "web",
  ".htm": "web",
  ".docx": "office",
  ".xlsx": "office",
  ".pptx": "office",
  ".csv": "data",
  ".json": "data",
  ".xml": "data",
  ".rss": "data",
  ".atom": "data",
  ".ipynb": "notebook"
};

export const acceptedDropExtensions: readonly string[] = Object.keys(acceptedExtensions);

/** The size cap the dialog path applies (`MEMORA_MAX_IMPORT_BYTES`), 512 MiB by default. */
export function importMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.MEMORA_MAX_IMPORT_BYTES);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 512 * 1024 * 1024;
}

/** What validation reads of the file system: `lstat`, which does not follow a symlink. */
export interface DropFileStats {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}
export type DropLstat = (path: string) => Promise<DropFileStats>;

export type DropValidation =
  | { ok: true; name: string; size: number; kind: DroppedKind }
  | { ok: false; name: string; reason: DroppedRefusal };

const refuse = (name: string, reason: DroppedRefusal): DropValidation => ({
  ok: false,
  name,
  reason
});

/** One path, checked in the order a person would explain it: what it is, how big, what type. */
export async function validateDroppedPath(
  path: string,
  options: { lstat?: DropLstat; maxBytes?: number } = {}
): Promise<DropValidation> {
  const name = basename(path);
  if (!validateAbsolutePath(path).ok) return refuse(name, "notAFile");
  let stats: DropFileStats;
  try {
    stats = await (options.lstat ?? lstat)(path);
  } catch {
    return refuse(name, "unreadable");
  }
  if (stats.isSymbolicLink()) return refuse(name, "symlink");
  if (!stats.isFile()) return refuse(name, "notAFile");
  if (stats.size === 0) return refuse(name, "empty");
  if (stats.size > (options.maxBytes ?? importMaxBytes())) return refuse(name, "tooLarge");
  const kind = acceptedExtensions[extname(name).toLowerCase()];
  if (!kind) return refuse(name, "unsupported");
  return { ok: true, name, size: stats.size, kind };
}

/** What `IngestionService.prepareFileMetadata` returns, the part a drop reads. */
export interface PreparedFile {
  fileToken: string;
  fileName: string;
  mimeType: string;
  draft: Extract<DroppedFile, { status: "ready" }>["draft"];
}

export interface PrepareDroppedDeps {
  /** Reads the file and stores it under a token: `ingestionService.prepareFileMetadata`. */
  prepare: (path: string) => Promise<PreparedFile>;
  lstat?: DropLstat;
  maxBytes?: number;
}

/** A conversion failure names its reason: too large stays "tooLarge", anything else is unreadable. */
function refusalOf(error: unknown): DroppedRefusal {
  return error instanceof Error && error.message === "errors.common.fileTooLarge"
    ? "tooLarge"
    : "unreadable";
}

/**
 * Validates and prepares each path in turn (one conversion at a time: the converter is heavy), one
 * result per path, in order. A path that fails never stops the others.
 */
export async function prepareDroppedFiles(
  paths: readonly string[],
  deps: PrepareDroppedDeps
): Promise<DroppedFile[]> {
  const results: DroppedFile[] = [];
  for (const path of paths) {
    const checked = await validateDroppedPath(path, {
      ...(deps.lstat ? { lstat: deps.lstat } : {}),
      ...(deps.maxBytes === undefined ? {} : { maxBytes: deps.maxBytes })
    });
    if (!checked.ok) {
      results.push({ status: "refused", name: checked.name, reason: checked.reason });
      continue;
    }
    try {
      const prepared = await deps.prepare(path);
      results.push({
        status: "ready",
        fileToken: prepared.fileToken,
        name: checked.name,
        size: checked.size,
        kind: checked.kind,
        mimeType: prepared.mimeType,
        draft: prepared.draft
      });
    } catch (error) {
      results.push({ status: "refused", name: checked.name, reason: refusalOf(error) });
    }
  }
  return results;
}
