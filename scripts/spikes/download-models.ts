/**
 * Downloads the pinned local-model artifacts used by the F0 spikes into `.cache/models/<name>/`.
 *
 *   npx tsx scripts/spikes/download-models.ts                 download and verify every model
 *   npx tsx scripts/spikes/download-models.ts --only a,b      restrict to some models
 *   npx tsx scripts/spikes/download-models.ts --verify        verify local files only (no network)
 *   npx tsx scripts/spikes/download-models.ts --pin [a,b]     re-resolve revision, sizes, SHA-256 and
 *                                                             license from the Hugging Face API and
 *                                                             rewrite models.json (see --revision)
 *
 * Downloads are resumable (`<file>.partial` + HTTP Range), verified by size and SHA-256, and promoted
 * atomically. Repositories are public; no credentials are read or sent.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { z } from "zod";

const root = resolve(import.meta.dirname, "..", "..");
const manifestPath = join(import.meta.dirname, "models.json");
export const modelsRoot = join(root, ".cache", "models");
const hubOrigin = "https://huggingface.co";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const pinnedFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine((value) => !value.split("/").includes(".."), "path must stay inside the model dir"),
    size: z.number().int().nonnegative(),
    sha256: sha256Schema,
    lfs: z.boolean()
  })
  .strict();
const pinnedModelSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    license: z.string().min(1),
    runtime: z.enum(["mlx", "gguf"]),
    capability: z.enum(["rerank", "embed"]),
    source: z.string().min(1),
    files: z.array(pinnedFileSchema).min(1)
  })
  .strict();
const manifestSchema = z
  .object({
    description: z.string(),
    models: z.array(pinnedModelSchema).min(1)
  })
  .strict();
export type PinnedModel = z.infer<typeof pinnedModelSchema>;
type PinnedFile = z.infer<typeof pinnedFileSchema>;

const hubRevisionSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  cardData: z.object({ license: z.string().optional() }).passthrough().optional(),
  siblings: z.array(
    z.object({
      rfilename: z.string(),
      size: z.number().int().nonnegative().optional(),
      lfs: z.object({ sha256: sha256Schema, size: z.number().int().nonnegative() }).optional()
    })
  )
});

export async function readModelManifest(): Promise<PinnedModel[]> {
  const parsed = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  return parsed.models;
}

export function modelDirectory(model: Pick<PinnedModel, "name">): string {
  return join(modelsRoot, model.name);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const only = optionList(args, "--only") ?? optionList(args, "--pin");
  const selected = manifest.models.filter((model) => !only || only.includes(model.name));
  if (only && selected.length !== only.length) {
    const known = new Set(manifest.models.map((model) => model.name));
    throw new Error(`Unknown model name(s): ${only.filter((name) => !known.has(name)).join(", ")}`);
  }

  if (args.includes("--pin")) {
    const revisionIndex = args.indexOf("--revision");
    const revision = revisionIndex >= 0 ? args[revisionIndex + 1] : undefined;
    for (const model of selected) {
      const pinned = await pinModel(model, revision ?? model.revision);
      manifest.models[manifest.models.indexOf(model)] = pinned;
      console.info(`pinned ${pinned.name} @ ${pinned.revision} (${pinned.files.length} files)`);
    }
    await writeFile(manifestPath, `${JSON.stringify(manifestSchema.parse(manifest), null, 2)}\n`);
    return;
  }

  const verifyOnly = args.includes("--verify");
  for (const model of selected) {
    for (const file of model.files) {
      const target = join(modelDirectory(model), file.path);
      if (await isVerified(target, file)) {
        console.info(`ok        ${model.name}/${file.path}`);
        continue;
      }
      if (verifyOnly) throw new Error(`Missing or invalid: ${target}`);
      await downloadFile(model, file, target);
      console.info(`verified  ${model.name}/${file.path} (${file.size} bytes)`);
    }
  }
}

async function pinModel(model: PinnedModel, revision: string): Promise<PinnedModel> {
  const response = await fetch(
    `${hubOrigin}/api/models/${model.repository}/revision/${revision}?blobs=true`
  );
  if (!response.ok) throw new Error(`Hub API ${response.status} for ${model.repository}`);
  const info = hubRevisionSchema.parse(await response.json());
  const files: PinnedFile[] = [];
  for (const wanted of model.files) {
    const sibling = info.siblings.find((candidate) => candidate.rfilename === wanted.path);
    if (!sibling) throw new Error(`${model.repository}@${info.sha} has no file ${wanted.path}`);
    if (sibling.lfs) {
      files.push({
        path: wanted.path,
        size: sibling.lfs.size,
        sha256: sibling.lfs.sha256,
        lfs: true
      });
      continue;
    }
    const body = await fetchBytes(fileUrl(model.repository, info.sha, wanted.path));
    if (sibling.size !== undefined && sibling.size !== body.length) {
      throw new Error(`Size mismatch while pinning ${wanted.path}`);
    }
    files.push({
      path: wanted.path,
      size: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      lfs: false
    });
  }
  const license = info.cardData?.license;
  if (!license) throw new Error(`${model.repository} does not declare a license in its card`);
  return { ...model, revision: info.sha, license, files };
}

async function downloadFile(model: PinnedModel, file: PinnedFile, target: string): Promise<void> {
  const partial = `${target}.partial`;
  await mkdir(dirname(target), { recursive: true });
  let offset = (await fileSize(partial)) ?? 0;
  if (offset > file.size) {
    await rm(partial);
    offset = 0;
  }
  if (offset < file.size) {
    const response = await fetch(fileUrl(model.repository, model.revision, file.path), {
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : {}
    });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status}) for ${model.repository}/${file.path}`);
    }
    if (offset > 0 && response.status !== 206) offset = 0;
    console.info(
      `${offset > 0 ? "resuming " : "fetching "} ${model.name}/${file.path} from byte ${offset}`
    );
    const progress = progressReporter(`${model.name}/${file.path}`, offset, file.size);
    const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => progress(chunk.length));
    await pipeline(body, createWriteStream(partial, { flags: offset > 0 ? "a" : "w" }));
  }
  const size = await fileSize(partial);
  const digest = await sha256File(partial);
  if (size !== file.size || digest !== file.sha256) {
    await rm(partial, { force: true });
    throw new Error(
      `Checksum mismatch for ${model.name}/${file.path}: size ${size}, sha256 ${digest}; ` +
        `expected ${file.size} / ${file.sha256}. The partial file was removed.`
    );
  }
  await rename(partial, target);
}

async function isVerified(target: string, file: PinnedFile): Promise<boolean> {
  if ((await fileSize(target)) !== file.size) return false;
  return (await sha256File(target)) === file.sha256;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function fileUrl(repository: string, revision: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${hubOrigin}/${repository}/resolve/${revision}/${encodedPath}`;
}

function progressReporter(label: string, start: number, total: number): (bytes: number) => void {
  let done = start;
  let lastPercent = Math.floor((start / Math.max(total, 1)) * 10) * 10;
  return (bytes) => {
    done += bytes;
    const percent = Math.floor((done / Math.max(total, 1)) * 10) * 10;
    if (percent > lastPercent) {
      lastPercent = percent;
      console.info(`  ${label}: ${percent}%`);
    }
  };
}

function optionList(args: string[], flag: string): string[] | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
