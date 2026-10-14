/**
 * Downloads the golden library sources listed in scripts/golden/manifest.json into
 * .cache/golden/sources/ (gitignored) and verifies them by size and SHA-256.
 *
 *   npx tsx scripts/golden/fetch.ts                 download missing files, verify all pinned files
 *   npx tsx scripts/golden/fetch.ts --verify        verify local files only (no network)
 *   npx tsx scripts/golden/fetch.ts --pin           also download unpinned entries and record their
 *                                                   size and SHA-256 in the manifest
 *   npx tsx scripts/golden/fetch.ts --only a,b      restrict to some keys
 *
 * Downloads need MEMORA_GOLDEN_CONTACT (a contact URL or email address) for the User-Agent, as
 * Wikimedia asks; `--verify` is offline and does not. A pinned file whose download differs from its
 * pin is never kept: upstream changed, so the run stops and names the entry. A text entry with a
 * `trim` keeps only the text between its markers, and the pin covers the trimmed file. Re-pinning
 * (clear sha256/bytes, then --pin) invalidates recorded cassettes for that source. The repository
 * stores only the manifest, never the files.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import * as prettier from "prettier";

import {
  goldenManifestFiles,
  goldenManifestSchema,
  goldenSourcePath,
  goldenUserAgent,
  readLimitedBody,
  sha256File,
  trimGoldenText,
  verifyGoldenFile,
  type GoldenFile
} from "../../apps/desktop/src/main/services/golden-runner.ts";

const root = resolve(import.meta.dirname, "..", "..");
const manifestPath = join(import.meta.dirname, "manifest.json");
const maxBytes = 20 * 1024 * 1024;
const timeoutMs = 120_000;
const pauseMs = 500;

const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify");
const pin = args.includes("--pin");
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? new Set((args[onlyIndex + 1] ?? "").split(",")) : null;
const unknown = args.filter(
  (arg, index) =>
    !["--verify", "--pin", "--only"].includes(arg) && !(onlyIndex >= 0 && index === onlyIndex + 1)
);
if (unknown.length || (verifyOnly && pin)) {
  console.error("Usage: fetch.ts [--verify | --pin] [--only key,key]");
  process.exit(2);
}

const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
  sources: Array<Record<string, unknown> & { children?: Array<Record<string, unknown>> }>;
};
const manifest = goldenManifestSchema.parse(raw);
const files = goldenManifestFiles(manifest).filter((file) => !only || only.has(file.key));
if (only && files.length !== only.size) {
  console.error(
    `Unknown key in --only: ${[...only].filter((key) => !files.some((f) => f.key === key)).join(", ")}`
  );
  process.exit(2);
}

const results: Array<{ key: string; status: string; bytes?: number; sha256?: string }> = [];
let pinned = 0;
let failed = false;
for (const file of files) {
  const path = goldenSourcePath(root, file);
  const check = await verifyGoldenFile(path, file);
  if (check.status === "ok") {
    results.push({ key: file.key, status: "ok", bytes: file.bytes!, sha256: file.sha256! });
    continue;
  }
  if (check.status === "unpinned" && !pin) {
    results.push({ key: file.key, status: "unpinned (run with --pin)" });
    failed = true;
    continue;
  }
  if (verifyOnly) {
    results.push({
      key: file.key,
      status: check.status === "mismatch" ? "local file differs from its pin" : check.status,
      ...(check.status === "mismatch" ? { bytes: check.bytes, sha256: check.sha256 } : {})
    });
    failed = true;
    continue;
  }
  try {
    const downloaded = await download(file, path);
    if (check.status === "unpinned") {
      setPin(file.key, downloaded);
      pinned += 1;
      results.push({ key: file.key, status: "pinned", ...downloaded });
    } else results.push({ key: file.key, status: "downloaded", ...downloaded });
  } catch (error) {
    results.push({ key: file.key, status: error instanceof Error ? error.message : String(error) });
    failed = true;
  }
  await sleep(pauseMs);
}

if (pinned > 0) {
  goldenManifestSchema.parse(raw);
  const text = await prettier.format(JSON.stringify(raw), {
    ...(await prettier.resolveConfig(manifestPath)),
    filepath: manifestPath
  });
  await writeFile(manifestPath, text);
}
for (const result of results)
  console.log(
    [
      result.key.padEnd(44),
      result.status.padEnd(12),
      result.bytes === undefined ? "" : String(result.bytes).padStart(10),
      result.sha256?.slice(0, 16) ?? ""
    ].join(" ")
  );
const problems = results.filter((r) => !["ok", "downloaded", "pinned"].includes(r.status));
console.log(`${results.length} files, ${pinned} newly pinned, ${problems.length} problems`);
process.exit(failed ? 1 : 0);

async function download(file: GoldenFile, path: string) {
  const response = await fetch(file.url, {
    headers: {
      "user-agent": goldenUserAgent(process.env.MEMORA_GOLDEN_CONTACT),
      accept: acceptFor(file.format)
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!new URL(response.url).protocol.startsWith("https"))
    throw new Error("redirected away from HTTPS");
  let data = await readLimitedBody(response, maxBytes);
  checkFormat(file, data, response.headers.get("content-type") ?? "");
  if ("trim" in file && file.trim)
    data = Buffer.from(trimGoldenText(data.toString("utf8"), file.trim), "utf8");
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, data);
  const actual = await sha256File(partial);
  if (file.sha256 && (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)) {
    await rm(partial, { force: true });
    throw new Error(`upstream changed: ${actual.bytes} bytes, sha256 ${actual.sha256}`);
  }
  await rename(partial, path);
  return actual;
}

function acceptFor(format: GoldenFile["format"]) {
  return format === "pdf"
    ? "application/pdf"
    : format === "html"
      ? "text/html"
      : "text/plain, text/markdown";
}

function checkFormat(file: GoldenFile, data: Buffer, contentType: string) {
  if (file.format === "pdf") {
    if (data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("not a PDF");
    return;
  }
  if (/^application\/pdf/i.test(contentType)) throw new Error(`expected ${file.format}, got PDF`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (file.format === "html" && !/<(p|div|section|h[1-6])\b/i.test(text))
    throw new Error("no HTML content");
  if (text.trim().length === 0) throw new Error("empty");
}

function setPin(key: string, value: { sha256: string; bytes: number }) {
  for (const source of raw.sources) {
    for (const entry of [source, ...(source.children ?? [])])
      if (entry.key === key && entry.kind === "document") {
        entry.sha256 = value.sha256;
        entry.bytes = value.bytes;
        return;
      }
  }
  throw new Error(`No manifest entry ${key}`);
}
