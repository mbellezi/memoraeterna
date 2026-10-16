// The directory of one owner rating run (E4, F2 T30): `<cache>/topics/rating/<run>/`.
//
//   manifest.json  seed, each profile's tree and config_hash, hashes of the two files below
//   sample.json    what the page shows (the only file the page is made from)
//   sealed.json    the key -> profile / level / naming source map; the page never loads it
//   page.html      derived from sample.json every time the run is served
//   answers.json   written by the local eval server as the owner answers
//   result.md      written by `score`
//
// A run is written once. `writeRun` refuses a directory that already has a manifest, so a sample
// is never redrawn after the owner may have seen it.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { cacheRoot, repoRoot } from "./datasets.js";
import {
  ManifestFileSchema,
  SampleFileSchema,
  SealedFileSchema,
  ratingConfig
} from "./rating-core.js";
import type { ManifestFile, RatingParts, SampleFile, SealedFile } from "./rating-core.js";

/** The localStorage prefix of the rating page's answers (the eval server mirrors keys starting with it). */
export const ratingAnswerPrefix = "memora.topicRating.";

export const ratingFiles = {
  manifest: "manifest.json",
  sample: "sample.json",
  sealed: "sealed.json",
  page: "page.html",
  answers: "answers.json",
  resultMarkdown: "result.md",
  resultJson: "result.json"
} as const;

export const ratingTemplatePath = join(import.meta.dirname, "rating-page.html");
export const tokensCssPath = join(repoRoot, "apps/desktop/src/renderer/tokens.css");

export class RatingRunError extends Error {
  override readonly name = "RatingRunError";
}

export const ratingRootDirectory = (): string => join(cacheRoot(), "topics", "rating");

/** A run name (under the rating directory) or a path to a run directory. */
export function resolveRunDirectory(run: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(run)) return join(ratingRootDirectory(), run);
  if (isAbsolute(run) || run.includes("/") || run.includes("\\")) return resolve(run);
  throw new RatingRunError(`"${run}" is not a run name.`);
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  );

/**
 * Writes a run: sealed and sample first, the manifest last (a run without a manifest is never
 * served). Refuses to touch a run that has one.
 */
export async function writeRun(
  directory: string,
  input: { run: string; seed: number; createdAt: string; parts: RatingParts }
): Promise<ManifestFile> {
  if (await exists(join(directory, ratingFiles.manifest))) {
    throw new RatingRunError(
      `The run "${input.run}" already has a manifest. A sample is never redrawn: use another --run name.`
    );
  }
  await mkdir(directory, { recursive: true });
  const sampleText = json(input.parts.sample);
  const sealedText = json(input.parts.sealed);
  await writeAtomic(join(directory, ratingFiles.sealed), sealedText);
  await writeAtomic(join(directory, ratingFiles.sample), sampleText);
  const manifest: ManifestFile = {
    version: 1,
    run: input.run,
    seed: input.seed,
    createdAt: input.createdAt,
    sampleSize: ratingConfig.sampleSize,
    membersPerTopic: ratingConfig.membersPerTopic,
    passBar: ratingConfig.passBar,
    profiles: input.parts.profiles,
    files: {
      sample: { file: "sample.json", sha256: sha256(sampleText) },
      sealed: { file: "sealed.json", sha256: sha256(sealedText) }
    }
  };
  await writeAtomic(join(directory, ratingFiles.manifest), json(manifest));
  return manifest;
}

export interface RatingRun {
  directory: string;
  manifest: ManifestFile;
  sample: SampleFile;
  sealed: SealedFile;
  sampleSha256: string;
}

async function readJson(path: string, what: string): Promise<{ text: string; value: unknown }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new RatingRunError(`Cannot read ${what} (${path}).`);
  }
  try {
    return { text, value: JSON.parse(text) as unknown };
  } catch {
    throw new RatingRunError(`${what} is not valid JSON (${path}).`);
  }
}

/** Reads a run and checks the sample and the sealed map against the hashes the manifest recorded. */
export async function readRun(
  directory: string,
  options: { needSealed?: boolean } = {}
): Promise<RatingRun> {
  const manifestRead = await readJson(join(directory, ratingFiles.manifest), "the manifest");
  const manifest = ManifestFileSchema.safeParse(manifestRead.value);
  if (!manifest.success) throw new RatingRunError("The manifest is not a rating manifest.");
  const sampleRead = await readJson(join(directory, ratingFiles.sample), "the sample");
  if (sha256(sampleRead.text) !== manifest.data.files.sample.sha256) {
    throw new RatingRunError("sample.json changed after it was sampled; the run is not served.");
  }
  const sample = SampleFileSchema.safeParse(sampleRead.value);
  if (!sample.success) throw new RatingRunError("sample.json is not a rating sample.");
  let sealed: SealedFile = { version: 1, seed: manifest.data.seed, entries: [] };
  if (options.needSealed) {
    const sealedRead = await readJson(join(directory, ratingFiles.sealed), "the sealed map");
    if (sha256(sealedRead.text) !== manifest.data.files.sealed.sha256) {
      throw new RatingRunError("sealed.json changed after it was sampled.");
    }
    const parsed = SealedFileSchema.safeParse(sealedRead.value);
    if (!parsed.success) throw new RatingRunError("sealed.json is not a rating sealed map.");
    sealed = parsed.data;
  }
  return {
    directory,
    manifest: manifest.data,
    sample: sample.data,
    sealed,
    sampleSha256: manifest.data.files.sample.sha256
  };
}

/** The page's storage key: it ties the answers to this exact sample. */
export const answerKeyOf = (sampleSha256: string): string =>
  `${ratingAnswerPrefix}${sampleSha256.slice(0, 12)}`;

/** The shared tokens, without their comments (the page needs the values, not the documentation). */
export async function readTokensCss(): Promise<string> {
  const css = await readFile(tokensCssPath, "utf8");
  return css.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\n{2,}/gu, "\n");
}

/**
 * The page: a self-contained HTML file made from the template, the design tokens and the sample.
 * The embedded data is the sample file's topics and nothing else.
 */
export function renderRatingPage(input: {
  template: string;
  tokensCss: string;
  sample: SampleFile;
  sampleSha256: string;
}): string {
  const data = { answerKey: answerKeyOf(input.sampleSha256), topics: input.sample.topics };
  // `<` is escaped so no member text can close the script element.
  const embedded = JSON.stringify(data).replace(/</gu, "\\u003c");
  return input.template
    .replace("/*__TOKENS_CSS__*/", () => input.tokensCss)
    .replace("__PAGE_DATA__", () => embedded);
}

/** Writes `page.html` for the run from the current template; returns its path. */
export async function writePage(run: RatingRun): Promise<string> {
  const template = await readFile(ratingTemplatePath, "utf8");
  const page = renderRatingPage({
    template,
    tokensCss: await readTokensCss(),
    sample: run.sample,
    sampleSha256: run.sampleSha256
  });
  const path = join(run.directory, ratingFiles.page);
  await writeAtomic(path, page);
  return path;
}
