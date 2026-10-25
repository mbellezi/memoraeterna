import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  AtomicNoteGenerationOutputSchema,
  KnowledgeGraphGenerationOutputSchema,
  TopicOverviewOutputSchema,
  TopicOverviewPatchOutputSchema,
  analyzeStrictJsonSchema,
  grammarSchemaMaxCharacters,
  maxIdentityGroupRows,
  outputSchemaForContract,
  relationTypingCallSchema,
  relationTypingOutputSchema,
  toGrammarJsonSchema
} from "@app/domain";
import type { z } from "zod";

import {
  relationMatchCallSchema,
  relationMatchOutputSchema,
  type RelationMatchRow
} from "./relation-type-resolution.js";
import {
  topicAreasOutputContract,
  topicNamingOutputContract,
  topicOverviewOutputContract,
  topicOverviewPatchOutputContract
} from "./topic-tree/topic-prompts.js";

/**
 * The structured-output catalog (F3 D35): every contract a model answers, with whether it can be sent
 * as a strict output schema and, if not, why. A contract that is not strict-compatible keeps its
 * prompt-level JSON and is validated by Zod all the same; a contract is added here when a caller
 * starts to state an `outputContract`, and a change to a contract that flips its outcome shows up
 * in this table. The AI service sends a remote adapter the strict schema of a contract that has one
 * (F4 D23), or of the strict terms its caller states beside it (naming and notes, owner 10-25,
 * `strict-output-callers.test.ts`); the others stay prompt-level there. Every contract here reaches
 * a local runtime as its own grammar (T99), strict terms or not.
 *
 * Why most of today's contracts are not strict: they were written for validation, not for a wire
 * format. Their optional members (`language`, `description`, canonical IDs) are the common cause;
 * the knowledge-graph contract also drops `claims` in a preprocessing step and checks its references
 * with a refinement; the confirmation answer is a tuple list; the naming answer has an optional
 * `aliases` member. The typing contract of T51t is designed strict from the start (keyed objects,
 * enums, every member required), and the overview and the Areas grouping happen to qualify.
 */
const catalog: Array<{
  id: string;
  prompts: string;
  contract: z.ZodType;
  /** `strict`, or the reasons the contract cannot be sent strictly. */
  outcome: "strict" | string[];
}> = [
  {
    id: "atomic notes",
    prompts: "notes.extract, notes.repair",
    contract: AtomicNoteGenerationOutputSchema,
    outcome: ["optional member"]
  },
  {
    id: "knowledge graph",
    prompts: "graph.source_chunks, graph.atomic_notes, graph.catalog_metadata (and repairs)",
    contract: KnowledgeGraphGenerationOutputSchema,
    outcome: ["optional member", "refinement", "transform"]
  },
  {
    id: "confirmation (entity identity, relation type)",
    prompts: "graph.entity_identity, graph.relation_identity (and repairs)",
    contract: relationMatchOutputSchema,
    outcome: ["tuple"]
  },
  {
    id: "topic overview",
    prompts: "topic.overview",
    contract: TopicOverviewOutputSchema,
    outcome: "strict"
  },
  {
    id: "topic overview patch (REFRESH, F4 D17)",
    prompts: "topic.overview.patch (repaired by topic.overview.repair)",
    contract: TopicOverviewPatchOutputSchema,
    outcome: "strict"
  },
  {
    id: "relation typing",
    prompts: "relations.type (and its re-ask)",
    contract: relationTypingOutputSchema(),
    outcome: "strict"
  },
  {
    id: "topic naming",
    prompts: "topic.name, topic.name.repair",
    contract: topicNamingOutputContract.contract,
    outcome: ["optional member"]
  },
  {
    id: "topic areas",
    prompts: "topic.areas, topic.areas.repair",
    contract: topicAreasOutputContract.contract,
    outcome: "strict"
  }
];

/**
 * The grammar of each contract (F4 D24): the schema the MLX helper's mask compiles, its name, answers
 * Zod accepts (the grammar must let a model write them) and answers Zod refuses for their shape (the
 * grammar must not). `native/mlx-helper/Tests/MemoraGrammarTests` reads the same cases from the
 * fixture below, so the Swift compiler is tested on exactly what this emitter sends.
 */
const grammarCases: Record<string, { name: string; valid: unknown[]; invalid: unknown[] }> = {
  "atomic notes": {
    name: "atomic_notes",
    valid: [
      {
        notes: [
          {
            title: "Memory",
            bodyMarkdown: 'Notes **hold** one idea.\n\n- "quoted"',
            ideaStatement: "A note holds one idea.",
            language: "en",
            evidenceChunkIds: ["c1", "chunk:2"]
          },
          {
            title: "Memória — ação",
            bodyMarkdown: "Uma ideia 中文 😀.",
            ideaStatement: "Ideia.",
            evidenceChunkIds: ["c3"]
          }
        ]
      },
      { notes: [] }
    ],
    invalid: [
      { notes: [{ title: "a", bodyMarkdown: "b", ideaStatement: "c", evidenceChunkIds: [] }] },
      {
        notes: [
          {
            title: "a",
            bodyMarkdown: "b",
            ideaStatement: "c",
            language: "de",
            evidenceChunkIds: ["c1"]
          }
        ]
      },
      { notes: [{ title: "a", bodyMarkdown: "b", ideaStatement: "c", evidenceChunkIds: ["c 1"] }] },
      { notes: [{ title: "a", bodyMarkdown: "b", evidenceChunkIds: ["c1"] }] }
    ]
  },
  "knowledge graph": {
    name: "knowledge_graph",
    valid: [
      {
        entities: [
          {
            key: "e1",
            identityDescription: "The mathematician who wrote the first program",
            type: "Person",
            canonicalName: "Ada Lovelace",
            aliases: ["Ada"],
            confidence: 0.9,
            evidenceChunkIds: ["c1"]
          },
          {
            key: "e2",
            identityDescription: "Babbage's general-purpose computer design",
            type: "Product",
            canonicalName: "Analytical Engine",
            description: "A mechanical computer.",
            confidence: 1,
            evidenceChunkIds: ["c1", "c2"]
          }
        ],
        relations: [
          {
            subjectEntityKey: "e1",
            predicate: "wrote_about",
            displayLabel: "wrote about",
            definition: "The subject wrote about the object.",
            objectEntityKey: "e2",
            confidence: 0.75,
            evidenceChunkIds: ["c2"]
          }
        ]
      },
      { entities: [], relations: [] }
    ],
    invalid: [
      {
        entities: [
          {
            key: "e1",
            identityDescription: "x",
            type: "Animal",
            canonicalName: "x",
            confidence: 0.5,
            evidenceChunkIds: ["c1"]
          }
        ],
        relations: []
      },
      {
        entities: [
          {
            key: "e1",
            identityDescription: "x",
            type: "Concept",
            canonicalName: "x",
            confidence: 1.5,
            evidenceChunkIds: ["c1"]
          }
        ],
        relations: []
      },
      {
        entities: [],
        relations: [
          {
            subjectEntityKey: "e1",
            predicate: "Wrote-About",
            displayLabel: "x",
            definition: "x",
            objectEntityKey: "e2",
            confidence: 0.5,
            evidenceChunkIds: ["c1"]
          }
        ]
      },
      { entities: [] }
    ]
  },
  "confirmation (entity identity, relation type)": {
    name: "entity_identity",
    valid: [
      {
        matches: [
          ["r1", "c2"],
          ["r2", null]
        ]
      },
      { matches: [] }
    ],
    invalid: [{ matches: [["r1"]] }, { matches: [["r1", "c1", "c2"]] }, { matches: [[null, "c1"]] }]
  },
  "topic overview": {
    name: "topic_overview",
    valid: [{ paragraphs: [{ text: "Overview [E1].", citations: [1, "E2"] }, { text: "More." }] }],
    invalid: [{ paragraphs: [] }, { paragraphs: [{ citations: [1] }] }]
  },
  "topic overview patch (REFRESH, F4 D17)": {
    name: "topic_overview_patch",
    valid: [
      {
        paragraphs: ["A later source dates it to 1843 [E3]."],
        divergences: [{ existing: "E1", new: "E3", summary: "They give different years." }]
      },
      { paragraphs: [], divergences: [] }
    ],
    invalid: [
      { paragraphs: [] },
      { paragraphs: [{ text: "New." }], divergences: [] },
      { paragraphs: [], divergences: [{ existing: "E1", new: "E2" }] }
    ]
  },
  "relation typing": {
    name: "relation_typing",
    valid: [
      {
        pairs: [
          { p: "p1", t: "supports", d: "ab" },
          { p: "p24", t: "none", d: "none" }
        ]
      }
    ],
    invalid: [
      { pairs: [{ p: "p25", t: "supports", d: "ab" }] },
      { pairs: [{ p: "p1", t: "supports" }] },
      { pairs: [{ p: "p1", t: "Supports", d: "ab" }] }
    ]
  },
  "topic naming": {
    name: "topic_naming",
    valid: [
      {
        topics: [
          { alias: "t1", title: "Memory", description: "Notes about memory.", language: "en" },
          {
            alias: "t2",
            title: "Memória",
            description: "Notas.",
            aliases: ["Lembrança"],
            language: "pt-BR"
          }
        ]
      }
    ],
    invalid: [{ topics: [{ alias: "t1", title: "Memory" }] }, { topics: {} }]
  },
  "topic areas": {
    name: "topic_areas",
    valid: [
      {
        areas: [
          { alias: "a1", members: ["n1", "n2"] },
          { new: { title: "Area", description: "What it holds." }, members: [] }
        ]
      }
    ],
    invalid: [{ areas: [{ alias: "a1" }] }, { areas: [{ alias: "", members: [] }] }]
  }
};

const grammarFixturePath = fileURLToPath(
  new URL(
    "../../../../../native/mlx-helper/Tests/MemoraGrammarTests/Fixtures/catalog-grammar-schemas.json",
    import.meta.url
  )
);

function grammarFixture(): unknown {
  return JSON.parse(
    JSON.stringify(
      Object.fromEntries(
        catalog.map(({ id, contract }) => {
          const { name, valid, invalid } = grammarCases[id]!;
          return [name, { schema: toGrammarJsonSchema(contract, name)?.schema, valid, invalid }];
        })
      )
    )
  );
}

describe("the grammar of every catalog contract (F4 D24)", () => {
  it.each(catalog)("$id emits a closed grammar schema", ({ id, contract }) => {
    const name = grammarCases[id]!.name;
    const output = toGrammarJsonSchema(contract, name);
    expect(output).toMatchObject({ name, strict: false });
    expect(output!.schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it.each(catalog)("$id: the samples are what Zod says they are", ({ id, contract }) => {
    for (const answer of grammarCases[id]!.valid)
      expect(contract.safeParse(answer).success).toBe(true);
    for (const answer of grammarCases[id]!.invalid)
      expect(contract.safeParse(answer).success).toBe(false);
  });

  it("says what the strict schema cannot: tuples, patterns, lengths, optional members", () => {
    const schemas = grammarFixture() as Record<string, { schema: Record<string, unknown> }>;
    const property = (name: string, ...path: string[]) =>
      path.reduce<unknown>(
        (node, key) => (node as Record<string, unknown>)[key],
        schemas[name]!.schema
      );
    expect(property("entity_identity", "properties", "matches", "items")).toMatchObject({
      prefixItems: [{ type: "string" }, { anyOf: [{ type: "string" }, { type: "null" }] }],
      items: false,
      minItems: 2
    });
    expect(
      property("knowledge_graph", "properties", "relations", "items", "properties", "predicate")
    ).toMatchObject({ pattern: "^[a-z]+(?:_[a-z]+)*$", maxLength: 120 });
    expect(property("atomic_notes", "properties", "notes", "items", "required")).not.toContain(
      "language"
    );
    expect(property("topic_naming", "properties", "topics", "items", "required")).not.toContain(
      "aliases"
    );
    expect(property("topic_areas", "properties", "areas", "items", "anyOf")).toHaveLength(2);
    expect(
      property("relation_typing", "properties", "pairs", "items", "properties", "p", "enum")
    ).toHaveLength(24);
  });

  it("matches the fixture the Swift grammar tests read", () => {
    const fixture = grammarFixture();
    // MEMORA_WRITE_GRAMMAR_FIXTURE=1 rewrites it after a contract changed.
    if (process.env.MEMORA_WRITE_GRAMMAR_FIXTURE === "1")
      writeFileSync(grammarFixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
    expect(JSON.parse(readFileSync(grammarFixturePath, "utf8"))).toEqual(fixture);
  });
});

/**
 * The grammars of one call (F4 D24, after T99's replay): the confirmation and typing contracts
 * narrowed to a call's own rows or pairs, which a runtime that constrains decoding is sent instead of
 * the static grammar. The Swift tests read them from their own fixture (`CallGrammarTests`).
 */
const callRow = (key: string, candidates: string[]): RelationMatchRow => ({
  key,
  predicate: key,
  definition: key,
  candidates: candidates.map((candidate) => ({
    key: candidate,
    predicate: candidate,
    definition: candidate
  }))
});
// The largest call: the row cap, each row at the settings' largest candidate list (20).
const largestCall = Array.from({ length: maxIdentityGroupRows }, (_, row) =>
  callRow(
    `r${row + 1}`,
    Array.from({ length: 20 }, (_, candidate) =>
      candidate < row ? `r${candidate + 1}` : `c${row * 20 + candidate + 1}`
    )
  )
);
const callGrammarCases: Record<
  string,
  { name: string; contract: z.ZodType; valid: unknown[]; invalid: unknown[] }
> = {
  entity_identity_call: {
    name: "entity_identity",
    contract: relationMatchCallSchema([
      callRow("r1", ["c1", "c2"]),
      callRow("r2", ["c3"]),
      callRow("r3", ["r1", "c4"]),
      callRow("r4", [])
    ]),
    valid: [
      {
        matches: [
          ["r1", "c2"],
          ["r2", null],
          ["r3", "r1"],
          ["r4", null]
        ]
      },
      {
        matches: [
          ["r1", null],
          ["r2", "c3"],
          ["r3", "c4"],
          ["r4", null]
        ]
      }
    ],
    invalid: [
      {
        matches: [
          ["r1", "c2"],
          ["r2", null],
          ["r3", "r1"]
        ]
      },
      {
        matches: [
          ["r1", "c2"],
          ["r2", null],
          ["r3", "r1"],
          ["r4", null],
          ["r4", null]
        ]
      },
      {
        matches: [
          ["r2", null],
          ["r1", "c2"],
          ["r3", "r1"],
          ["r4", null]
        ]
      },
      {
        matches: [
          ["r1", "c3"],
          ["r2", null],
          ["r3", "r1"],
          ["r4", null]
        ]
      },
      {
        matches: [
          ["r1", "c9"],
          ["r2", null],
          ["r3", "r1"],
          ["r4", null]
        ]
      },
      {
        matches: [
          ["r1", "c2"],
          ["r2", null],
          ["r3", "r1"],
          ["r4", "c1"]
        ]
      },
      {
        matches: [
          ["r9", "c1"],
          ["r2", null],
          ["r3", "r1"],
          ["r4", null]
        ]
      }
    ]
  },
  relation_identity_call_largest: {
    name: "relation_identity",
    contract: relationMatchCallSchema(largestCall),
    valid: [
      {
        matches: largestCall.map((row, index) => [
          row.key,
          index % 3 === 0 ? null : row.candidates[index % 20]!.key
        ])
      }
    ],
    invalid: [
      {
        matches: largestCall.map((row, index) => [
          row.key,
          index === 5 ? largestCall[6]!.candidates[19]!.key : null
        ])
      },
      { matches: largestCall.slice(1).map((row) => [row.key, null]) }
    ]
  },
  relation_typing_call: {
    name: "relation_typing",
    contract: relationTypingCallSchema(["p3", "p7", "p12"]),
    valid: [
      {
        pairs: [
          { p: "p3", t: "supports", d: "ab" },
          { d: "both", p: "p7", t: "same_as" },
          { p: "p12", t: "none", d: "none" }
        ]
      }
    ],
    invalid: [
      {
        pairs: [
          { p: "p3", t: "supports", d: "ab" },
          { p: "p12", t: "none", d: "none" }
        ]
      },
      {
        pairs: [
          { p: "p1", t: "supports", d: "ab" },
          { p: "p7", t: "same_as", d: "both" },
          { p: "p12", t: "none", d: "none" }
        ]
      },
      {
        pairs: [
          { p: "p7", t: "same_as", d: "both" },
          { p: "p3", t: "supports", d: "ab" },
          { p: "p12", t: "none", d: "none" }
        ]
      }
    ]
  }
};

const callGrammarFixturePath = fileURLToPath(
  new URL(
    "../../../../../native/mlx-helper/Tests/MemoraGrammarTests/Fixtures/call-grammar-schemas.json",
    import.meta.url
  )
);

function callGrammarFixture(): unknown {
  return JSON.parse(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(callGrammarCases).map(([id, { name, contract, valid, invalid }]) => [
          id,
          { schema: toGrammarJsonSchema(contract, name)?.schema, valid, invalid }
        ])
      )
    )
  );
}

describe("the grammar of one call (F4 D24)", () => {
  it.each(Object.entries(callGrammarCases))(
    "%s emits, within the size the emitter sends",
    (_id, { name, contract }) => {
      const output = toGrammarJsonSchema(contract, name);
      expect(output).toMatchObject({ name, strict: false });
      expect(JSON.stringify(output!.schema).length).toBeLessThan(grammarSchemaMaxCharacters);
    }
  );

  it.each(Object.entries(callGrammarCases))(
    "%s: the samples are what Zod says they are, and the static contract takes the valid ones",
    (id, { contract, valid, invalid }) => {
      const wide = id.startsWith("relation_typing")
        ? relationTypingOutputSchema()
        : relationMatchOutputSchema;
      for (const answer of valid) {
        expect(contract.safeParse(answer).success).toBe(true);
        expect(wide.safeParse(answer).success).toBe(true);
      }
      for (const answer of invalid) expect(contract.safeParse(answer).success).toBe(false);
    }
  );

  it("matches the fixture the Swift grammar tests read", () => {
    const fixture = callGrammarFixture();
    // MEMORA_WRITE_GRAMMAR_FIXTURE=1 rewrites it after a contract changed.
    if (process.env.MEMORA_WRITE_GRAMMAR_FIXTURE === "1")
      writeFileSync(callGrammarFixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
    expect(JSON.parse(readFileSync(callGrammarFixturePath, "utf8"))).toEqual(fixture);
  });
});

describe("the contracts the topic tree states", () => {
  it("names the overview's contract from the schema the catalog checks", () => {
    expect(topicOverviewOutputContract.contract).toBe(TopicOverviewOutputSchema);
  });

  it("derives a strict schema under its name for a strict contract or its strict terms", () => {
    expect(outputSchemaForContract(topicOverviewOutputContract)).toMatchObject({
      name: "topic_overview",
      strict: true
    });
    expect(outputSchemaForContract(topicAreasOutputContract)).toMatchObject({
      name: "topic_areas",
      strict: true
    });
    expect(outputSchemaForContract(topicOverviewPatchOutputContract)).toMatchObject({
      name: "topic_overview_patch",
      strict: true
    });
    // The naming contract itself is not strict (an optional `aliases`): its strict terms are sent.
    expect(outputSchemaForContract(topicNamingOutputContract)).toMatchObject({
      name: "topic_naming",
      strict: true
    });
  });
});

describe("the structured-output catalog", () => {
  it.each(catalog)("$id ($prompts)", ({ contract, outcome }) => {
    const analysis = analyzeStrictJsonSchema(contract);
    if (outcome === "strict") {
      expect(analysis.issues).toEqual([]);
      expect(analysis.schema).not.toBeNull();
    } else {
      expect(analysis.schema).toBeNull();
      expect(analysis.issues).toEqual(outcome);
    }
  });

  it("sends an object schema with closed objects for every strict contract", () => {
    for (const { contract, outcome } of catalog) {
      if (outcome !== "strict") continue;
      const schema = analyzeStrictJsonSchema(contract).schema!;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
    }
  });
});
