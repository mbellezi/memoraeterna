import { describe, expect, it } from "vitest";

import { sealedSchema, writeTypes, type LabelSet } from "./common.ts";
import {
  displayLanguage,
  excerptWindow,
  itemBlock,
  itemsPerPage,
  judgePrompt,
  maxItemsPerJudge,
  pageLeaks,
  plainText,
  renderPass,
  spikeBody
} from "./render.ts";
import { sampleLabelSet } from "./sample.ts";
import { testRenderSources, testWorld } from "./test-world.ts";

function rendered(passName = "panel") {
  const world = testWorld();
  const set = { ...sampleLabelSet(world.input), pass: passName };
  return {
    world,
    set,
    pass: renderPass(set, testRenderSources(world, set), {
      labelSetSha256: "x",
      directory: ".cache/f3/labels"
    })
  };
}

describe("the judge pages", () => {
  it("are the same for the same label set and seed", () => {
    expect(JSON.stringify(rendered().pass)).toBe(JSON.stringify(rendered().pass));
  });

  it("hold 20 items each, numbered by page and slot, every item once", () => {
    const { set, pass } = rendered();
    expect(pass.pages).toHaveLength(Math.ceil(set.items.length / itemsPerPage));
    expect(pass.pages.slice(0, -1).every((page) => page.items === itemsPerPage)).toBe(true);
    const ids = pass.sealed.items.map((item) => item.itemId);
    expect(new Set(ids).size).toBe(set.items.length);
    for (const item of pass.sealed.items) {
      const page = pass.pages[item.page - 1]!;
      expect(page.text).toContain(`### ${item.itemId} · `);
    }
    expect(new Set(pass.sealed.items.map((item) => item.pairId))).toEqual(
      new Set(set.items.map((item) => item.pairId))
    );
    expect(sealedSchema.parse(pass.sealed)).toBeTruthy();
  });

  it("show no score, model, dataset, set or stratum name, and no id but the page position", () => {
    const { set, pass } = rendered();
    const text = pass.pages.map((page) => page.text).join("\n");
    for (const item of set.items) {
      expect(text).not.toContain(item.lo);
      expect(text).not.toContain(item.hi);
      expect(text).not.toContain(item.pairId);
      if (item.score !== null) {
        expect(text).not.toContain(String(item.score));
        expect(text).not.toContain(item.score.toFixed(2));
      }
    }
    for (const word of [
      /fixture/iu,
      /golden/iu,
      /corpus/iu,
      /\bpool/iu,
      /strat/iu,
      /mlx/iu,
      /gguf/iu,
      /qwen/iu,
      /rerank/iu,
      /spike/iu,
      /\bscore/iu,
      /log-?odds/iu,
      /held-?out/iu,
      /tuning/iu,
      /rv[69]|r_v[69]/iu,
      /env-[a-z]/iu,
      /split/iu,
      /\bfit\b/iu
    ])
      expect(text).not.toMatch(word);
    expect(
      pageLeaks(judgePrompt({ directory: ".cache/f3/labels", pages: 3, items: 50 }), [])
    ).toEqual([]);
  });

  it("refuse a template word that the content does not account for, and allow it inside a note", () => {
    expect(pageLeaks("Title: the score of a symphony", ["the score of a symphony"])).toEqual([]);
    expect(pageLeaks("pool A · Title: a note", ["a note"])).toEqual(["pool"]);
    expect(pageLeaks("id 6f1c3a52-1111-4222-8333-944445555666", [])).toHaveLength(1);
  });

  it("show the sealed A side first, in a seeded A/B order that varies across items", () => {
    const { world, pass } = rendered();
    const sources = testRenderSources(world, sampleLabelSet(world.input));
    let flipped = 0;
    for (const item of pass.sealed.items.filter((candidate) => candidate.kind === "note")) {
      const page = pass.pages[item.page - 1]!.text;
      const block = page.slice(page.indexOf(`### ${item.itemId} · `)).split("\n\n### ")[0]!;
      const aId = item.shownA === "lo" ? item.lo : item.hi;
      const bId = item.shownA === "lo" ? item.hi : item.lo;
      const title = (id: string) => sources.texts[item.library]!.get(id)!.title;
      expect(block.indexOf(`Title: ${title(aId)}`)).toBeLessThan(
        block.indexOf(`Title: ${title(bId)}`)
      );
      if (item.shownA === "hi") flipped += 1;
    }
    expect(flipped).toBeGreaterThan(0);
    expect(flipped).toBeLessThan(pass.sealed.items.filter((item) => item.kind === "note").length);
  });

  it("hash what the judges saw independently of page position and A/B order", () => {
    const first = rendered().pass.sealed.items;
    // Another pass name draws another page order and A/B order over the same items.
    const other = rendered("reordered").pass.sealed.items;
    const byPair = new Map(other.map((item) => [item.pairId, item]));
    expect(first.some((item) => byPair.get(item.pairId)!.itemId !== item.itemId)).toBe(true);
    expect(first.some((item) => byPair.get(item.pairId)!.shownA !== item.shownA)).toBe(true);
    for (const item of first)
      expect(byPair.get(item.pairId)!.contentSha256).toBe(item.contentSha256);
  });

  it("keep each judge's load at most 600 items", () => {
    const { world, set } = rendered();
    const big: LabelSet = {
      ...set,
      items: Array.from({ length: maxItemsPerJudge + 1 }, (_, index) => ({
        ...set.items[0]!,
        pairId: `p${index}`
      }))
    };
    expect(() =>
      renderPass(big, testRenderSources(world, set), { labelSetSha256: "x", directory: "d" })
    ).toThrow(/600-item load/u);
  });

  it("render a note side with the source and language, and a source side with its excerpts", () => {
    const block = itemBlock(
      "001-01",
      {
        kind: "source",
        language: "pt",
        title: "Livro",
        overview: "Resumo.",
        excerpts: ["Um.", "Dois."]
      },
      { kind: "source", language: "en", title: "Book", overview: "Summary.", excerpts: ["One."] }
    );
    expect(block).toBe(
      [
        "### 001-01 · two sources",
        "",
        "**A** · pt · Livro",
        "Overview: Resumo.",
        "Excerpt 1: Um.",
        "Excerpt 2: Dois.",
        "",
        "**B** · en · Book",
        "Overview: Summary.",
        "Excerpt 1: One."
      ].join("\n")
    );
    expect(displayLanguage("pt-BR")).toBe("pt");
    expect(spikeBody("Title: T\nIdea: I\nText: The body.")).toBe("The body.");
  });

  it("show Markdown links as their text and drop images and bare URLs", () => {
    expect(
      plainText(
        'See ![](https://x.org/a.png) [active recall](https://en.example.org/wiki/Active_recall "Active recall") and [Cell](https://e.org/Cell_(biology)) at https://e.org/x now.'
      )
    ).toBe("See active recall and Cell at now.");
  });

  it("cut an excerpt around the closest note, at a word start", () => {
    const text = `${"alpha ".repeat(150)}target words here ${"omega ".repeat(150)}`;
    const focus = text.indexOf("target");
    const window = excerptWindow({ text, focus }, 100);
    expect(window.startsWith("…target words here")).toBe(true);
    expect(excerptWindow({ text: "short text", focus: null }, 100)).toBe("short text");
  });
});

describe("the judge prompt", () => {
  it("asks the three questions with the write vocabulary and the answer format the tally reads", () => {
    const prompt = judgePrompt({ directory: ".cache/f3/labels", pages: 23, items: 460 });
    for (const type of writeTypes) expect(prompt).toContain(`**${type}**`);
    expect(prompt).toContain(
      '{"id": "001-02", "related": "yes", "type": "extends", "direction": "B->A"}'
    );
    expect(prompt).toContain(".cache/f3/labels/answers/<judge>.json");
    expect(prompt).toContain("page-023.md");
    expect(prompt).toContain("460 items");
  });
});
