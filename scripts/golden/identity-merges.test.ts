import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  compareSnapshots,
  identityMergesUsage,
  identitySnapshotSchema,
  mergedEntityStatistic,
  mergesByRoot,
  mergesByType,
  normalizeSurface,
  parseIdentityCall,
  partitionAgreement,
  readCassetteIdentityCalls,
  renderCassetteMarkdown,
  renderComparisonMarkdown,
  renderSnapshotMarkdown,
  runIdentityMerges,
  summarizeIdentityCalls,
  x7RefRootTitles,
  type IdentityCall,
  type IdentityMention,
  type IdentityRow,
  type IdentitySnapshot
} from "./identity-merges.ts";
import { cacheRoot } from "./test-world.ts";

const row = (
  fingerprint: string,
  entityId: string,
  overrides: Partial<IdentityRow> = {}
): IdentityRow => ({
  fingerprint,
  entityId,
  root: "Root",
  type: "Person",
  name: "Name",
  ...overrides
});
const mention = (
  chunkHash: string,
  surface: string,
  entityId: string,
  overrides: Partial<IdentityMention> = {}
): IdentityMention => ({ root: "Root", chunkHash, chunkIndex: 0, surface, entityId, ...overrides });

/** `rows` identity rows folded into `entities` entities, of one type. */
const rowsOf = (type: string, rows: number, entities: number, root = "Root"): IdentityRow[] =>
  Array.from({ length: rows }, (_, index) =>
    row(`${type}-${root}-${index}`, `${type}-${root}-e${index % entities}`, { type, root })
  );

const snapshot = (
  label: string,
  rows: IdentityRow[],
  mentions: IdentityMention[] = [],
  overrides: Partial<IdentitySnapshot> = {}
): IdentitySnapshot => ({
  format: "memora-identity-merges-snapshot",
  version: 1,
  label,
  capturedAt: "2026-10-23T12:00:00.000Z",
  roots: ["Root"],
  rows,
  mentions,
  catalog: {
    entities: new Set(rows.map((item) => item.entityId)).size,
    entitiesWithoutKeysInRoots: 0
  },
  ...overrides
});

describe("the merged-entity statistic", () => {
  it("is the identity rows minus the distinct entities they resolve to", () => {
    expect(mergedEntityStatistic([])).toEqual({ rows: 0, entities: 0, merged: 0 });
    expect(
      mergedEntityStatistic([
        row("1", "a"),
        row("2", "a"),
        row("3", "b"),
        row("4", "a"),
        row("5", "c")
      ])
    ).toEqual({ rows: 5, entities: 3, merged: 2 });
  });

  it("counts a merge across roots, which a per-root count would miss", () => {
    const rows = [row("1", "a", { root: "One" }), row("2", "a", { root: "Two" })];
    expect(mergedEntityStatistic(rows).merged).toBe(1);
    expect(mergesByRoot(rows).map((item) => item.merged)).toEqual([0, 0]);
  });

  it("splits by type and by root in a stable order", () => {
    const rows = [
      ...rowsOf("Place", 3, 2, "B"),
      ...rowsOf("Concept", 4, 1, "A"),
      ...rowsOf("Person", 2, 2, "A")
    ];
    expect(mergesByType(rows)).toEqual([
      { type: "Concept", rows: 4, entities: 1, merged: 3 },
      { type: "Person", rows: 2, entities: 2, merged: 0 },
      { type: "Place", rows: 3, entities: 2, merged: 1 }
    ]);
    expect(mergesByRoot(rows).map((item) => [item.root, item.merged])).toEqual([
      ["A", 3],
      ["B", 1]
    ]);
  });
});

describe("the canonical partition", () => {
  it("normalizes what two runs of one extraction share", () => {
    expect(normalizeSurface("  José   DA Silva ")).toBe("jose da silva");
    expect(normalizeSurface("Memória")).toBe(normalizeSurface("memoria"));
  });

  it("agrees with itself on every pair", () => {
    const mentions = [mention("c1", "A", "e1"), mention("c1", "B", "e1"), mention("c2", "C", "e2")];
    expect(partitionAgreement(mentions, mentions)).toMatchObject({
      commonMentions: 3,
      onlyBaseline: 0,
      onlyCandidate: 0,
      togetherBaseline: 1,
      togetherCandidate: 1,
      togetherBoth: 1,
      precision: 1,
      recall: 1,
      f1: 1,
      rand: 1
    });
  });

  it("scores a merge the candidate splits and one it adds, by hand", () => {
    // Baseline: {m1 m2 m3} {m4}. Candidate: {m1 m2} {m3 m4}. Pairs together: 3 against 2, 1 in both.
    const baseline = [
      mention("c1", "m1", "x"),
      mention("c1", "m2", "x"),
      mention("c1", "m3", "x"),
      mention("c1", "m4", "y")
    ];
    const candidate = [
      mention("c1", "m1", "p"),
      mention("c1", "m2", "p"),
      mention("c1", "m3", "q"),
      mention("c1", "m4", "q")
    ];
    const agreement = partitionAgreement(baseline, candidate);
    expect(agreement).toMatchObject({
      commonMentions: 4,
      togetherBaseline: 3,
      togetherCandidate: 2,
      togetherBoth: 1,
      entitiesBaseline: 2,
      entitiesCandidate: 2
    });
    expect(agreement.precision).toBeCloseTo(1 / 2, 12);
    expect(agreement.recall).toBeCloseTo(1 / 3, 12);
    expect(agreement.f1).toBeCloseTo(0.4, 12);
    // Of 6 pairs, 3 + 2 - 2 = 3 differ.
    expect(agreement.rand).toBeCloseTo(0.5, 12);
  });

  it("compares only the mentions both runs hold, by chunk content and surface text", () => {
    const baseline = [
      mention("c1", "Ana", "x"),
      mention("c1", "Bia", "x"),
      mention("c2", "Só", "y")
    ];
    const candidate = [
      mention("c1", "ANA", "p", { root: "Other root name", chunkIndex: 9 }),
      mention("c1", "bia", "p"),
      mention("c3", "Novo", "q")
    ];
    const agreement = partitionAgreement(baseline, candidate);
    expect(agreement).toMatchObject({
      commonMentions: 2,
      onlyBaseline: 1,
      onlyCandidate: 1,
      togetherBoth: 1,
      rand: 1
    });
  });

  it("keeps the smaller entity ID of a key that maps to several and says so", () => {
    const baseline = [
      mention("c1", "Ana", "z"),
      mention("c1", "ana", "a"),
      mention("c1", "Bia", "a")
    ];
    const agreement = partitionAgreement(baseline, [
      mention("c1", "Ana", "p"),
      mention("c1", "Bia", "p")
    ]);
    expect(agreement.ambiguousBaseline).toBe(1);
    // "Ana" stays with the smaller entity ID, which also holds Bia.
    expect(agreement.togetherBaseline).toBe(1);
    expect(agreement.togetherBoth).toBe(1);
  });

  it("reports no rate where there is nothing to compare", () => {
    const agreement = partitionAgreement([mention("c1", "A", "x")], [mention("c1", "A", "y")]);
    expect(agreement).toMatchObject({ precision: null, recall: null, f1: null, rand: null });
  });
});

describe("C1's bar, M within 5% of the per-batch run", () => {
  const compare = (baselineMerged: number, candidateMerged: number, noiseMerged?: number) =>
    compareSnapshots({
      baseline: snapshot("per-batch", rowsOf("Person", 100, 100 - baselineMerged)),
      candidate: snapshot("grouped", rowsOf("Person", 100, 100 - candidateMerged)),
      ...(noiseMerged === undefined
        ? {}
        : { noise: snapshot("noise", rowsOf("Person", 100, 100 - noiseMerged)) })
    });

  it("passes inside five per cent of the baseline and says what that allows", () => {
    // 5% of 58 merges is 2.9: two more or fewer pass, three do not.
    expect(compare(58, 60)).toMatchObject({
      verdict: "within",
      withinTolerance: true,
      difference: 2
    });
    expect(compare(58, 56).verdict).toBe("within");
    expect(compare(58, 58)).toMatchObject({ verdict: "within", difference: 0 });
    expect(compare(58, 61).verdict).toBe("miss");
    expect(compare(58, 55).verdict).toBe("miss");
    expect(compare(58, 60).allowedAbsolute).toBeCloseTo(2.9, 9);
    expect(compare(58, 61).relative).toBeCloseTo(3 / 58, 12);
  });

  it("sends a miss no larger than the noise reference's own spread to the owner, never to a pass", () => {
    // The noise run differs from the baseline by +4: a +3 miss is inside that spread.
    expect(compare(58, 61, 62).verdict).toBe("owner");
    expect(compare(58, 55, 62).verdict).toBe("owner");
    expect(compare(58, 63, 62).verdict).toBe("miss");
    expect(compare(58, 61, 59).verdict).toBe("miss");
    expect(compare(58, 60, 62).verdict).toBe("within");
  });

  it("allows nothing around a baseline without merges", () => {
    expect(compare(0, 0).verdict).toBe("within");
    expect(compare(0, 0).relative).toBeNull();
    expect(compare(0, 1).verdict).toBe("miss");
  });

  it("compares the types and warns about what weakens the reading", () => {
    const baseline = snapshot(
      "per-batch",
      [...rowsOf("Person", 10, 5), ...rowsOf("Concept", 4, 4)],
      [],
      {
        catalog: { entities: 12, entitiesWithoutKeysInRoots: 3 }
      }
    );
    const candidate = snapshot(
      "grouped",
      [...rowsOf("Person", 10, 4), ...rowsOf("Place", 2, 1)],
      [],
      {
        roots: ["Other"]
      }
    );
    const comparison = compareSnapshots({ baseline, candidate });
    expect(comparison.byType).toEqual([
      {
        type: "Concept",
        baseline: { rows: 4, entities: 4, merged: 0 },
        candidate: { rows: 0, entities: 0, merged: 0 },
        difference: 0
      },
      {
        type: "Person",
        baseline: { rows: 10, entities: 5, merged: 5 },
        candidate: { rows: 10, entities: 4, merged: 6 },
        difference: 1
      },
      {
        type: "Place",
        baseline: { rows: 0, entities: 0, merged: 0 },
        candidate: { rows: 2, entities: 1, merged: 1 },
        difference: 1
      }
    ]);
    expect(comparison.warnings).toEqual([
      "baseline: 3 entities have no identity key in the roots (the library was not reset first); merges into them are not counted.",
      "baseline and candidate were read for different roots.",
      "baseline holds 14 identity rows, candidate 12: the extraction is not identical, so M is not comparable."
    ]);
  });

  it("renders the verdict, the partitions and the types", () => {
    const mentions = (entityOf: (index: number) => string) =>
      Array.from({ length: 6 }, (_, index) => mention("c1", `m${index}`, entityOf(index)));
    const comparison = compareSnapshots({
      baseline: snapshot(
        "per-batch",
        rowsOf("Person", 10, 6),
        mentions((i) => `e${i % 3}`)
      ),
      candidate: snapshot(
        "grouped",
        rowsOf("Person", 10, 3),
        mentions((i) => `e${i % 2}`)
      ),
      noise: snapshot(
        "noise",
        rowsOf("Person", 10, 5),
        mentions((i) => `e${i % 3}`)
      )
    });
    const markdown = renderComparisonMarkdown(comparison);
    expect(markdown).toContain("Verdict: **miss**");
    expect(markdown).toContain("| baseline (per-batch) | 10 | 6 | 4 |");
    expect(markdown).toContain("| noise reference (noise) | 10 | 5 | 5 |");
    expect(markdown).toContain("| baseline vs candidate |");
    expect(markdown).toContain("| noise reference vs candidate |");
    expect(markdown).toContain("| Person | 10 / 4 | 10 / 7 | +3 |");
    const owner = compareSnapshots({
      baseline: snapshot("per-batch", rowsOf("Person", 100, 42)),
      candidate: snapshot("grouped", rowsOf("Person", 100, 39)),
      noise: snapshot("noise", rowsOf("Person", 100, 38))
    });
    expect(renderComparisonMarkdown(owner)).toContain(
      "goes to the owner and never passes by itself"
    );
  });

  it("renders one snapshot, and the recording's merge decisions beside it", () => {
    const one = snapshot("per-batch", [...rowsOf("Person", 3, 2), ...rowsOf("Place", 2, 2)]);
    const markdown = renderSnapshotMarkdown(one);
    expect(markdown).toContain("| **M, rows folded into another** | **1** |");
    expect(markdown).toContain("| Person | 3 | 2 | 1 |");
    expect(renderSnapshotMarkdown(one, { expectMerges: 1 })).toContain("1 (equal to M)");
    expect(renderSnapshotMarkdown(one, { expectMerges: 4 })).toContain("M differs by -3");
  });

  it("refuses a snapshot of another shape", () => {
    expect(identitySnapshotSchema.safeParse({ format: "other" }).success).toBe(false);
    expect(identitySnapshotSchema.safeParse(snapshot("ok", [])).success).toBe(true);
    expect(
      identitySnapshotSchema.safeParse({ ...snapshot("ok", []), surprise: true }).success
    ).toBe(false);
    expect(x7RefRootTitles).toHaveLength(5);
  });
});

// --- The cassette ----------------------------------------------------------------------------

const preamble = "Produce all natural-language response text in English.\n\n";
const entityInstruction =
  'Match entities only when the evidence establishes the SAME real-world identity. Same type and compatible names are necessary.\nReturn ONLY {"matches":[["r1","c1"],["r2",null]]}.\n';
const relationInstruction =
  'Match directed relation types only when their FULL meanings are interchangeable.\nReturn ONLY {"matches":[]}.\n';

function identityEntry(options: {
  instruction?: string;
  rows: Array<[string, string, string]>;
  candidates?: number;
  output?: unknown;
  recordedAt?: string;
  taskType?: string;
  responses?: number;
}) {
  const relations = options.rows.map(([key, predicate, definition], index) => [
    key,
    predicate,
    definition,
    [`c${index + 1}`]
  ]);
  const candidates = Array.from(
    { length: options.candidates ?? options.rows.length },
    (_, index) => [`c${index + 1}`, "Person: Someone", "A description."]
  );
  const response = {
    output: options.output ?? "",
    providerId: "openai-codex",
    recordedAt: options.recordedAt ?? "2026-10-18T22:51:39.333Z"
  };
  return {
    format: "memora-ai-cassette-entry",
    version: 1,
    key: "k",
    taskType: options.taskType ?? "knowledge-graph-generation",
    request: {
      input: `${preamble}${options.instruction ?? entityInstruction}${JSON.stringify({ relations, candidates })}`
    },
    responses: Array.from({ length: options.responses ?? 1 }, () => response)
  };
}

describe("identity calls in a cassette", () => {
  it("reads the rows of a call and what the writer answered", () => {
    const call = parseIdentityCall(
      identityEntry({
        rows: [
          ["r1", "Person: Camilo", "A man."],
          ["r2", "Concept: Memory", "A faculty."],
          ["r3", "Person: Rita", "A woman."]
        ],
        output: JSON.stringify({
          matches: [
            ["r1", "c1"],
            ["r2", null]
          ]
        })
      }),
      "entity"
    )!;
    expect(call).toMatchObject({
      rows: 3,
      candidates: 3,
      matches: 1,
      nulls: 1,
      unanswered: 1,
      responses: 1,
      types: { Person: 2, Concept: 1 }
    });
    expect(call.characters).toBeGreaterThan(call.payloadCharacters);
  });

  it("tells entity identity from relation types and from any other call", () => {
    const rows: Array<[string, string, string]> = [["r1", "Person: A", "x"]];
    const entry = identityEntry({ rows, output: '{"matches":[["r1",null]]}' });
    expect(parseIdentityCall(entry, "entity")).not.toBeNull();
    expect(parseIdentityCall(entry, "relation")).toBeNull();
    const relation = identityEntry({
      rows: [["r1", "used_to_accuse", "x"]],
      instruction: relationInstruction,
      output: '{"matches":[["r1","c1"]]}'
    });
    expect(parseIdentityCall(relation, "relation")).toMatchObject({ rows: 1, matches: 1 });
    expect(parseIdentityCall(relation, "entity")).toBeNull();
    expect(parseIdentityCall(identityEntry({ rows, taskType: "embedding" }), "entity")).toBeNull();
    expect(parseIdentityCall({ nonsense: true }, "entity")).toBeNull();
    expect(
      parseIdentityCall(
        {
          taskType: "knowledge-graph-generation",
          request: { input: `${entityInstruction}no json` },
          responses: []
        },
        "entity"
      )
    ).toBeNull();
  });

  it("counts an unreadable answer as no answers and a retried entry as retried", () => {
    const rows: Array<[string, string, string]> = [
      ["r1", "Person: A", "x"],
      ["r2", "Person: B", "y"]
    ];
    expect(parseIdentityCall(identityEntry({ rows, output: "not json" }), "entity")).toMatchObject({
      matches: 0,
      nulls: 0,
      unanswered: 2
    });
    expect(parseIdentityCall(identityEntry({ rows, responses: 2 }), "entity")?.responses).toBe(2);
  });

  const call = (overrides: Partial<IdentityCall>): IdentityCall => ({
    recordedAt: null,
    rows: 1,
    candidates: 1,
    characters: 2000,
    payloadCharacters: 400,
    types: { Person: 1 },
    matches: 1,
    nulls: 0,
    unanswered: 0,
    responses: 1,
    ...overrides
  });

  it("summarizes group sizes, decisions and which cap bound", () => {
    const summary = summarizeIdentityCalls(
      [
        call({ rows: 12, matches: 9, nulls: 3, types: { Person: 12 } }),
        // 11 rows of about 60 characters would not leave room for a twelfth under 12,000.
        call({
          rows: 11,
          characters: 11_970,
          payloadCharacters: 660,
          matches: 11,
          types: { Concept: 11 }
        }),
        call({ rows: 3, matches: 0, nulls: 3, responses: 2, types: { Person: 3 } })
      ],
      { kind: "entity", rowCap: 12, characterCap: 12_000 }
    );
    expect(summary).toMatchObject({
      calls: 3,
      rows: 26,
      matches: 20,
      nulls: 6,
      retried: 1,
      bound: { rows: 1, characters: 1, neither: 1 },
      types: { Person: 15, Concept: 11 },
      rowsPerCall: { min: 3, max: 12 }
    });
    expect(summary.rowsPerCall.mean).toBeCloseTo(26 / 3, 9);
    expect(summary.histogram).toEqual([
      { rows: 3, calls: 1 },
      { rows: 11, calls: 1 },
      { rows: 12, calls: 1 }
    ]);
    const markdown = renderCassetteMarkdown(summary, "Cassette x");
    expect(markdown).toContain("| Rows per call, min / mean / max | 3 / 8.67 / 12 |");
    expect(markdown).toContain("Rows by type: Concept 11, Person 15.");
    expect(
      summarizeIdentityCalls([], { kind: "relation", rowCap: 12, characterCap: 12_000 }).rowsPerCall
    ).toEqual({
      min: 0,
      mean: 0,
      max: 0
    });
  });

  describe("on disk", () => {
    let directory = "";
    const write = async (name: string, entry: unknown, pretty = false) => {
      const shard = name.slice(0, 2);
      await mkdir(join(directory, "entries", shard), { recursive: true });
      await writeFile(
        join(directory, "entries", shard, `${name}.json`),
        pretty ? JSON.stringify(entry, null, 2) : JSON.stringify(entry)
      );
    };
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "memora-cassette-"));
      const rows: Array<[string, string, string]> = [["r1", "Person: A", "x"]];
      await write(
        "aa-late",
        identityEntry({
          rows,
          recordedAt: "2026-10-20T10:00:00.000Z",
          output: '{"matches":[["r1","c1"]]}'
        })
      );
      await write(
        "bb-early",
        identityEntry({
          rows,
          recordedAt: "2026-10-18T10:00:00.000Z",
          output: '{"matches":[["r1",null]]}'
        }),
        true
      );
      await write("cc-embedding", {
        taskType: "embedding",
        request: { input: "text" },
        responses: [{ output: [0.1, 0.2] }]
      });
      await write("dd-extraction", {
        taskType: "knowledge-graph-generation",
        request: { input: "Extract knowledge graph elements only from the source excerpts below." },
        responses: [{ output: "{}" }]
      });
    });
    afterAll(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("finds the identity calls in either JSON layout, oldest first, and skips the rest", async () => {
      const calls = await readCassetteIdentityCalls(directory, "entity");
      expect(calls.map((item) => item.recordedAt)).toEqual([
        "2026-10-18T10:00:00.000Z",
        "2026-10-20T10:00:00.000Z"
      ]);
      expect(calls.map((item) => item.matches)).toEqual([0, 1]);
    });

    it("keeps the calls recorded in a window, as a record-resume run adds to an old cassette", async () => {
      expect(
        await readCassetteIdentityCalls(directory, "entity", { since: "2026-10-19T00:00:00Z" })
      ).toHaveLength(1);
      expect(
        await readCassetteIdentityCalls(directory, "entity", { until: "2026-10-19T00:00:00Z" })
      ).toHaveLength(1);
      expect(await readCassetteIdentityCalls(directory, "relation")).toEqual([]);
    });

    it("runs as the cassette command, with the caps it was given", async () => {
      const out = join(directory, "report.md");
      const json = join(directory, "report.json");
      expect(
        await runIdentityMerges([
          "cassette",
          "--dir",
          directory,
          "--row-cap",
          "1",
          "--out",
          out,
          "--json",
          json
        ])
      ).toBeNull();
      expect(await readFile(out, "utf8")).toContain("| Calls | 2 |");
      const summary = JSON.parse(await readFile(json, "utf8")) as {
        rowCap: number;
        bound: { rows: number };
      };
      expect(summary).toMatchObject({ rowCap: 1, bound: { rows: 2 } });
      await expect(
        runIdentityMerges(["cassette", "--dir", directory, "--kind", "relation"])
      ).rejects.toThrow("No relation identity calls found");
      await expect(
        runIdentityMerges(["cassette", "--dir", directory, "--kind", "other"])
      ).rejects.toThrow("--kind");
      await expect(
        runIdentityMerges(["cassette", "--dir", directory, "--row-cap", "0"])
      ).rejects.toThrow("--row-cap");
      await expect(runIdentityMerges(["cassette"])).rejects.toThrow("needs --dir");
    });
  });
});

// --- The commands on snapshots ---------------------------------------------------------------

describe("the commands", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-merges-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("explains itself and refuses what it does not know", async () => {
    expect(await runIdentityMerges([])).toBe(identityMergesUsage);
    expect(await runIdentityMerges(["--help"])).toContain("snapshot --db");
    expect(await runIdentityMerges(["report", "--help"])).toContain("compare --baseline");
    await expect(runIdentityMerges(["frobnicate"])).rejects.toThrow('Unknown command "frobnicate"');
    await expect(runIdentityMerges(["snapshot", "--out", "x.json"])).rejects.toThrow(
      "snapshot needs --db and --out"
    );
    await expect(runIdentityMerges(["report"])).rejects.toThrow("report needs --snapshot");
    await expect(runIdentityMerges(["compare", "--baseline", "a.json"])).rejects.toThrow(
      "compare needs"
    );
    await expect(runIdentityMerges(["report", "--surprise"])).rejects.toThrow();
  });

  it("refuses a database that is not on this machine before it connects", async () => {
    await expect(
      runIdentityMerges([
        "snapshot",
        "--db",
        "postgres://u:p@example.com:5432/db",
        "--out",
        join(directory, "s.json")
      ])
    ).rejects.toThrow("loopback");
  });

  it("reports and compares snapshots read from files", async () => {
    const a = join(directory, "a.json");
    const b = join(directory, "b.json");
    const n = join(directory, "n.json");
    await writeFile(
      a,
      JSON.stringify(snapshot("per-batch", rowsOf("Person", 100, 60), [mention("c1", "A", "x")]))
    );
    await writeFile(
      b,
      JSON.stringify(snapshot("grouped", rowsOf("Person", 100, 59), [mention("c1", "A", "y")]))
    );
    await writeFile(n, JSON.stringify(snapshot("noise", rowsOf("Person", 100, 60))));
    const report = await runIdentityMerges(["report", "--snapshot", a, "--expect-merges", "40"]);
    expect(report).toContain("| **M, rows folded into another** | **40** |");
    expect(report).toContain("40 (equal to M)");
    const json = join(directory, "compare.json");
    const markdown = join(directory, "compare.md");
    expect(
      await runIdentityMerges([
        "compare",
        "--baseline",
        a,
        "--candidate",
        b,
        "--noise",
        n,
        "--json",
        json,
        "--out",
        markdown
      ])
    ).toBeNull();
    expect(await readFile(markdown, "utf8")).toContain("Verdict: **within**");
    const comparison = JSON.parse(await readFile(json, "utf8")) as {
      verdict: string;
      difference: number;
    };
    expect(comparison).toMatchObject({ verdict: "within", difference: 1 });
    await expect(
      runIdentityMerges(["compare", "--baseline", a, "--candidate", b, "--tolerance", "2"])
    ).rejects.toThrow("--tolerance");
    await expect(
      runIdentityMerges(["report", "--snapshot", a, "--expect-merges", "-1"])
    ).rejects.toThrow("--expect-merges");
    await writeFile(join(directory, "bad.json"), JSON.stringify({ format: "nope" }));
    await expect(
      runIdentityMerges(["report", "--snapshot", join(directory, "bad.json")])
    ).rejects.toThrow();
  });
});

// --- F3's recording of X7-REF ----------------------------------------------------------------

const x7Cassette = join(cacheRoot, "golden/cassettes/golden-x7-f3");

describe.skipIf(!existsSync(join(x7Cassette, "entries")))(
  "X7-REF's recorded identity calls",
  () => {
    it("holds 69 rows over 26 calls, 58 of them folded into a candidate: the baseline M of a replay", async () => {
      const calls = await readCassetteIdentityCalls(x7Cassette, "entity");
      const summary = summarizeIdentityCalls(calls, {
        kind: "entity",
        rowCap: 12,
        characterCap: 12_000
      });
      expect(summary).toMatchObject({
        calls: 26,
        rows: 69,
        matches: 58,
        nulls: 11,
        unanswered: 0,
        retried: 0,
        rowsPerCall: { min: 1, max: 7 },
        types: { Concept: 17, Organization: 3, Person: 38, Place: 11 }
      });
      expect(summary.rowsPerCall.mean).toBeCloseTo(69 / 26, 9);
      expect(summary.bound).toEqual({ rows: 0, characters: 0, neither: 26 });
    });

    it("holds 5 relation-type calls of one row each", async () => {
      const summary = summarizeIdentityCalls(
        await readCassetteIdentityCalls(x7Cassette, "relation"),
        {
          kind: "relation",
          rowCap: 12,
          characterCap: 12_000
        }
      );
      expect(summary).toMatchObject({ calls: 5, rows: 5, matches: 2, nulls: 3 });
    });
  }
);
