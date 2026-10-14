import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  goldenManifestFiles,
  goldenManifestSchema,
  goldenSourcePath
} from "../../apps/desktop/src/main/services/golden-runner.ts";
import {
  buildMatchingFixture,
  fixtureProblems,
  manifestKey,
  matchingMappingSchema,
  pairKey,
  parseMatchingFixture,
  type MatchingFixture
} from "./matching-fixture.ts";

const workspace = resolve(import.meta.dirname, "..", "..");
const fixturePath = "scripts/fixtures/matching-benchmark.json";
const text = readFileSync(resolve(workspace, fixturePath), "utf8");
interface RawRecord {
  key: string;
  content: string;
  ideas: string[];
}
const raw = JSON.parse(text) as {
  sources: Array<RawRecord | { key: string; chapters: RawRecord[] }>;
  expectedRootPairs: Array<{ rationale: string }>;
};
const fixture = parseMatchingFixture(raw);
const built = buildMatchingFixture(fixture, { path: fixturePath, text });

describe("the matching-quality fixture built from the committed benchmark", () => {
  it("keeps the benchmark's shape: 60 roots, 82 records, 40 tuning and 20 held-out roots", () => {
    const roots = built.mapping.roots;
    expect(roots).toHaveLength(60);
    expect(roots.filter((r) => r.partition === "tuning")).toHaveLength(40);
    expect(roots.filter((r) => r.partition === "holdout")).toHaveLength(20);
    expect(roots.filter((r) => r.kind === "container")).toHaveLength(11);
    expect(roots.reduce((sum, r) => sum + 1 + r.records.length, 0)).toBe(82);
    expect(built.files).toHaveLength(71);
  });

  it("keeps the human labels per partition: 28 expected and 35 forbidden held-out pairs", () => {
    const count = (list: Array<{ partition: string }>, partition: string) =>
      list.filter((entry) => entry.partition === partition).length;
    expect(count(built.mapping.expectedRootPairs, "holdout")).toBe(28);
    expect(count(built.mapping.forbiddenRootPairs, "holdout")).toBe(35);
    expect(count(built.mapping.expectedRootPairs, "tuning")).toBe(26);
    expect(count(built.mapping.forbiddenRootPairs, "tuning")).toBe(25);
    expect(built.mapping.ambiguousRootPairs.map(({ pair }) => pairKey(...pair))).toEqual([
      "P10/P11"
    ]);
    expect(built.mapping.roots.filter((r) => r.nonconceptual)).toHaveLength(17);
  });

  it("produces a manifest the golden runner accepts, with books as containers of chapters", () => {
    const manifest = goldenManifestSchema.parse(built.manifest);
    expect(manifest.name).toBe("golden-matching-fixture");
    expect(manifest.sources).toHaveLength(60);
    const book = manifest.sources.find((source) => source.key === "mf-p01");
    expect(book).toMatchObject({ kind: "container", descriptor: { type: "Book" } });
    expect(book && "children" in book && book.children.map((child) => child.key)).toEqual([
      "mf-p01a",
      "mf-p01b"
    ]);
    const single = manifest.sources.find((source) => source.key === "mf-p02");
    expect(single).toMatchObject({
      kind: "document",
      import: "file",
      format: "markdown",
      language: "pt-BR",
      descriptor: { type: "StandaloneArticle" }
    });
    expect(goldenManifestFiles(manifest)).toHaveLength(71);
  });

  it("pins every file by the SHA-256 of the bytes it writes, where the runner reads it", () => {
    const manifest = goldenManifestSchema.parse(built.manifest);
    const pins = new Map(goldenManifestFiles(manifest).map((file) => [file.key, file]));
    for (const file of built.files) {
      const pin = pins.get(file.key)!;
      expect(pin.sha256).toBe(createHash("sha256").update(file.content, "utf8").digest("hex"));
      expect(pin.bytes).toBe(Buffer.byteLength(file.content, "utf8"));
      expect(file.path).toBe(relative(workspace, goldenSourcePath(workspace, pin)));
    }
    expect(new Set(built.files.map((file) => file.sha256)).size).toBe(built.files.length);
  });

  it("writes only the benchmark text: no label, idea or rationale reaches a source file", () => {
    const records = raw.sources.flatMap((source) =>
      "chapters" in source ? source.chapters : [source]
    );
    const byKey = new Map(built.files.map((file) => [file.key, file]));
    for (const record of records) {
      const file = byKey.get(manifestKey(record.key))!;
      expect(file.content).toBe(`${record.content.trim()}\n`);
      for (const idea of record.ideas) expect(file.content).not.toContain(idea);
    }
    for (const { rationale } of raw.expectedRootPairs)
      for (const file of built.files) expect(file.content).not.toContain(rationale);
    expect(JSON.stringify(built.manifest.sources)).not.toMatch(
      /holdout|tuning|expected|forbidden/u
    );
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildMatchingFixture(fixture, { path: fixturePath, text }))).toBe(
      JSON.stringify(built)
    );
    expect(built.mapping.fixture.sha256).toBe(
      createHash("sha256").update(text, "utf8").digest("hex")
    );
  });

  it("lists in the mapping what a held-out run needs: the partition and its tuning partners", () => {
    const mapping = matchingMappingSchema.parse(built.mapping);
    const holdoutKeys = mapping.roots
      .filter((r) => r.partition === "holdout")
      .map((r) => r.manifestKey);
    expect(mapping.subsets.tuning).toHaveLength(40);
    expect(mapping.subsets.tuning.some((key) => holdoutKeys.includes(key))).toBe(false);
    expect(mapping.subsets.holdout).toEqual(expect.arrayContaining(holdoutKeys));
    const partners = new Set(
      [...mapping.expectedRootPairs, ...mapping.forbiddenRootPairs]
        .filter((entry) => entry.partition === "holdout")
        .flatMap((entry) => entry.pair.map(manifestKey))
    );
    expect(new Set(mapping.subsets.holdout)).toEqual(new Set([...holdoutKeys, ...partners]));
    const known = new Set(mapping.roots.map((r) => r.manifestKey));
    for (const key of mapping.subsets.holdout) expect(known.has(key)).toBe(true);
  });
});

describe("a matching fixture that contradicts itself", () => {
  const clone = (): MatchingFixture => structuredClone(fixture);
  const problems = (change: (copy: MatchingFixture) => void): string[] => {
    const copy = clone();
    change(copy);
    return fixtureProblems(copy);
  };

  it("is consistent as committed", () => {
    expect(fixtureProblems(fixture)).toEqual([]);
  });

  it("refuses a pair that names an unknown root, a root twice, or a wrong partition label", () => {
    expect(
      problems((f) =>
        f.expectedRootPairs.push({ pair: ["P01", "ZZ9"], partition: "tuning", rationale: "x" })
      )
    ).toContain("expected pair P01/ZZ9 names an id that is not a root");
    expect(
      problems((f) =>
        f.forbiddenRootPairs.push({ pair: ["P01", "P01"], partition: "tuning", rationale: "x" })
      )
    ).toContain("forbidden pair P01/P01 joins a root to itself");
    expect(
      problems((f) =>
        f.expectedRootPairs.push({ pair: ["P01", "Q5"], partition: "tuning", rationale: "x" })
      )
    ).toContain("expected pair P01/Q5 is labelled tuning but has 1 held-out roots");
    expect(
      problems((f) =>
        f.forbiddenRootPairs.push({ pair: ["P01", "P02"], partition: "tuning", rationale: "x" })
      )
    ).toContain("pair P01/P02 is both expected and forbidden");
  });

  it("refuses repeated ids, ids that collide once lowercased, repeated texts and repeated titles", () => {
    expect(problems((f) => (f.sources[1]!.key = f.sources[0]!.key))).toContain("duplicate id P01");
    expect(problems((f) => (f.sources[1]!.key = "p01"))).toContain(
      "ids collide once lowercased (mf-p01)"
    );
    expect(
      problems((f) => {
        const [a, b] = f.sources.filter((s) => "content" in s);
        if (a && b && "content" in a && "content" in b) b.content = a.content;
      }).some((message) => message.endsWith("repeats the content of another record"))
    ).toBe(true);
    expect(problems((f) => (f.sources[1]!.title = f.sources[2]!.title))).toContain(
      `two roots are titled "${fixture.sources[2]!.title}": the evaluator resolves roots by title`
    );
  });

  it("refuses to build from it", () => {
    const copy = clone();
    copy.zeroNoteSources.push("NOPE");
    expect(() => buildMatchingFixture(copy, { path: fixturePath, text })).toThrow(
      /zero-note source NOPE is not a root/u
    );
    expect(() => parseMatchingFixture({ ...raw, version: "other" })).toThrow();
  });
});
