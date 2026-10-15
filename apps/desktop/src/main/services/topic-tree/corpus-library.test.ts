import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixtureArticles, writeFixtureCorpus } from "./corpus-fixture.js";
import {
  CorpusDataError,
  corpusNotesFile,
  limitArticles,
  loadCorpus,
  parseHoldout,
  planCorpus,
  revisionUrl,
  sectionTitle,
  splitIdea
} from "./corpus-library.js";

describe("pseudo-note text", () => {
  it("splits the first sentence off as the idea, as Spike B did", () => {
    const text =
      "Photosynthesis is a system of biological processes by which organisms convert light energy. The term usually refers to oxygenic photosynthesis, a process that releases oxygen.";
    expect(splitIdea(text)).toEqual({
      idea: "Photosynthesis is a system of biological processes by which organisms convert light energy.",
      body: "The term usually refers to oxygenic photosynthesis, a process that releases oxygen."
    });
    // One sentence only: the whole text is the idea and the body is empty.
    expect(splitIdea("Just one sentence without a follow-up")).toEqual({
      idea: "Just one sentence without a follow-up",
      body: ""
    });
  });

  it("keeps the section name and drops the article title (corpus-notitle)", () => {
    expect(sectionTitle("Photosynthesis — Calvin cycle", "Photosynthesis")).toBe("Calvin cycle");
    // An introduction note's title is the article title itself: it has no section title.
    expect(sectionTitle("Photosynthesis", "Photosynthesis")).toBe("");
  });

  it("names the revision a note was cut from", () => {
    expect(revisionUrl({ lang: "pt", title: "Curva do esquecimento", revisionId: 68615636 })).toBe(
      "https://pt.wikipedia.org/w/index.php?title=Curva_do_esquecimento&oldid=68615636"
    );
  });
});

describe("the corpus on disk", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-corpus-library-"));
    await writeFixtureCorpus(directory);
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("loads articles in manifest order with their notes and the notitle titles", async () => {
    const corpus = await loadCorpus(directory);
    expect(corpus.articles.map((article) => article.key)).toEqual([
      "en:Photosynthesis",
      "pt:Fotossíntese",
      "en:Counterpoint",
      "pt:Contraponto"
    ]);
    expect(corpus.noteCount).toBe(12);
    const first = corpus.articles[0]!;
    expect(first.notes.map((note) => note.title)).toEqual([
      "",
      "Light reactions",
      "Calvin cycle",
      "Evolution"
    ]);
    expect(first.notes[0]!.idea).toMatch(
      /^Photosynthesis has a topic called overview number 0\.$/u
    );
    expect(first.notes[0]!.body).toMatch(/^It is described here/u);
    expect(corpus.license).toBe("CC BY-SA 4.0");
  });

  it("rejects a note outside the manifest, a repeated ID and a count mismatch", async () => {
    const broken = await mkdtemp(join(tmpdir(), "memora-corpus-broken-"));
    try {
      await writeFixtureCorpus(broken);
      const row = (id: string, articleTitle: string) =>
        `${JSON.stringify({ id, lang: "en", domain: "x", articleTitle, title: articleTitle, text: "A sentence that is long enough to be a note." })}\n`;
      await writeFile(join(broken, corpusNotesFile), row("wp-en-1-c000", "Not in the manifest"));
      await expect(loadCorpus(broken)).rejects.toThrow(/is not in the manifest/u);
      await writeFile(
        join(broken, corpusNotesFile),
        row("wp-en-24544-c000", "Photosynthesis") + row("wp-en-24544-c000", "Photosynthesis")
      );
      await expect(loadCorpus(broken)).rejects.toThrow(/appears twice/u);
      await writeFile(join(broken, corpusNotesFile), row("wp-en-24544-c000", "Photosynthesis"));
      await expect(loadCorpus(broken)).rejects.toThrow(/has 1 notes, the manifest says 4/u);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  it("reports a missing corpus folder plainly", async () => {
    await expect(loadCorpus(join(directory, "nowhere"))).rejects.toBeInstanceOf(CorpusDataError);
  });

  it("picks a seeded subset in manifest order", async () => {
    const { articles } = await loadCorpus(directory);
    const first = limitArticles(articles, 2, 20261014);
    expect(first).toHaveLength(2);
    expect(limitArticles(articles, 2, 20261014).map((a) => a.key)).toEqual(first.map((a) => a.key));
    const order = articles.map((article) => article.key);
    expect(first.map((a) => order.indexOf(a.key))).toEqual(
      [...first.map((a) => order.indexOf(a.key))].sort((a, b) => a - b)
    );
    expect(limitArticles(articles, 99, 1)).toHaveLength(articles.length);
  });
});

describe("the holdout", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-corpus-holdout-"));
    await writeFixtureCorpus(directory);
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("parses the three forms and refuses the rest", () => {
    expect(parseHoldout("articles:40", directory)).toEqual({ mode: "articles", count: 40 });
    expect(parseHoldout("share:0.2", directory)).toEqual({ mode: "share", share: 0.2 });
    expect(parseHoldout("file:twins.json", directory)).toEqual({
      mode: "file",
      path: join(directory, "twins.json")
    });
    for (const bad of ["articles:0", "articles:1.5", "share:1", "share:0", "file:", "all", ""])
      expect(() => parseHoldout(bad, directory)).toThrow(CorpusDataError);
  });

  it("holds out whole articles by seed and keeps the rest as the base", async () => {
    const { articles } = await loadCorpus(directory);
    const plan = await planCorpus(articles, { mode: "articles", count: 2 }, 20261014);
    expect(plan.held).toHaveLength(2);
    expect(plan.base).toHaveLength(2);
    expect(new Set([...plan.base, ...plan.held].map((a) => a.key)).size).toBe(4);
    // The same seed gives the same holdout and arrival order; another seed may differ.
    const again = await planCorpus(articles, { mode: "articles", count: 2 }, 20261014);
    expect(again.held.map((a) => a.key)).toEqual(plan.held.map((a) => a.key));
    // The base stays in manifest order.
    const order = articles.map((article) => article.key);
    expect(plan.base.map((a) => order.indexOf(a.key))).toEqual(
      [...plan.base.map((a) => order.indexOf(a.key))].sort((a, b) => a - b)
    );
  });

  it("holds out a share of the notes, and takes an explicit list in file order", async () => {
    const { articles } = await loadCorpus(directory);
    const share = await planCorpus(articles, { mode: "share", share: 0.3 }, 7);
    const heldNotes = share.held.reduce((total, a) => total + a.notes.length, 0);
    expect(heldNotes).toBeGreaterThanOrEqual(0.3 * 12);
    expect(heldNotes - share.held.at(-1)!.notes.length).toBeLessThan(0.3 * 12);

    const file = join(directory, "twins.json");
    await writeFile(file, JSON.stringify(["pt:Contraponto", "en:Photosynthesis"]));
    const listed = await planCorpus(articles, { mode: "file", path: file }, 1);
    expect(listed.held.map((a) => a.key)).toEqual(["pt:Contraponto", "en:Photosynthesis"]);
    expect(listed.base.map((a) => a.key)).toEqual(["pt:Fotossíntese", "en:Counterpoint"]);

    await writeFile(file, JSON.stringify(["en:Unknown"]));
    await expect(planCorpus(articles, { mode: "file", path: file }, 1)).rejects.toThrow(
      /not seeded/u
    );
    await writeFile(file, JSON.stringify(["pt:Contraponto", "pt:Contraponto"]));
    await expect(planCorpus(articles, { mode: "file", path: file }, 1)).rejects.toThrow(/twice/u);
    await writeFile(file, JSON.stringify(articles.map((a) => a.key)));
    await expect(planCorpus(articles, { mode: "file", path: file }, 1)).rejects.toThrow(
      /no article in the base/u
    );
  });

  it("has no holdout by default", async () => {
    const { articles } = await loadCorpus(directory);
    const plan = await planCorpus(articles, null, 1);
    expect(plan.held).toEqual([]);
    expect(plan.base).toHaveLength(fixtureArticles.length);
  });
});
