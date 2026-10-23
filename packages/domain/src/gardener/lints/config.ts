// The typed configuration of AUDIT's lints (F4 D19, D36). Values marked (cal.) in the F4 spec are
// start values the proofs on ENV-G and ENV-C may revise; rules hold no number (RULES.md section 1).
import { z } from "zod";

const count = (min: number, max: number) => z.number().int().min(min).max(max);
const share = z.number().min(0).max(1);

const DuplicatesSchema = z
  .object({
    /** A note is a duplicate of one of its nearest neighbours at this cosine or above (cal.). */
    cosine: z.number().min(0.5).max(1).default(0.97),
    /** Nearest neighbours of a note examined by the vector arm. */
    neighbours: count(1, 10).default(3),
    /**
     * Notes with the same normalized title are duplicates of each other, unless more than this many
     * share it: a title that common (an "Introduction") says nothing about any pair of them.
     */
    titleGroupMax: count(2, 100).default(6),
    /** Notes whose neighbours one statement reads. */
    batch: count(1, 1_000).default(200),
    /** Notes one audit examines at most; the rest waits for the next audit (it asks for one). */
    perRun: count(1, 1_000_000).default(2_000),
    /** Time one audit spends on the arm before it stops and asks for another (milliseconds). */
    budgetMs: count(100, 600_000).default(3_000),
    /**
     * Findings one audit records at most, checked after each batch of notes: a library imported
     * twice has a duplicate for nearly every note, and the Inbox is not flooded in one go.
     */
    findingsPerRun: count(1, 10_000).default(200),
    /** Open findings one audit checks again for objects that are gone or no longer similar. */
    revalidate: count(0, 10_000).default(200)
  })
  .strict();

const LinksSchema = z
  .object({
    /** Longest redirect chain the lint follows before it calls it a cycle. */
    maxHops: count(2, 1_000).default(64),
    /** Redirects one change-set re-points at most; the rest waits for the next audit. */
    compressPerRun: count(1, 10_000).default(200),
    /** Persisted addresses (the recents and pins) one audit checks. */
    addressesPerRun: count(1, 100_000).default(1_000)
  })
  .strict();

const StaleEmbeddingsSchema = z
  .object({
    /** Re-embedding jobs one audit queues at most. */
    perRun: count(0, 100_000).default(100),
    /** A note whose last embedding job ended less than this long ago is not queued again. */
    retryHours: count(1, 24 * 365).default(24)
  })
  .strict();

const ReplacementSchema = z
  .object({
    /** The share of the placed notes decided again each day (cal.); the window rolls over the library. */
    share: share.default(0.01),
    /** Notes decided again by one audit at most. */
    perRun: count(0, 100_000).default(200),
    /**
     * A note is a candidate when the leaf PLACE would choose now scores this much above the leaf it
     * sits in (the score of PLACE: centroid cosine mixed with the label cosine).
     */
    minGain: z.number().min(0).max(2).default(0.1),
    /** Candidates one audit hands to REBALANCE at most. */
    candidates: count(0, 100_000).default(100)
  })
  .strict();

const ThemeDriftSchema = z
  .object({
    /** A topic whose name's label vector is below this cosine to its centroid is named again (cal.). */
    cosine: z.number().min(-1).max(1).default(0.55),
    /** Topics with fewer items have a centroid too noisy to judge a name by. */
    minItems: count(1, 100_000).default(5),
    /** Topics one audit asks the naming job to look at again. */
    perRun: count(0, 10_000).default(20)
  })
  .strict();

export const AuditLintConfigSchema = z
  .object({
    duplicates: DuplicatesSchema.prefault({}),
    links: LinksSchema.prefault({}),
    staleEmbeddings: StaleEmbeddingsSchema.prefault({}),
    replacement: ReplacementSchema.prefault({}),
    themeDrift: ThemeDriftSchema.prefault({})
  })
  .strict();

export type AuditLintConfig = z.infer<typeof AuditLintConfigSchema>;
export type AuditLintConfigInput = z.input<typeof AuditLintConfigSchema>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const defaultAuditLintConfig: AuditLintConfig = deepFreeze(AuditLintConfigSchema.parse({}));

/** The configuration with overrides, each group merged over its defaults. */
export function auditLintConfigWith(overrides: {
  duplicates?: Partial<AuditLintConfig["duplicates"]>;
  links?: Partial<AuditLintConfig["links"]>;
  staleEmbeddings?: Partial<AuditLintConfig["staleEmbeddings"]>;
  replacement?: Partial<AuditLintConfig["replacement"]>;
  themeDrift?: Partial<AuditLintConfig["themeDrift"]>;
}): AuditLintConfig {
  const base = defaultAuditLintConfig;
  return deepFreeze(
    AuditLintConfigSchema.parse({
      duplicates: { ...base.duplicates, ...overrides.duplicates },
      links: { ...base.links, ...overrides.links },
      staleEmbeddings: { ...base.staleEmbeddings, ...overrides.staleEmbeddings },
      replacement: { ...base.replacement, ...overrides.replacement },
      themeDrift: { ...base.themeDrift, ...overrides.themeDrift }
    })
  );
}
