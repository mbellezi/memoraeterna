import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

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
    if (input.sourcePath && input.data === undefined) return this.storeFromPath(input.sourcePath, input);
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

  private async storeFromPath(sourcePath: string, input: {
    originalFileName: string; basePath: string; storageBase: StoredAsset["storageBase"];
  }): Promise<StoredAsset> {
    const incoming = resolveInside(input.basePath, join(".incoming", randomUUID()));
    await mkdir(resolve(incoming, ".."), { recursive: true });
    const hash = createHash("sha256");
    const hashingStream = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
    try {
      await pipeline(createReadStream(sourcePath), hashingStream, createWriteStream(incoming, { flags: "wx", mode: 0o600 }));
      const digest = hash.digest("hex");
      const extension = sanitizeExtension(extname(input.originalFileName));
      const relativePath = join("sha256", digest.slice(0, 2), digest.slice(2, 4), `${digest}${extension}`);
      const absolutePath = resolveInside(input.basePath, relativePath);
      await mkdir(resolve(absolutePath, ".."), { recursive: true });
      let deduplicated = false;
      try { await link(incoming, absolutePath); } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        deduplicated = true;
      }
      const file = await stat(incoming);
      return { sha256: digest, sizeBytes: file.size, storageBase: input.storageBase, relativePath, absolutePath, deduplicated };
    } finally {
      await unlink(incoming).catch(() => undefined);
    }
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
