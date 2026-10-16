import { describe, expect, it } from "vitest";

import { defaultTopicTreeConfig } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import { namingWorld } from "./fixtures/naming-world.js";
import type { WorldNote } from "./fixtures/naming-world.js";
import { uuidOf } from "./fixtures/placement-world.js";
import {
  centralItems,
  cleanNameText,
  clipIdea,
  describeRejections,
  isIdentifierShaped,
  membershipChange,
  membershipDrift,
  membershipSketch,
  membershipSketchSize,
  namingCallTopics,
  namingCandidates,
  namingPromptGroups,
  packNamingCalls,
  parseModelJson,
  retryCall,
  statesContentLanguage,
  validateNamingOutput
} from "./naming.js";
import type { NamingCall, NamingMember, UnaliasedTopic } from "./naming.js";
import { itemKey } from "./ids.js";
import { createTopicTreeState, getTopic, placementRecord, registerItem } from "./state.js";

const config = defaultTopicTreeConfig;
const context = { contentLanguage: "pt-BR", config: config.naming };

const note = (text: string, vector: [number, number, number] = [1, 0, 0]): WorldNote => ({
  text,
  language: "pt-BR",
  vector
});

describe("which topics are named", () => {
  function tree() {
    return namingWorld([
      { id: 1, parent: 0, fields: { nameState: "unnamed" }, notes: [note("A")] },
      {
        id: 2,
        parent: 0,
        fields: { title: "Rascunho", nameState: "provisional", nameSource: "tfidf" },
        notes: [note("B")]
      },
      {
        id: 3,
        parent: 0,
        fields: { title: "Astronomia", nameState: "named", nameSource: "llm" },
        notes: [note("C")]
      },
      {
        id: 4,
        parent: 0,
        fields: { title: "Meu nome", nameState: "named", nameSource: "human", management: "human" },
        notes: [note("D")]
      },
      {
        id: 5,
        parent: 0,
        fields: { nameState: "unnamed", management: "pinned" },
        notes: [note("E")]
      },
      { id: 6, parent: 1, fields: { nameState: "unnamed" }, notes: [note("F")] }
    ]);
  }

  it("names unnamed and provisional AI topics, shallow first", () => {
    const world = tree();
    const found = namingCandidates(world.state, config);
    expect(
      found.map((candidate) => [candidate.topicId, candidate.reason, candidate.depth])
    ).toEqual(
      [
        [world.topic(1), "unnamed", 1],
        [world.topic(2), "provisional", 1],
        [world.topic(6), "unnamed", 2]
      ].sort(
        (a, b) => (a[2] as number) - (b[2] as number) || String(a[0]).localeCompare(String(b[0]))
      )
    );
    // Human-named, human-managed and pinned topics are never candidates, however they are named.
    expect(found.map((candidate) => candidate.topicId)).not.toContain(world.topic(4));
    expect(found.map((candidate) => candidate.topicId)).not.toContain(world.topic(5));
  });

  it("names an LLM-named topic again only once its members drifted far enough", () => {
    const world = tree();
    const named = world.topic(3);
    expect(
      namingCandidates(world.state, config, { drift: () => 0.29 }).map((c) => c.topicId)
    ).not.toContain(named);
    const found = namingCandidates(world.state, config, {
      drift: (id) => (id === named ? config.naming.renameDrift : null)
    });
    expect(found.find((candidate) => candidate.topicId === named)?.reason).toBe("drift");
    // No known drift means no rename.
    expect(namingCandidates(world.state, config).map((c) => c.topicId)).not.toContain(named);
  });

  it("leaves out retired topics and the ones asked to skip", () => {
    const world = namingWorld([
      { id: 1, parent: 0, fields: { nameState: "unnamed" }, notes: [note("A")] },
      { id: 2, parent: 0, fields: { nameState: "unnamed" } },
      { id: 3, parent: 0, fields: { nameState: "unnamed" }, notes: [note("B")] }
    ]);
    const editor = createTopicTreeEditor(world.state, { record: false });
    editor.retireTopic(world.topic(2), null, "2026-10-15T00:00:00.000Z");
    const found = namingCandidates(world.state, config, { skip: new Set([world.topic(3)]) });
    expect(found.map((candidate) => candidate.topicId)).toEqual([world.topic(1)]);
  });

  it("orders by content, not by ID", () => {
    const a = tree();
    const b = namingWorld(
      [
        { id: 1, parent: 0, fields: { nameState: "unnamed" }, notes: [note("A")] },
        { id: 2, parent: 0, fields: { nameState: "unnamed" }, notes: [note("B")] },
        { id: 3, parent: 0, fields: { nameState: "unnamed" }, notes: [note("C")] }
      ],
      7000
    );
    const c = namingWorld(
      [
        { id: 1, parent: 0, fields: { nameState: "unnamed" }, notes: [note("A")] },
        { id: 2, parent: 0, fields: { nameState: "unnamed" }, notes: [note("B")] },
        { id: 3, parent: 0, fields: { nameState: "unnamed" }, notes: [note("C")] }
      ],
      0
    );
    expect(namingCandidates(b.state, config).map((x) => x.orderKey)).toEqual(
      namingCandidates(c.state, config).map((x) => x.orderKey)
    );
    expect(a.state.topics.size).toBeGreaterThan(0);
  });
});

describe("membership drift", () => {
  function world(count: number, from = 0) {
    const notes = Array.from({ length: count }, (_, index) => note(`item ${from + index}`));
    return namingWorld([{ id: 1, parent: 0, notes }]);
  }

  it("is exact while the topic is smaller than the sketch", () => {
    const base = membershipSketch(world(20).state, world(20).topic(1));
    expect(membershipDrift(base, base)).toBe(0);
    // 20 items of which 10 are shared with 20 other items: Jaccard 10 / 30.
    const other = membershipSketch(world(20, 10).state, world(20, 10).topic(1));
    expect(membershipDrift(base, other)).toBeCloseTo(1 - 10 / 30, 12);
    const disjoint = membershipSketch(world(20, 100).state, world(20, 100).topic(1));
    expect(membershipDrift(base, disjoint)).toBe(1);
  });

  it("estimates the drift of a large topic within the sketch's error", () => {
    const a = world(600);
    const b = world(600, 200);
    const then = membershipSketch(a.state, a.topic(1));
    const now = membershipSketch(b.state, b.topic(1));
    expect(then.hashes).toHaveLength(membershipSketchSize);
    expect(then.n).toBe(600);
    // 400 shared of 800 distinct: a drift of 0.5.
    expect(membershipDrift(then, now)).toBeGreaterThan(0.3);
    expect(membershipDrift(then, now)).toBeLessThan(0.7);
    expect(membershipDrift(then, then)).toBe(0);
  });

  it("measures a rebuild's change as a share of the members the topic was named for", () => {
    const of = (count: number, from = 0) => {
      const built = world(count, from);
      return membershipSketch(built.state, built.topic(1));
    };
    // 21 members that gain 7 (O Alienista + The Gift of the Magi): drift 1/4, change 1/3.
    expect(membershipDrift(of(21), of(28))).toBeCloseTo(0.25, 12);
    expect(membershipChange(of(21), of(28))).toBeCloseTo(1 / 3, 12);
    // 11 that gain 9 (A Cartomante + The Tell-Tale Heart): 9/11.
    expect(membershipChange(of(11), of(20))).toBeCloseTo(9 / 11, 12);
    // Losing half, or gaining a tenth.
    expect(membershipChange(of(20), of(10))).toBeCloseTo(0.5, 12);
    expect(membershipChange(of(20), of(22))).toBeCloseTo(0.1, 12);
    expect(membershipChange(of(20), of(20))).toBe(0);
    // Bounded by 1: a topic that tripled, or one replaced entirely.
    expect(membershipChange(of(10), of(30))).toBe(1);
    expect(membershipChange(of(10), of(10, 100))).toBe(1);
    expect(membershipChange({ n: 0, hashes: [] }, { n: 0, hashes: [] })).toBe(0);
    expect(membershipChange({ n: 0, hashes: [] }, of(3))).toBe(1);
    // Large topics: within the sketch's error.
    const change = membershipChange(of(600), of(700));
    expect(change).toBeGreaterThan(0.05);
    expect(change).toBeLessThan(0.35);
  });

  it("treats two empty topics as unchanged and an empty one against a full one as changed", () => {
    expect(membershipDrift({ n: 0, hashes: [] }, { n: 0, hashes: [] })).toBe(0);
    const full = membershipSketch(world(5).state, world(5).topic(1));
    expect(membershipDrift({ n: 0, hashes: [] }, full)).toBe(1);
  });

  it("depends on content hashes, not on IDs", () => {
    const first = namingWorld([{ id: 1, parent: 0, notes: [note("x"), note("y"), note("z")] }]);
    const second = namingWorld(
      [{ id: 1, parent: 0, notes: [note("x"), note("y"), note("z")] }],
      90
    );
    expect(membershipSketch(first.state, first.topic(1))).toEqual(
      membershipSketch(second.state, second.topic(1))
    );
  });
});

describe("central members", () => {
  it("ranks notes by cosine to the centroid, ties by content key, and fills with sources last", () => {
    const world = namingWorld([
      {
        id: 1,
        parent: 0,
        notes: [
          note("near", [1, 0.05, 0]),
          note("nearest", [1, 0, 0]),
          note("far", [0.4, 1, 0]),
          { text: "A source title", language: "pt-BR", vector: [1, 0, 0], kind: "source" }
        ]
      }
    ]);
    const central = centralItems(world.state, world.vectors, world.topic(1), 3);
    // The centroid leans toward the third note, so the slightly tilted note is the central one.
    expect(central.map((item) => world.texts.get(item.key)?.text)).toEqual([
      "near",
      "nearest",
      "far"
    ]);
    expect(central[0]!.cosine).toBeGreaterThan(central[1]!.cosine);
    expect(central[1]!.cosine).toBeGreaterThan(central[2]!.cosine);
    const filled = centralItems(world.state, world.vectors, world.topic(1), 4);
    expect(filled.at(-1)?.kind).toBe("source");
    for (const item of central) expect(item.cosine).toBeGreaterThan(0);
  });

  it("leaves out items with no current vector", () => {
    const world = namingWorld([{ id: 1, parent: 0, notes: [note("a"), note("b")] }]);
    const stranger = itemKey("note", uuidOf(9999));
    registerItem(world.state, {
      key: stranger,
      kind: "note",
      contentHash: "f".repeat(64),
      rootSource: null
    });
    createTopicTreeEditor(world.state, { record: false }).placeItem(
      stranger,
      placementRecord(world.topic(1))
    );
    const central = centralItems(world.state, world.vectors, world.topic(1), 5);
    expect(central.map((item) => item.key)).not.toContain(stranger);
    expect(central).toHaveLength(2);
  });
});

function member(title: string): NamingMember {
  return {
    key: itemKey("note", uuidOf(Math.abs(hash(title)) % 100000)),
    kind: "note",
    title,
    idea: `${title} idea`,
    rootSource: null
  };
}
function hash(text: string): number {
  let value = 7;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) | 0;
  return value;
}
function unaliased(id: number, title: string, currentTitle: string | null = null): UnaliasedTopic {
  return { topicId: uuidOf(id), members: [member(title)], currentTitle };
}
function group(
  parent: number,
  parentTitle: string | null,
  topics: UnaliasedTopic[],
  namedSiblings: string[] = []
) {
  return { parentId: uuidOf(parent), parentTitle, namedSiblings, topics };
}

describe("the batches of a naming call", () => {
  it("packs whole groups into calls of at most maxTopics and numbers aliases across a call", () => {
    const groups = [
      group(100, "Mente", [unaliased(1, "a"), unaliased(2, "b"), unaliased(3, "c")]),
      group(101, null, [unaliased(4, "d"), unaliased(5, "e")]),
      group(102, "Mar", [unaliased(6, "f"), unaliased(7, "g"), unaliased(8, "h")])
    ];
    const calls = packNamingCalls(groups, 5);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => namingCallTopics(call).length)).toEqual([5, 3]);
    expect(namingCallTopics(calls[0]!).map((topic) => topic.alias)).toEqual([
      "T1",
      "T2",
      "T3",
      "T4",
      "T5"
    ]);
    expect(namingCallTopics(calls[1]!).map((topic) => topic.alias)).toEqual(["T1", "T2", "T3"]);
    // A group stays whole within a call when it fits.
    expect(calls[0]!.groups.map((g) => g.topics.length)).toEqual([3, 2]);
  });

  it("splits a group that alone exceeds a call", () => {
    const topics = Array.from({ length: 7 }, (_, index) => unaliased(index + 1, `t${index}`));
    const calls = packNamingCalls([group(100, "Mente", topics)], 3);
    expect(calls.map((call) => namingCallTopics(call).length)).toEqual([3, 3, 1]);
    expect(calls.every((call) => call.groups.every((g) => g.parentTitle === "Mente"))).toBe(true);
  });

  it("shows the model no IDs: the same content with other IDs is the same prompt data", () => {
    const first = packNamingCalls(
      [group(100, "Mente", [unaliased(1, "a", "Antigo"), unaliased(2, "b")], ["Mar"])],
      24
    )[0]!;
    const second = packNamingCalls(
      [
        {
          parentId: uuidOf(555),
          parentTitle: "Mente",
          namedSiblings: ["Mar"],
          topics: [
            { ...unaliased(77, "a", "Antigo"), topicId: uuidOf(77) },
            { ...unaliased(78, "b"), topicId: uuidOf(78) }
          ]
        }
      ],
      24
    )[0]!;
    const shown = JSON.stringify(namingPromptGroups(first));
    expect(shown).toBe(JSON.stringify(namingPromptGroups(second)));
    expect(shown).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/u);
    expect(JSON.parse(shown)).toEqual([
      {
        parent: "Mente",
        named_siblings: ["Mar"],
        topics: [
          { alias: "T1", current_title: "Antigo", notes: [{ title: "a", idea: "a idea" }] },
          { alias: "T2", notes: [{ title: "b", idea: "b idea" }] }
        ]
      }
    ]);
  });

  it("cuts an idea at the limit with an ellipsis and leaves a short one alone", () => {
    expect(clipIdea("  short   text ", 200)).toBe("short text");
    const long = "palavra ".repeat(60);
    const clipped = clipIdea(long, 200);
    expect(Array.from(clipped)).toHaveLength(200);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

function call(): NamingCall {
  return packNamingCalls(
    [
      group(100, "Mente", [unaliased(1, "a"), unaliased(2, "b"), unaliased(3, "c")], ["Memória"]),
      group(101, null, [unaliased(4, "d")], ["Física"])
    ],
    24
  )[0]!;
}
const item = (alias: string, title: string, extra: Record<string, unknown> = {}) => ({
  alias,
  title,
  description: "Uma frase curta sobre o assunto do tópico e das suas notas.",
  aliases: [],
  language: "pt-BR",
  ...extra
});

describe("validating the model's answer", () => {
  it("accepts valid names, keeps the content language and cleans titles and aliases", () => {
    const result = validateNamingOutput(
      {
        topics: [
          item("T1", '  "Atenção seletiva". ', {
            aliases: ["Foco", "foco", "T9", "Atenção seletiva"]
          }),
          item("T2", "Sono e descanso", { language: "pt" }),
          item("T3", "Emoções"),
          item("T4", "Cosmologia", {
            aliases: ["Universo", "Big Bang", "Estrelas", "Galáxias", "Luz", "Tempo"]
          })
        ]
      },
      call(),
      context
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((name) => [name.alias, name.title])).toEqual([
      ["T1", "Atenção seletiva"],
      ["T2", "Sono e descanso"],
      ["T3", "Emoções"],
      ["T4", "Cosmologia"]
    ]);
    expect(result.accepted[0]!.aliases).toEqual(["Foco"]);
    expect(result.accepted[3]!.aliases).toHaveLength(config.naming.maxAliases);
    // The stored language is the library's content language, whatever code the model wrote.
    expect(result.accepted.every((name) => name.language === "pt-BR")).toBe(true);
  });

  it("rejects a name in another language and asks again, keeping the valid ones", () => {
    const result = validateNamingOutput(
      {
        topics: [
          item("T1", "Selective attention", { language: "en" }),
          item("T2", "Sono e descanso"),
          item("T3", "Emoções"),
          item("T4", "Cosmologia")
        ]
      },
      call(),
      context
    );
    expect(result.rejected).toEqual([
      { topicId: uuidOf(1), alias: "T1", reason: "language_mismatch", title: "Selective attention" }
    ]);
    expect(result.accepted).toHaveLength(3);
    const again = retryCall(call(), result)!;
    expect(namingCallTopics(again).map((topic) => topic.alias)).toEqual(["T1"]);
    // The sibling titles accepted for the same parent are now taken for the retry.
    expect(again.groups[0]!.namedSiblings).toEqual(["Memória", "Sono e descanso", "Emoções"]);
  });

  it("catches a model that states the right language but writes the wrong one", () => {
    const english = validateNamingOutput(
      {
        topics: [
          item("T1", "Selective attention", {
            description:
              "A short sentence about the subject of the topic and its notes, with the many things they say."
          })
        ]
      },
      call(),
      context
    );
    expect(english.rejected.map((r) => r.reason)).toContain("language_heuristic");
    const title = validateNamingOutput({ topics: [item("T1", "Theory of mind")] }, call(), context);
    expect(title.rejected.find((r) => r.alias === "T1")?.reason).toBe("language_heuristic");
    // A loanword or a proper name with no stopword of another language is fine.
    const loan = validateNamingOutput(
      { topics: [item("T1", "Machine learning")] },
      call(),
      context
    );
    expect(loan.accepted.map((name) => name.title)).toContain("Machine learning");
  });

  it("rejects names that repeat the parent or a sibling, accent- and case-insensitively", () => {
    const result = validateNamingOutput(
      {
        topics: [item("T1", "MENTE"), item("T2", "memoria"), item("T3", "Sono"), item("T4", "sono")]
      },
      call(),
      context
    );
    const reasons = Object.fromEntries(result.rejected.map((r) => [r.alias, r.reason]));
    expect(reasons.T1).toBe("same_as_parent");
    expect(reasons.T2).toBe("duplicate_sibling");
    // T3 and T4 have different parents, so the same title is fine for both.
    expect(result.accepted.map((name) => name.alias)).toEqual(["T3", "T4"]);
  });

  it("lets the first of two siblings keep a title both proposed", () => {
    const result = validateNamingOutput(
      { topics: [item("T1", "Sono"), item("T2", "SONO"), item("T3", "Emoções")] },
      call(),
      context
    );
    expect(result.accepted.map((name) => name.alias)).toEqual(["T1", "T3"]);
    expect(result.rejected.map((r) => [r.alias, r.reason])).toEqual([
      ["T2", "duplicate_sibling"],
      ["T4", "missing"]
    ]);
  });

  it("rejects identifier-shaped, generic and malformed answers", () => {
    const result = validateNamingOutput(
      {
        topics: [
          item("T1", "T3"),
          item("T2", "123e4567-e89b-12d3-a456-426614174000"),
          item("T3", "Diversos"),
          { alias: "T4", title: "Fenômenos", language: "pt-BR" }
        ]
      },
      call(),
      context
    );
    const reasons = Object.fromEntries(result.rejected.map((r) => [r.alias, r.reason]));
    expect(reasons).toEqual({
      T1: "title_identifier",
      T2: "title_identifier",
      T3: "title_generic",
      T4: "malformed"
    });
  });

  it("rejects an alias answered twice and one nobody answered, and ignores strangers", () => {
    const result = validateNamingOutput(
      {
        topics: [
          item("T1", "Sono"),
          item("T1", "Descanso"),
          item("T9", "Fora"),
          item("T3", "Emoções")
        ]
      },
      call(),
      context
    );
    const reasons = Object.fromEntries(result.rejected.map((r) => [r.alias, r.reason]));
    expect(reasons).toEqual({ T1: "duplicate_answer", T2: "missing", T4: "missing" });
    expect(result.accepted.map((name) => name.alias)).toEqual(["T3"]);
  });

  it("rejects overlong titles and descriptions and empty descriptions", () => {
    const result = validateNamingOutput(
      {
        topics: [
          item("T1", "x".repeat(config.naming.titleMaxChars + 1)),
          item("T2", "Sono", { description: "y".repeat(config.naming.descriptionMaxChars + 1) }),
          item("T3", "Emoções", { description: "  " }),
          item("T4", "Cosmologia")
        ]
      },
      call(),
      context
    );
    const reasons = Object.fromEntries(result.rejected.map((r) => [r.alias, r.reason]));
    expect(reasons).toEqual({
      T1: "title_length",
      T2: "description_length",
      T3: "description_missing"
    });
  });

  it("reads a JSON string with a code fence, and treats anything else as malformed", () => {
    const text = `\`\`\`json\n${JSON.stringify({ topics: [item("T1", "Sono")] })}\n\`\`\``;
    expect(validateNamingOutput(text, call(), context).accepted).toHaveLength(1);
    expect(parseModelJson('Here you go: {"topics": []} done')).toEqual({ topics: [] });
    expect(parseModelJson("not json")).toBeNull();
    const broken = validateNamingOutput("{", call(), context);
    expect(broken.accepted).toEqual([]);
    expect(broken.rejected.map((r) => r.reason)).toEqual([
      "malformed",
      "malformed",
      "malformed",
      "malformed"
    ]);
  });

  it("accepts a language name where a code was asked", () => {
    expect(statesContentLanguage("Português", "pt-BR")).toBe(true);
    expect(statesContentLanguage("Portuguese", "pt-BR")).toBe(true);
    expect(statesContentLanguage("pt-PT", "pt-BR")).toBe(true);
    expect(statesContentLanguage("English", "pt-BR")).toBe(false);
    expect(statesContentLanguage("", "pt-BR")).toBe(false);
  });

  it("describes each rejection for the repair prompt, in call order", () => {
    const result = validateNamingOutput(
      { topics: [item("T2", "memoria"), item("T1", "Mente")] },
      call(),
      context
    );
    const lines = describeRejections(result.rejected, call(), "Brazilian Portuguese").split("\n");
    expect(lines[0]).toBe('T1: the title "Mente" repeats the parent title "Mente"');
    expect(lines[1]).toBe('T2: the title "memoria" is already used by a sibling topic');
    expect(lines).toHaveLength(4);
  });

  it("retries nothing when everything was accepted", () => {
    const result = validateNamingOutput(
      {
        topics: [
          item("T1", "Sono"),
          item("T2", "Emoções"),
          item("T3", "Percepção"),
          item("T4", "Cosmologia")
        ]
      },
      call(),
      context
    );
    expect(result.rejected).toEqual([]);
    expect(retryCall(call(), result)).toBeNull();
  });
});

describe("name text helpers", () => {
  it("cleans a title the way a reader would write it", () => {
    expect(cleanNameText("  **Atenção   seletiva**.\n")).toBe("Atenção seletiva");
    expect(cleanNameText("Título: “Sono”")).toBe("Sono");
    expect(cleanNameText("Title: Memory")).toBe("Memory");
  });

  it("recognizes identifiers, aliases and placeholders", () => {
    for (const text of [
      "T12",
      "topic 4",
      "Tópico 7",
      "cluster-3",
      "4f9a1c2e7b",
      "2026-10-15",
      "123e4567-e89b-12d3-a456-426614174000",
      "note:123e4567-e89b-12d3-a456-426614174000"
    ]) {
      expect(isIdentifierShaped(text), text).toBe(true);
    }
    for (const text of ["Atenção seletiva", "COVID-19 e saúde", "Século XX", "Python 3"]) {
      expect(isIdentifierShaped(text), text).toBe(false);
    }
  });

  it("keeps the root and retired nodes out of the tree used by the helpers", () => {
    const state = createTopicTreeState({ dim: 3, rootId: uuidOf(0) });
    expect(namingCandidates(state, config)).toEqual([]);
    expect(getTopic(state, uuidOf(0)).role).toBe("root");
  });
});
