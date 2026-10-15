// The gate-score cache of the offline replay (spec section 5, T09): ranker log-odds are costly
// (a local model call per query/document pair), so replays and calibration runs serve the gate
// from `.cache/topics/gate-scores/<decider>.jsonl`, keyed by the note's content hash, the
// descriptor hash of the candidate topic and the decider (ranker artifact plus instruction).
// A score is a pure function of that key, so a hit is exactly the model's answer.
//
// The file is append-only JSON lines; the last line for a key wins. A torn last line (a crash
// mid-append) and lines of another decider are skipped and counted, never fatal.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const GateScoreLineSchema = z
  .object({
    decider: z.string().min(1),
    noteHash: z.string().min(1),
    descriptorHash: z.string().min(1),
    /** Ranker log-odds of "relevant"; the gate softmaxes them (D10). */
    logOdds: z.number().finite(),
    /** The ranker truncated the document or the query (recorded, never silent). */
    truncated: z.boolean().optional()
  })
  .strict();

type GateScoreLine = z.infer<typeof GateScoreLineSchema>;
export type GateScore = Omit<GateScoreLine, "decider">;

function scoreOf(line: GateScoreLine): GateScore {
  return {
    noteHash: line.noteHash,
    descriptorHash: line.descriptorHash,
    logOdds: line.logOdds,
    ...(line.truncated === undefined ? {} : { truncated: line.truncated })
  };
}

/** A filename for a decider key: safe characters only; the key itself is stored in every line. */
export function gateScoreFileName(deciderKey: string): string {
  const slug = deciderKey.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^[._]+/u, "");
  if (slug === "") throw new RangeError("A decider key needs at least one letter or digit");
  return `${slug.slice(0, 120)}.jsonl`;
}

const entryKey = (noteHash: string, descriptorHash: string): string =>
  `${noteHash}\u0000${descriptorHash}`;

export interface GateCacheStats {
  hits: number;
  misses: number;
  /** Lines skipped when the file was loaded: unparsable, or written for another decider. */
  skippedLines: number;
}

export class GateScoreCache {
  readonly stats: GateCacheStats = { hits: 0, misses: 0, skippedLines: 0 };
  private readonly entries = new Map<string, GateScore>();
  private pending: string[] = [];
  /** The file ends in a torn line: the next append starts on a fresh line. */
  private tornTail = false;

  private constructor(
    readonly path: string,
    readonly deciderKey: string
  ) {}

  /** Opens (and loads) the cache of one decider under `dir`. */
  static async open(dir: string, deciderKey: string): Promise<GateScoreCache> {
    const cache = new GateScoreCache(join(dir, gateScoreFileName(deciderKey)), deciderKey);
    let text = "";
    try {
      text = await readFile(cache.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    cache.tornTail = text !== "" && !text.endsWith("\n");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        cache.stats.skippedLines += 1;
        continue;
      }
      const parsed = GateScoreLineSchema.safeParse(value);
      if (!parsed.success || parsed.data.decider !== deciderKey) {
        cache.stats.skippedLines += 1;
        continue;
      }
      const score = scoreOf(parsed.data);
      cache.entries.set(entryKey(score.noteHash, score.descriptorHash), score);
    }
    return cache;
  }

  get size(): number {
    return this.entries.size;
  }

  get(noteHash: string, descriptorHash: string): GateScore | undefined {
    const score = this.entries.get(entryKey(noteHash, descriptorHash));
    if (score) this.stats.hits += 1;
    else this.stats.misses += 1;
    return score;
  }

  has(noteHash: string, descriptorHash: string): boolean {
    return this.entries.has(entryKey(noteHash, descriptorHash));
  }

  /** Stores a score in memory; `flush` appends it to the file. */
  set(score: GateScore): void {
    const line = GateScoreLineSchema.parse({ decider: this.deciderKey, ...score });
    const stored = scoreOf(line);
    this.entries.set(entryKey(stored.noteHash, stored.descriptorHash), stored);
    this.pending.push(JSON.stringify(line));
  }

  /** The cached score, or `compute`'s result stored for next time. */
  async getOrCompute(
    noteHash: string,
    descriptorHash: string,
    compute: () => Promise<GateScore> | GateScore
  ): Promise<GateScore> {
    const cached = this.get(noteHash, descriptorHash);
    if (cached) return cached;
    const score = await compute();
    this.set({ ...score, noteHash, descriptorHash });
    return score;
  }

  /** Appends the scores set since the last flush. */
  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];
    try {
      await mkdir(join(this.path, ".."), { recursive: true });
      await appendFile(this.path, `${this.tornTail ? "\n" : ""}${lines.join("\n")}\n`);
      this.tornTail = false;
    } catch (error) {
      this.pending = [...lines, ...this.pending];
      throw error;
    }
  }
}
