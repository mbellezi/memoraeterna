import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  isSafeModelRelativePath,
  localModelExpectedSize,
  type LocalModelCatalogEntry
} from "./local-model-catalog.js";

export interface LocalModelDownloadProgress {
  currentFile: string;
  currentFileBytes: number;
  currentFileSizeBytes: number;
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
}

export interface DownloadLocalModelOptions {
  entry: LocalModelCatalogEntry;
  destinationRoot: string;
  token?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  minFreeBytes?: number;
  onProgress?: (progress: LocalModelDownloadProgress) => void | Promise<void>;
}

export interface DownloadLocalModelResult {
  modelPath: string;
  sizeBytes: number;
}

export async function downloadLocalModel(options: DownloadLocalModelOptions): Promise<DownloadLocalModelResult> {
  const fetchImpl = options.fetch ?? fetch;
  const modelPath = resolveManagedModelPath(options.destinationRoot, options.entry.id);
  await mkdir(modelPath, { recursive: true });
  await assertDiskSpace(modelPath, options.entry, options.minFreeBytes ?? 256 * 1024 * 1024);

  const totalBytes = localModelExpectedSize(options.entry);
  let downloadedBytes = 0;
  for (const file of options.entry.files) {
    const finalPath = resolveManagedModelPath(modelPath, file.path);
    const partialPath = `${finalPath}.partial`;
    await mkdir(dirname(finalPath), { recursive: true });
    if (await fileMatches(finalPath, file.sizeBytes, file.sha256)) {
      downloadedBytes += file.sizeBytes;
      await options.onProgress?.({
        currentFile: file.path,
        currentFileBytes: file.sizeBytes,
        currentFileSizeBytes: file.sizeBytes,
        downloadedBytes,
        totalBytes,
        bytesPerSecond: 0,
        etaSeconds: downloadedBytes === totalBytes ? 0 : null
      });
      continue;
    }

    await rm(finalPath, { force: true });
    let partialBytes = await fileSize(partialPath);
    if (partialBytes > file.sizeBytes) {
      await rm(partialPath, { force: true });
      partialBytes = 0;
    }
    const startedAt = Date.now();
    let lastReportedAt = startedAt;
    let response = await fetchImpl(createDownloadUrl(options.entry, file.path), {
      headers: createHeaders(options.token, partialBytes),
      ...(options.signal ? { signal: options.signal } : {}),
      redirect: "follow"
    });
    if (partialBytes > 0 && response.status === 200) {
      await rm(partialPath, { force: true });
      partialBytes = 0;
      response = await fetchImpl(createDownloadUrl(options.entry, file.path), {
        headers: createHeaders(options.token, 0),
        ...(options.signal ? { signal: options.signal } : {}),
        redirect: "follow"
      });
    }
    if (!response.ok || !response.body || (partialBytes > 0 && response.status !== 206)) {
      throw new Error(`errors.localModels.downloadHttp:${response.status}`);
    }

    let receivedBytes = partialBytes;
    const source = Readable.fromWeb(response.body as never);
    const progressTracker = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.byteLength;
        const now = Date.now();
        if (now - lastReportedAt < 200 && receivedBytes < file.sizeBytes) {
          callback(null, chunk);
          return;
        }
        lastReportedAt = now;
        const elapsedSeconds = Math.max(0.001, (now - startedAt) / 1_000);
        const bytesPerSecond = Math.max(0, (receivedBytes - partialBytes) / elapsedSeconds);
        const aggregateBytes = downloadedBytes + receivedBytes;
        const remaining = Math.max(0, totalBytes - aggregateBytes);
        Promise.resolve(options.onProgress?.({
          currentFile: file.path,
          currentFileBytes: receivedBytes,
          currentFileSizeBytes: file.sizeBytes,
          downloadedBytes: aggregateBytes,
          totalBytes,
          bytesPerSecond,
          etaSeconds: bytesPerSecond > 0 ? Math.ceil(remaining / bytesPerSecond) : null
        })).then(() => callback(null, chunk), callback);
      }
    });
    await pipeline(
      source,
      progressTracker,
      createWriteStream(partialPath, { flags: partialBytes > 0 ? "a" : "w", mode: 0o600 })
    );
    const completedSize = await fileSize(partialPath);
    if (completedSize !== file.sizeBytes) {
      throw new Error("errors.localModels.sizeMismatch");
    }
    const checksum = await sha256File(partialPath);
    if (checksum !== file.sha256) {
      await rm(partialPath, { force: true });
      throw new Error("errors.localModels.checksumMismatch");
    }
    await rename(partialPath, finalPath);
    downloadedBytes += file.sizeBytes;
    await options.onProgress?.({
      currentFile: file.path,
      currentFileBytes: file.sizeBytes,
      currentFileSizeBytes: file.sizeBytes,
      downloadedBytes,
      totalBytes,
      bytesPerSecond: 0,
      etaSeconds: downloadedBytes === totalBytes ? 0 : null
    });
  }
  return { modelPath, sizeBytes: totalBytes };
}

export async function verifyLocalModelFiles(entry: LocalModelCatalogEntry, modelPath: string): Promise<boolean> {
  for (const file of entry.files) {
    if (!await fileMatches(resolveManagedModelPath(modelPath, file.path), file.sizeBytes, file.sha256)) return false;
  }
  return true;
}

export function resolveManagedModelPath(root: string, relativePath: string): string {
  if (!isSafeModelRelativePath(relativePath)) throw new Error("errors.localModels.unsafePath");
  const canonicalRoot = resolve(root);
  const candidate = resolve(canonicalRoot, relativePath);
  if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("errors.localModels.unsafePath");
  }
  return candidate;
}

export function createDownloadUrl(entry: LocalModelCatalogEntry, filePath: string): string {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${entry.repository}/resolve/${entry.revision}/${encodedPath}`;
}

export function redactSensitiveText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(?:hf|api)_[a-zA-Z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/([?&](?:token|signature|x-amz-signature)=)[^&\s]+/gi, "$1[redacted]");
}

async function assertDiskSpace(path: string, entry: LocalModelCatalogEntry, reserveBytes: number): Promise<void> {
  const filesystem = await statfs(path);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  let existingBytes = 0;
  for (const file of entry.files) {
    existingBytes += Math.min(file.sizeBytes, await fileSize(`${resolveManagedModelPath(path, file.path)}.partial`));
    if (await fileExists(resolveManagedModelPath(path, file.path))) existingBytes += file.sizeBytes;
  }
  const requiredBytes = Math.max(0, localModelExpectedSize(entry) - existingBytes) + reserveBytes;
  if (availableBytes < requiredBytes) throw new Error("errors.localModels.insufficientDisk");
}

function createHeaders(token: string | undefined, partialBytes: number): Headers {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (partialBytes > 0) headers.set("range", `bytes=${partialBytes}-`);
  return headers;
}

async function fileMatches(path: string, sizeBytes: number, expectedSha256: string): Promise<boolean> {
  if (await fileSize(path) !== sizeBytes) return false;
  return await sha256File(path) === expectedSha256;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
