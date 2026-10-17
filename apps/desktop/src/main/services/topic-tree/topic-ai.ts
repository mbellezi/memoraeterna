// How much AI the topic engine may use. G1 (D23): a golden run (`MEMORA_GOLDEN_RUN`) reads
// `MEMORA_GOLDEN_TOPICS=deterministic|full` once at startup and defaults to `deterministic`, which
// places and rebalances but makes no topic AI call; every other run (DEV, packaged, E6) is `full`.
// D34: background naming, Areas and label-embedding calls are capped per local day; at the cap the
// work waits for the next day and the status says why. Interactive overviews are not capped.
import { createSettingsRepository } from "@app/db";
import type { PgPool } from "@app/db";
import { z } from "zod";

export const topicAiModes = ["full", "deterministic"] as const;
export type TopicAiMode = (typeof topicAiModes)[number];

/**
 * G1, read once at startup. `MEMORA_GOLDEN_TOPICS` means nothing without `MEMORA_GOLDEN_RUN`, and
 * a packaged build never runs golden. An unknown value in a golden run is reported and read as
 * `deterministic`, the mode that spends nothing.
 */
export function readTopicAiMode(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
  logger?: Pick<Console, "warn">
): TopicAiMode {
  if (isPackaged || !env.MEMORA_GOLDEN_RUN?.trim()) return "full";
  const value = env.MEMORA_GOLDEN_TOPICS?.trim();
  if (!value) return "deterministic";
  if ((topicAiModes as readonly string[]).includes(value)) return value as TopicAiMode;
  logger?.warn(`MEMORA_GOLDEN_TOPICS=${value} is not deterministic or full; using deterministic`);
  return "deterministic";
}

/** DEV knobs of a one-time rename pass of a measurement profile (never in a packaged build). */
export const topicRenameKnobs = {
  /** `1`: LLM names an earlier prompt version wrote are named again, once each. */
  renameRevision: "MEMORA_TOPIC_RENAME_REVISION",
  /** A whole number: today's cap of background topic AI calls instead of the tree's (D34). */
  dailyCap: "MEMORA_TOPIC_AI_DAILY_CAP"
} as const;

export interface TopicRenameKnobs {
  renameRevisions: boolean;
  /** Null: the tree's `ai.maxBackgroundCallsPerDay`. */
  dailyCap: number | null;
}

/**
 * The rename-pass knobs, read once at startup. A packaged build ignores them; a value that is not
 * `1` (or a whole number for the cap) is reported and ignored.
 */
export function readTopicRenameKnobs(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
  logger?: Pick<Console, "warn">
): TopicRenameKnobs {
  const off: TopicRenameKnobs = { renameRevisions: false, dailyCap: null };
  if (isPackaged) return off;
  const rename = env[topicRenameKnobs.renameRevision]?.trim();
  const cap = env[topicRenameKnobs.dailyCap]?.trim();
  if (rename && rename !== "1") {
    logger?.warn(`${topicRenameKnobs.renameRevision}=${rename} is not 1; ignored`);
  }
  const parsedCap = cap ? Number(cap) : null;
  const validCap =
    parsedCap !== null && Number.isSafeInteger(parsedCap) && parsedCap >= 0 ? parsedCap : null;
  if (cap && validCap === null) {
    logger?.warn(`${topicRenameKnobs.dailyCap}=${cap} is not a whole number; ignored`);
  }
  return { renameRevisions: rename === "1", dailyCap: validCap };
}

/** The settings key of today's background topic AI calls (D34); a library reset clears it. */
export const topicAiBudgetSettingKey = "topics.ai.daily.v1";

const BudgetRecordSchema = z
  .object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), calls: z.number().int().min(0) })
  .strict();
type BudgetRecord = z.output<typeof BudgetRecordSchema>;

export interface TopicAiBudgetStore {
  read(): Promise<unknown>;
  write(record: BudgetRecord): Promise<void>;
}

export function settingsAiBudgetStore(getPool: () => PgPool | null): TopicAiBudgetStore {
  const settings = () => {
    const pool = getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return createSettingsRepository(pool);
  };
  return {
    read: () => settings().get(topicAiBudgetSettingKey),
    write: async (record) => {
      await settings().set(topicAiBudgetSettingKey, record);
    }
  };
}

/** YYYY-MM-DD of the local calendar day. */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface TopicAiBudgetUsage {
  day: string;
  calls: number;
  cap: number;
  remaining: number;
  capReached: boolean;
}

/**
 * The D34 counter of background topic AI calls per local day. Reservations run one at a time in
 * this process, so concurrent callers never overspend; a new day starts from zero.
 */
export class TopicAiBudget {
  private tail: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly options: {
      store: TopicAiBudgetStore;
      /** `topics.ai.maxBackgroundCallsPerDay` of the active tree's configuration. */
      cap: () => number;
      now?: () => Date;
    }
  ) {}

  public usage(): Promise<TopicAiBudgetUsage> {
    return this.serialized(async () => this.describe(await this.today()));
  }

  /** Reserves `calls` of today's budget; false (nothing reserved) when they would pass the cap. */
  public reserve(calls = 1): Promise<boolean> {
    if (!Number.isInteger(calls) || calls < 1) throw new RangeError("Reserve whole calls");
    return this.serialized(async () => {
      const record = await this.today();
      if (record.calls + calls > this.options.cap()) return false;
      await this.options.store.write({ day: record.day, calls: record.calls + calls });
      return true;
    });
  }

  private async today(): Promise<BudgetRecord> {
    const day = localDay(this.options.now?.() ?? new Date());
    const stored = BudgetRecordSchema.safeParse(await this.options.store.read());
    return stored.success && stored.data.day === day ? stored.data : { day, calls: 0 };
  }

  private describe(record: BudgetRecord): TopicAiBudgetUsage {
    const cap = this.options.cap();
    return {
      day: record.day,
      calls: record.calls,
      cap,
      remaining: Math.max(0, cap - record.calls),
      capReached: record.calls >= cap
    };
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
