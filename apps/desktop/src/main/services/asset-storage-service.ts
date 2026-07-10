import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

export interface StoredAsset {
  sha256: string;
  sizeBytes: number;
  storageBase: "app_internal" | "uploaded_files";
  relativePath: string;
  absolutePath: string;
  deduplicated: boolean;
}

export class AssetStorageService {
  public async store(input: {
    data?: Uint8Array;
    sourcePath?: string;
    originalFileName: string;
    basePath: string;
    storageBase: StoredAsset["storageBase"];
  }): Promise<StoredAsset> {
    const data = input.data ?? (input.sourcePath ? await readFile(input.sourcePath) : null);
    if (!data) throw new Error("Asset storage requires data or a source path.");
    const hash = createHash("sha256").update(data).digest("hex");
    const extension = sanitizeExtension(extname(input.originalFileName));
    const relativePath = join("sha256", hash.slice(0, 2), hash.slice(2, 4), `${hash}${extension}`);
    const absolutePath = resolveInside(input.basePath, relativePath);
    await mkdir(resolve(absolutePath, ".."), { recursive: true });
    let deduplicated = false;
    try {
      await writeFile(absolutePath, data, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      deduplicated = true;
    }
    return {
      sha256: hash,
      sizeBytes: data.byteLength,
      storageBase: input.storageBase,
      relativePath,
      absolutePath,
      deduplicated
    };
  }

  public async exists(basePath: string, relativePath: string): Promise<boolean> {
    const absolutePath = resolveInside(basePath, relativePath);
    try {
      await access(absolutePath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export function resolveInside(basePath: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0")) throw new Error("errors.common.validationFailed");
  const base = resolve(basePath);
  const target = resolve(base, relativePath);
  const fromBase = relative(base, target);
  if (fromBase === ".." || fromBase.startsWith(`..${sep}`) || fromBase.startsWith(sep)) {
    throw new Error("errors.common.permissionDenied");
  }
  return target;
}

function sanitizeExtension(extension: string): string {
  return /^\.[a-z0-9]{1,10}$/i.test(extension) ? extension.toLowerCase() : "";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
