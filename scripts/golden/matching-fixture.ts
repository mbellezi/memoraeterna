/**
 * The expanded DEV matching benchmark (`scripts/fixtures/matching-benchmark.json`: 60 synthetic roots,
 * 82 records with chapters, 40 tuning and 20 held-out roots, human expected and forbidden root pairs)
 * expressed as a golden-runner manifest. Pure functions only: `build-matching-fixture.ts` writes the
 * files and `matching-evaluation.ts` reads the mapping back to score a library.
 *
 * The runner imports every source as a Markdown file from `.cache/golden/sources/<key>.md`, so the
 * generated files are named `mf-<benchmark id>.md`. Assessment labels, partitions and expected
 * ideas never enter a file: they live only in the mapping.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

export const matchingFixtureVersion = "matching-benchmark-v1";
export const matchingFixtureManifestName = "golden-matching-fixture";
/** The benchmark ran from 2026-09-08; a constant keeps the manifest byte-stable. */
export const matchingFixtureCapturedAt = "2026-09-08T00:00:00.000Z";
/** Workspace-relative folder for the generated manifest and mapping (gitignored). */
export const matchingFixtureDirectory = ".cache/golden/matching-fixture";
export const matchingFixtureManifestPath = `${matchingFixtureDirectory}/manifest.json`;
export const matchingFixtureMappingPath = `${matchingFixtureDirectory}/mapping.json`;
/** Workspace-relative folder the golden runner reads sources from (`goldenSourcePath`). */
export const goldenSourcesDirectory = ".cache/golden/sources";
const keyPrefix = "mf-";
const language = "pt-BR";

export const partitionSchema = z.enum(["tuning", "holdout"]);
export type Partition = z.infer<typeof partitionSchema>;

const benchmarkId = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,15}$/);
const rootPairSchema = z.tuple([benchmarkId, benchmarkId]);
const recordSchema = z.object({
  key: benchmarkId,
  title: z.string().trim().min(1),
  content: z.string().trim().min(1)
});
const singleRootSchema = recordSchema.extend({
  partition: partitionSchema,
  family: z.string().min(1)
});
const bookRootSchema = z.object({
  key: benchmarkId,
  title: z.string().trim().min(1),
  partition: partitionSchema,
  family: z.string().min(1),
  chapters: z.array(recordSchema).min(1)
});

export const matchingFixtureSchema = z.object({
  version: z.literal(matchingFixtureVersion),
  sources: z.array(z.union([bookRootSchema, singleRootSchema])).min(1),
  expectedRootPairs: z.array(
    z.object({ pair: rootPairSchema, partition: partitionSchema, rationale: z.string() })
  ),
  forbiddenRootPairs: z.array(
    z.object({ pair: rootPairSchema, partition: partitionSchema, rationale: z.string() })
  ),
  ambiguousRootPairs: z.array(z.object({ pair: rootPairSchema, reason: z.string() })),
  zeroNoteSources: z.array(benchmarkId)
});
export type MatchingFixture = z.infer<typeof matchingFixtureSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const labelledPairSchema = z
  .object({ pair: rootPairSchema, partition: partitionSchema, rationale: z.string() })
  .strict();

export const matchingMappingSchema = z
  .object({
    format: z.literal("memora-golden-matching-mapping"),
    version: z.literal(1),
    fixture: z
      .object({
        path: z.string(),
        version: z.literal(matchingFixtureVersion),
        sha256: sha256Schema
      })
      .strict(),
    manifest: z.object({ name: z.string(), path: z.string() }).strict(),
    roots: z
      .array(
        z
          .object({
            id: benchmarkId,
            manifestKey: z.string(),
            title: z.string(),
            partition: partitionSchema,
            family: z.string(),
            kind: z.enum(["document", "container"]),
            /** Designated nonconceptual sources: they should link to nothing. */
            nonconceptual: z.boolean(),
            /** Chapters of a book (empty for a single document). */
            records: z.array(
              z.object({ id: benchmarkId, manifestKey: z.string(), title: z.string() }).strict()
            )
          })
          .strict()
      )
      .min(1),
    expectedRootPairs: z.array(labelledPairSchema),
    forbiddenRootPairs: z.array(labelledPairSchema),
    ambiguousRootPairs: z.array(z.object({ pair: rootPairSchema, reason: z.string() }).strict()),
    /** Manifest keys for MEMORA_GOLDEN_ONLY: the whole partition and what it needs to be scored. */
    subsets: z.object({ tuning: z.array(z.string()), holdout: z.array(z.string()) }).strict()
  })
  .strict();
export type MatchingMapping = z.infer<typeof matchingMappingSchema>;
export type MappingRoot = MatchingMapping["roots"][number];

export interface MatchingFixtureFile {
  key: string;
  /** Workspace-relative path where the golden runner reads the file. */
  path: string;
  content: string;
  sha256: string;
  bytes: number;
}

export interface BuiltMatchingFixture {
  /** A `memora-golden-manifest` (validated against the runner's schema by the callers). */
  manifest: Record<string, unknown>;
  files: MatchingFixtureFile[];
  mapping: MatchingMapping;
}

/** Order-independent identity of a root pair. */
export const pairKey = (a: string, b: string): string => [a, b].sort().join("/");

/** Manifest key of a benchmark record: `P01a` becomes `mf-p01a`. */
export const manifestKey = (id: string): string => `${keyPrefix}${id.toLowerCase()}`;

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function parseMatchingFixture(raw: unknown): MatchingFixture {
  const fixture = matchingFixtureSchema.parse(raw);
  const problems = fixtureProblems(fixture);
  if (problems.length) throw new Error(`Invalid matching fixture:\n- ${problems.join("\n- ")}`);
  return fixture;
}

/** Cross-reference checks the schema cannot express. Empty when the fixture is consistent. */
export function fixtureProblems(fixture: MatchingFixture): string[] {
  const problems: string[] = [];
  const roots = new Map(fixture.sources.map((source) => [source.key, source]));
  const records = fixture.sources.flatMap((source) =>
    "chapters" in source ? source.chapters : [source]
  );
  const ids = [...fixture.sources.map((source) => source.key)];
  for (const source of fixture.sources)
    if ("chapters" in source) ids.push(...source.chapters.map((c) => c.key));
  for (const id of ids.filter((id, index) => ids.indexOf(id) !== index))
    problems.push(`duplicate id ${id}`);
  const keys = ids.map(manifestKey);
  for (const key of keys.filter((key, index) => keys.indexOf(key) !== index))
    problems.push(`ids collide once lowercased (${key})`);
  const contents = records.map((record) => record.content.trim());
  for (const [index, content] of contents.entries())
    if (contents.indexOf(content) !== index)
      problems.push(`${records[index]!.key} repeats the content of another record`);
  const titles = fixture.sources.map((source) => source.title);
  for (const title of titles.filter((title, index) => titles.indexOf(title) !== index))
    problems.push(`two roots are titled "${title}": the evaluator resolves roots by title`);

  const seen = new Map<string, string>();
  for (const [label, list] of [
    ["expected", fixture.expectedRootPairs],
    ["forbidden", fixture.forbiddenRootPairs]
  ] as const) {
    for (const { pair, partition } of list) {
      const [a, b] = pair;
      const key = pairKey(a, b);
      if (a === b) problems.push(`${label} pair ${key} joins a root to itself`);
      const members = pair.map((id) => roots.get(id));
      if (members.some((member) => !member)) {
        problems.push(`${label} pair ${key} names an id that is not a root`);
        continue;
      }
      const holdouts = members.filter((member) => member!.partition === "holdout").length;
      if ((partition === "holdout") !== holdouts > 0)
        problems.push(
          `${label} pair ${key} is labelled ${partition} but has ${holdouts} held-out roots`
        );
      if (seen.has(key)) problems.push(`pair ${key} is both ${seen.get(key)} and ${label}`);
      seen.set(key, label);
    }
  }
  for (const { pair } of fixture.ambiguousRootPairs)
    if (pair.some((id) => !roots.has(id)))
      problems.push(`ambiguous pair ${pairKey(...pair)} names an id that is not a root`);
  for (const id of fixture.zeroNoteSources)
    if (!roots.has(id)) problems.push(`zero-note source ${id} is not a root`);
  return problems;
}

/** Turns the benchmark into pinned Markdown files, a golden manifest and the scoring mapping. */
export function buildMatchingFixture(
  fixture: MatchingFixture,
  fixtureSource: { path: string; text: string }
): BuiltMatchingFixture {
  const problems = fixtureProblems(fixture);
  if (problems.length) throw new Error(`Invalid matching fixture:\n- ${problems.join("\n- ")}`);
  const files: MatchingFixtureFile[] = [];
  const file = (record: { key: string; content: string }) => {
    const key = manifestKey(record.key);
    const content = `${record.content.trim()}\n`;
    const bytes = Buffer.from(content, "utf8");
    const built = {
      key,
      path: `${goldenSourcesDirectory}/${key}.md`,
      content,
      sha256: sha256Of(bytes),
      bytes: bytes.length
    };
    files.push(built);
    return built;
  };
  const common = (id: string) => ({
    language,
    license: "synthetic-fixture",
    attribution: `Synthetic matching benchmark record ${id} (${matchingFixtureVersion}); no third-party content`
  });
  const document = (
    record: { key: string; title: string; content: string },
    descriptor: Record<string, unknown>
  ) => {
    const built = file(record);
    return {
      key: built.key,
      kind: "document",
      import: "file",
      title: record.title,
      ...common(record.key),
      format: "markdown",
      // The runner's schema requires an HTTPS URL; this one is reserved (.invalid) and never fetched.
      url: `https://matching-fixture.invalid/${built.key}.md`,
      sha256: built.sha256,
      bytes: built.bytes,
      descriptor
    };
  };

  const manifestSources = fixture.sources.map((source) =>
    "chapters" in source
      ? {
          key: manifestKey(source.key),
          kind: "container",
          title: source.title,
          ...common(source.key),
          descriptor: { type: "Book" },
          children: source.chapters.map((chapter) => document(chapter, { type: "BookChapter" }))
        }
      : document(source, { type: "StandaloneArticle" })
  );

  const nonconceptual = new Set(fixture.zeroNoteSources);
  const roots: MappingRoot[] = fixture.sources.map((source) => ({
    id: source.key,
    manifestKey: manifestKey(source.key),
    title: source.title,
    partition: source.partition,
    family: source.family,
    kind: "chapters" in source ? "container" : "document",
    nonconceptual: nonconceptual.has(source.key),
    records:
      "chapters" in source
        ? source.chapters.map((chapter) => ({
            id: chapter.key,
            manifestKey: manifestKey(chapter.key),
            title: chapter.title
          }))
        : []
  }));

  // A held-out pair is scored against the whole library, so its tuning partners must be present.
  const needed = new Set(
    fixture.sources.filter((s) => s.partition === "holdout").map((source) => source.key)
  );
  for (const { pair, partition } of [...fixture.expectedRootPairs, ...fixture.forbiddenRootPairs])
    if (partition === "holdout") for (const id of pair) needed.add(id);
  const keysWhere = (include: (source: MatchingFixture["sources"][number]) => boolean) =>
    fixture.sources.filter(include).map((source) => manifestKey(source.key));

  const manifest = {
    format: "memora-golden-manifest",
    version: 1,
    name: matchingFixtureManifestName,
    description:
      `Synthetic pt-BR matching-quality fixture: the expanded DEV matching benchmark (${roots.length} roots, ` +
      `${files.length + manifestSources.filter((source) => source.kind === "container").length} records) as ` +
      `Markdown files in ${goldenSourcesDirectory}/mf-*.md, generated by scripts/golden/build-matching-fixture.ts. ` +
      "Labels and partitions stay in mapping.json.",
    capturedAt: matchingFixtureCapturedAt,
    sources: manifestSources
  };
  const mapping: MatchingMapping = {
    format: "memora-golden-matching-mapping",
    version: 1,
    fixture: {
      path: fixtureSource.path,
      version: matchingFixtureVersion,
      sha256: sha256Of(Buffer.from(fixtureSource.text, "utf8"))
    },
    manifest: { name: matchingFixtureManifestName, path: matchingFixtureManifestPath },
    roots,
    expectedRootPairs: fixture.expectedRootPairs,
    forbiddenRootPairs: fixture.forbiddenRootPairs,
    ambiguousRootPairs: fixture.ambiguousRootPairs,
    subsets: {
      tuning: keysWhere((source) => source.partition === "tuning"),
      holdout: keysWhere((source) => needed.has(source.key))
    }
  };
  return { manifest, files, mapping: matchingMappingSchema.parse(mapping) };
}
