/**
 * Spend control and the raw request log for Spike A2.
 *
 * Price (official Decisions guide, checked 2026-10-14): `gpt-6-luna` input costs US$ 0.10 per 1M
 * tokens; output, cache-read and cache-write tokens are free. Regional-processing premiums and
 * long-context multipliers do not apply to requests of this size on the default endpoint.
 *
 * Every request appends one JSON line to `raw/<run id>.jsonl` as soon as it finishes. The total
 * spent so far is the sum of the recorded `usage.input_tokens` over all those files, so it survives
 * crashes and resumed runs. A run is refused when its projected cost exceeds `runLimitUsd`, or when
 * the projection plus everything spent so far exceeds `totalLimitUsd`.
 */
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { repositoryRoot } from "./env.js";

export const pricePerMillionInputTokensUsd = 0.1;
export const runLimitUsd = 0.75;
export const totalLimitUsd = 2;

export const outputDirectory = join(repositoryRoot, ".cache", "spikes", "decisions");
export const rawDirectory = join(outputDirectory, "raw");

export function costUsd(inputTokens: number): number {
  return (inputTokens * pricePerMillionInputTokensUsd) / 1_000_000;
}

/** One line of `raw/<run id>.jsonl`. Contains no credentials. */
export interface RawRecord {
  runId: string;
  key: string;
  kind: string;
  /** Free-form identifiers of what the request was about (note ids, direction, sizes). */
  meta: Record<string, unknown>;
  at: string;
  questions: number;
  /** Characters of the serialized request body (for token estimates). */
  bodyChars: number;
  ok: boolean;
  error?: { kind: string; status: number | null; message: string };
  model?: string;
  usage?: {
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
  requestId?: string | null;
  attemptMs?: number;
  serverMs?: number | null;
  totalMs?: number;
  attemptStatuses?: Array<number | null>;
  rateLimit?: Record<string, string>;
  answers?: unknown[];
}

export function rawPath(runId: string): string {
  return join(rawDirectory, `${runId}.jsonl`);
}

export async function appendRaw(record: RawRecord): Promise<void> {
  await mkdir(rawDirectory, { recursive: true });
  await appendFile(rawPath(record.runId), `${JSON.stringify(record)}\n`);
}

export async function readRaw(runId: string): Promise<RawRecord[]> {
  try {
    const text = await readFile(rawPath(runId), "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RawRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function readAllRaw(): Promise<RawRecord[]> {
  let names: string[];
  try {
    names = (await readdir(rawDirectory)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const all: RawRecord[] = [];
  for (const name of names) all.push(...(await readRaw(name.replace(/\.jsonl$/, ""))));
  return all;
}

export interface Spend {
  requests: number;
  billedRequests: number;
  inputTokens: number;
  usd: number;
}

export function summarizeSpend(records: readonly RawRecord[]): Spend {
  let inputTokens = 0;
  let billedRequests = 0;
  for (const record of records) {
    if (record.usage) {
      inputTokens += record.usage.inputTokens;
      billedRequests += 1;
    }
  }
  return { requests: records.length, billedRequests, inputTokens, usd: costUsd(inputTokens) };
}

/** Characters per token observed so far (conservative); 2 before any data exists. */
export function observedCharsPerToken(records: readonly RawRecord[]): number {
  let chars = 0;
  let tokens = 0;
  for (const record of records) {
    if (!record.usage || record.usage.inputTokens <= 0) continue;
    chars += record.bodyChars;
    tokens += record.usage.inputTokens;
  }
  if (tokens < 500) return 2;
  return Math.max(1.5, (chars / tokens) * 0.85);
}

export interface Projection {
  requests: number;
  bodyChars: number;
  charsPerToken: number;
  inputTokens: number;
  usd: number;
  spentBeforeUsd: number;
}

export async function project(bodyChars: readonly number[]): Promise<Projection> {
  const records = await readAllRaw();
  const charsPerToken = observedCharsPerToken(records);
  const total = bodyChars.reduce((a, b) => a + b, 0);
  const inputTokens = Math.ceil(total / charsPerToken);
  return {
    requests: bodyChars.length,
    bodyChars: total,
    charsPerToken,
    inputTokens,
    usd: costUsd(inputTokens),
    spentBeforeUsd: summarizeSpend(records).usd
  };
}

/** Throws when the run (or the program total) would exceed its spending limit. */
export function assertWithinBudget(projection: Projection): void {
  if (projection.usd > runLimitUsd) {
    throw new Error(
      `Projected spend US$ ${projection.usd.toFixed(4)} exceeds the per-run limit US$ ${runLimitUsd}`
    );
  }
  if (projection.spentBeforeUsd + projection.usd > totalLimitUsd) {
    throw new Error(
      `Spent US$ ${projection.spentBeforeUsd.toFixed(4)} plus projected US$ ${projection.usd.toFixed(4)} exceeds the total limit US$ ${totalLimitUsd}`
    );
  }
}
