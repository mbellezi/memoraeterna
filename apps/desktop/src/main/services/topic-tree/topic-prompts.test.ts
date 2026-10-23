import { promptDefinition } from "@app/domain";
import { defaultTopicTreeConfig, packNamingCalls } from "@app/domain/topic-tree";
import type { NamingCall, NamingMember, UnaliasedTopic } from "@app/domain/topic-tree";
import { describe, expect, it } from "vitest";

import { renderPrompt } from "../prompt-runtime.js";
import {
  TopicAreasOutputSchema,
  buildTopicAreasPrompt,
  buildTopicAreasRepairPrompt,
  buildTopicNamePrompt,
  buildTopicNameRepairPrompt,
  parseTopicAreasOutput,
  topicGateInstruction,
  topicNamePromptVersion
} from "./topic-prompts.js";
import {
  buildTopicOverviewPatchPrompt,
  buildTopicOverviewPrompt,
  buildTopicOverviewRepairPrompt,
  parseTopicOverviewOutput,
  topicOverviewPatchOutputContract,
  topicOverviewSupportInstruction
} from "./topic-prompts.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const config = defaultTopicTreeConfig.naming;
const input = { contentLanguage: "pt-BR", config };

function member(title: string, idea: string | null = `${title}: ideia`): NamingMember {
  return { key: `note:${uuid(title.length)}`, kind: "note", title, idea, rootSource: null };
}
function topic(id: number, title: string, currentTitle: string | null = null): UnaliasedTopic {
  return { topicId: uuid(id), size: 9, members: [member(title)], currentTitle };
}
function call(base: number): NamingCall {
  return packNamingCalls(
    [
      {
        parentId: uuid(base + 100),
        parentTitle: "Aprendizagem",
        namedSiblings: ["Prática espaçada"],
        topics: [topic(base + 1, "Recuperação com feedback"), topic(base + 2, "Atenção seletiva")]
      },
      {
        parentId: uuid(base + 101),
        parentTitle: null,
        parentHeldTitle: "Ciências da Terra",
        namedSiblings: [],
        topics: [
          topic(base + 3, "Marés e correntes", "Oceanografia"),
          {
            topicId: uuid(base + 4),
            size: 40,
            members: [],
            subtopics: [
              { title: "Vulcões", size: 25, members: [member("Erupções explosivas")] },
              { title: null, size: 15, members: [member("Placas tectônicas")] }
            ],
            childTitles: ["Vulcões"],
            currentTitle: null
          }
        ]
      }
    ],
    { maxTopics: config.maxTopicsPerCall, maxMembers: config.maxMembersPerCall }
  )[0]!;
}

describe("the topic naming prompt", () => {
  it("renders the content language, the limits from configuration and the groups", () => {
    const text = buildTopicNamePrompt(call(0), input);
    expect(text).toContain("Brazilian Portuguese");
    expect(text).toContain(`at most ${config.titleMaxChars} characters`);
    expect(text).toContain(`at most ${config.descriptionMaxChars} characters`);
    expect(text).toContain(`up to ${config.maxAliases} other names`);
    expect(text).toContain('"parent":"Aprendizagem"');
    expect(text).toContain('"named_siblings":["Prática espaçada"]');
    expect(text).toContain('"alias":"T1","size":9,"notes"');
    expect(text).toContain('"alias":"T3","current_title":"Oceanografia","size":9');
    expect(text).toContain('"parent":null');
    expect(text).toContain(
      '"title":"Recuperação com feedback","idea":"Recuperação com feedback: ideia"'
    );
    // An internal topic shows its subtopics, larger first, with their sizes and a few notes.
    expect(text).toContain(
      '{"alias":"T4","size":40,"subtopics":[{"title":"Vulcões","size":25,"notes":[{"title":"Erupções explosivas"'
    );
    expect(text).toContain('{"title":null,"size":15,"notes":[{"title":"Placas tectônicas"');
    // The title of a parent named after its children is held back from the prompt.
    expect(text).not.toContain("Ciências da Terra");
    // The output contract is part of the prompt and names every field.
    for (const field of ["alias", "title", "description", "aliases", "language"]) {
      expect(text).toContain(`"${field}"`);
    }
    expect(text).not.toMatch(/%[a-z_]+%/u);
  });

  it("is a function of content: other IDs, same prompt", () => {
    expect(buildTopicNamePrompt(call(0), input)).toBe(buildTopicNamePrompt(call(5000), input));
    expect(buildTopicNamePrompt(call(0), input)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });

  it("asks for a name that covers the whole topic (revision 2)", () => {
    const text = buildTopicNamePrompt(call(0), input);
    expect(text).toContain("a sample of its notes chosen to span all of it, not only its centre");
    expect(text).toContain(
      "the most specific subject that covers every note and every subtopic shown"
    );
    expect(text).toContain("after one of its subtopics or after its largest subtopic");
    expect(text).toContain("differs from every subtopic's title");
    expect(text).toContain("must differ from the title of its parent topic");
    expect(text).toContain("sums up the whole range of the topic");
    expect(topicNamePromptVersion).toBe("topic-name-v2");
    expect(promptDefinition("topic.name").defaultVersion).toBe("2");
  });

  it("asks again only for the rejected topics and says what was wrong", () => {
    const retry = call(0);
    retry.groups = [
      {
        ...retry.groups[0]!,
        topics: retry.groups[0]!.topics.filter((item) => item.alias === "T2")
      }
    ];
    const text = buildTopicNameRepairPrompt(
      retry,
      input,
      'T2: the title "Mente" repeats the parent title "Mente"'
    );
    expect(text).toContain('{"alias":"T2","size":9,"notes":');
    expect(text).not.toContain('{"alias":"T1","size"');
    expect(text).not.toContain("Recuperação com feedback");
    expect(text).toContain("was rejected");
    expect(text).toContain('T2: the title "Mente" repeats the parent title "Mente"');
  });

  it("is declared in the catalog with typed variables and no hand-written numbers", () => {
    const definition = promptDefinition("topic.name");
    expect(definition.task).toBe("structured-output");
    const types = Object.fromEntries(definition.variables.map((v) => [v.key, v.valueType]));
    expect(types).toEqual({
      content_language: "text",
      title_max_chars: "integer",
      description_max_chars: "integer",
      max_aliases: "integer",
      topics: "list",
      output_contract: "text"
    });
    expect(definition.fragmentIds).toContain("shared.output_language");
    expect(promptDefinition("topic.name.repair").fragmentIds).toContain("topic.name");
    for (const variable of definition.variables) {
      for (const locale of Object.values(variable.description)) {
        expect(locale).not.toContain("[[missing");
      }
    }
    // The template carries no copy of the limits: they come from configuration.
    expect(definition.fields[0]!.template).not.toMatch(/\b(80|200)\b/u);
  });
});

describe("the Areas prompt", () => {
  const areas = {
    contentLanguage: "es",
    areas: { target: 10, min: 7, max: 16 },
    pinned: [{ alias: "A1", title: "Memoria", description: null }],
    topics: [
      { alias: "T1", titles: ["Repaso espaciado", "Recuperación"] },
      { alias: "T2", titles: ["Mareas"] }
    ]
  };

  it("renders the bounds, the pinned Areas and the aliased topics", () => {
    const text = buildTopicAreasPrompt(areas);
    expect(text).toContain("Spanish");
    expect(text).toContain("about 10 Areas, never fewer than 7 and never more than 16");
    expect(text).toContain('[{"alias":"A1","title":"Memoria"}]');
    expect(text).toContain('{"alias":"T1","titles":["Repaso espaciado","Recuperación"]}');
    expect(text).not.toMatch(/%[a-z_]+%/u);
  });

  it("parses both shapes of an Areas answer and rejects anything else", () => {
    const answer = {
      areas: [
        { alias: "A1", members: ["T1"] },
        { new: { title: "Océanos", description: "Mares y corrientes." }, members: ["T2"] }
      ]
    };
    expect(parseTopicAreasOutput(answer).areas).toHaveLength(2);
    expect(
      parseTopicAreasOutput(`\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``).areas
    ).toHaveLength(2);
    expect(TopicAreasOutputSchema.safeParse({ areas: [{ members: ["T1"] }] }).success).toBe(false);
    expect(() => parseTopicAreasOutput("not json")).toThrow();
  });

  it("follows the grouping prompt with what was wrong, in the language the titles stay in", () => {
    const base = buildTopicAreasPrompt(areas);
    const issues = "Topics in no Area (put each in exactly one Area): T6, T9";
    const text = buildTopicAreasRepairPrompt(base, "es", issues);
    expect(text.startsWith(`${base}\n\n`)).toBe(true);
    const repair = text.slice(base.length);
    expect(repair).toContain("was rejected");
    expect(repair).toContain(issues);
    expect(repair).toContain("title and description in Spanish");
    expect(repair).toContain("every topic alias in exactly one Area");
    expect(text).not.toMatch(/%[a-z_]+%/u);
    // Content only: the same problems give the same prompt, and no ID is in it.
    expect(buildTopicAreasRepairPrompt(base, "es", issues)).toBe(text);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });

  it("is declared in the catalog next to the grouping prompt", () => {
    const definition = promptDefinition("topic.areas.repair");
    expect(definition.task).toBe("structured-output");
    expect(definition.variables.map((variable) => variable.key).sort()).toEqual([
      "content_language",
      "validation_errors"
    ]);
    expect(definition.fragmentIds).toContain("topic.areas");
    expect(definition.fragmentIds).toContain("shared.output_language");
  });
});

describe("the gate instruction", () => {
  it("is plain text for a dedicated ranker, with no language fragment", () => {
    const text = topicGateInstruction();
    expect(text).toMatch(/^Given a note, retrieve the topic it belongs to/u);
    expect(text).not.toContain("%");
    const definition = promptDefinition("topic.gate.instruction");
    expect(definition.task).toBe("reranking");
    expect(definition.variables).toEqual([]);
    expect(definition.fragmentIds).not.toContain("shared.output_language");
    expect(renderPrompt("topic.gate.instruction")).toBe(text);
  });
});

describe("the overview prompts", () => {
  const overview = {
    contentLanguage: "fr",
    topic: {
      title: "Sommeil et mémoire",
      description: "Comment le sommeil consolide les souvenirs."
    },
    evidence: [
      {
        title: "Le sommeil profond consolide",
        idea: "Le sommeil profond consolide la mémoire.",
        source: "Livre du sommeil",
        passage:
          "Pendant le sommeil profond, le cerveau rejoue les souvenirs. %topic% reste du texte."
      },
      {
        title: "Les siestes aident",
        idea: "Une courte sieste améliore l'attention.",
        source: "Article",
        passage: "Une sieste de vingt minutes améliore l'attention l'après-midi."
      }
    ]
  };

  it("renders the language, the limit, the topic and the numbered evidence, untrusted text left literal", () => {
    const text = buildTopicOverviewPrompt(overview);
    expect(text).toContain("French");
    expect(text).toContain("at most 5 short paragraphs");
    expect(text).toContain('{"title":"Sommeil et mémoire","description":"Comment le sommeil');
    expect(text).toContain('{"n":1,"title":"Le sommeil profond consolide"');
    expect(text).toContain('{"n":2,"title":"Les siestes aident"');
    expect(text).toContain('"source":"Livre du sommeil"');
    expect(text).toContain("%topic% reste du texte.");
    expect(text).toContain('"citations":[1,2,3]');
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    const unnamed = buildTopicOverviewPrompt({
      ...overview,
      topic: { title: null, description: null }
    });
    expect(unnamed).toContain('Topic:\n{"title":null}');
  });

  it("is a function of content: the same evidence gives the same prompt", () => {
    expect(buildTopicOverviewPrompt(overview)).toBe(
      buildTopicOverviewPrompt(structuredClone(overview))
    );
    expect(
      buildTopicOverviewPrompt({ ...overview, evidence: [...overview.evidence].reverse() })
    ).not.toBe(buildTopicOverviewPrompt(overview));
  });

  it("repairs once with what was wrong, and parses fenced or bare JSON", () => {
    const prompt = buildTopicOverviewPrompt(overview);
    const repair = buildTopicOverviewRepairPrompt(prompt, "Paragraph 1 cites [7].");
    expect(repair.startsWith(prompt)).toBe(true);
    expect(repair).toContain("was rejected");
    expect(repair).toContain("Paragraph 1 cites [7].");
    const answer = { paragraphs: [{ text: "Texte [1].", citations: [1] }] };
    expect(parseTopicOverviewOutput(JSON.stringify(answer))).toEqual(answer);
    expect(parseTopicOverviewOutput(`\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``)).toEqual(
      answer
    );
  });

  it("is declared in the catalog with typed variables; the support check is a ranker instruction", () => {
    const definition = promptDefinition("topic.overview");
    expect(definition.task).toBe("structured-output");
    const types = Object.fromEntries(definition.variables.map((v) => [v.key, v.valueType]));
    expect(types).toEqual({
      content_language: "text",
      max_paragraphs: "integer",
      topic: "object",
      evidence: "list",
      output_contract: "text"
    });
    expect(definition.fragmentIds).toContain("shared.output_language");
    expect(promptDefinition("topic.overview.repair").fragmentIds).toContain("topic.overview");
    for (const variable of definition.variables) {
      for (const locale of Object.values(variable.description)) {
        expect(locale).not.toContain("[[missing");
      }
    }
    const support = promptDefinition("topic.overview.support");
    expect(support.task).toBe("reranking");
    expect(support.variables).toEqual([]);
    expect(support.fragmentIds).not.toContain("shared.output_language");
    const instruction = topicOverviewSupportInstruction();
    expect(instruction).toMatch(/^Given a sentence from a summary/u);
    expect(instruction).not.toContain("%");
  });
});

describe("the overview patch prompt (REFRESH, F4 D17)", () => {
  const patch = {
    contentLanguage: "fr",
    topic: { title: "Sommeil et mémoire", description: null },
    paragraphs: ["Le sommeil profond consolide la mémoire [1]. Les siestes aident [2]."],
    cited: [
      { source: "Livre du sommeil", excerpt: "Pendant le sommeil profond, le cerveau rejoue." },
      { source: "Article", excerpt: "Une sieste de vingt minutes améliore l'attention." }
    ],
    evidence: [
      {
        title: "Le manque de sommeil nuit",
        idea: "Le manque de sommeil réduit la mémoire.",
        source: "Étude",
        passage: "Une nuit blanche réduit le rappel du lendemain. %evidence% reste du texte."
      },
      {
        title: "Les rêves trient",
        idea: "Les rêves trient les souvenirs.",
        source: "Revue",
        passage: "Le sommeil paradoxal trie ce qui sera gardé."
      }
    ],
    maxParagraphs: 3
  };

  it("shows the stored text as final, its citations E1..Ek and the new evidence numbered after them", () => {
    const text = buildTopicOverviewPatchPrompt(patch);
    expect(text).toMatch(/^Extend the short overview of one topic/u);
    expect(text).toContain("French");
    expect(text).toContain("at most 3 new short paragraphs");
    expect(text).toContain("never repeat, rewrite or correct it");
    expect(text).toContain(
      'Overview:\n["Le sommeil profond consolide la mémoire [1]. Les siestes aident [2]."]'
    );
    expect(text).toContain('{"n":1,"source":"Livre du sommeil","excerpt":"Pendant le sommeil');
    expect(text).toContain('{"n":2,"source":"Article"');
    expect(text).toContain('{"n":3,"title":"Le manque de sommeil nuit"');
    expect(text).toContain('{"n":4,"title":"Les rêves trient"');
    expect(text).toContain("%evidence% reste du texte.");
    expect(text).toContain('"divergences":[{"existing":"E2","new":"E7"');
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });

  it("is a function of content: the same stored text and evidence give the same prompt", () => {
    expect(buildTopicOverviewPatchPrompt(patch)).toBe(
      buildTopicOverviewPatchPrompt(structuredClone(patch))
    );
    expect(
      buildTopicOverviewPatchPrompt({ ...patch, evidence: [...patch.evidence].reverse() })
    ).not.toBe(buildTopicOverviewPatchPrompt(patch));
  });

  it("is declared in the catalog with typed variables, a strict contract and the overview's repair", () => {
    const definition = promptDefinition("topic.overview.patch");
    expect(definition.task).toBe("structured-output");
    expect(definition.defaultVersion).toBe("1");
    const types = Object.fromEntries(definition.variables.map((v) => [v.key, v.valueType]));
    expect(types).toEqual({
      content_language: "text",
      max_paragraphs: "integer",
      topic: "object",
      overview_paragraphs: "list",
      cited_evidence: "list",
      evidence: "list",
      output_contract: "text"
    });
    expect(definition.fragmentIds).toContain("shared.output_language");
    for (const variable of definition.variables)
      for (const locale of Object.values(variable.description))
        expect(locale).not.toContain("[[missing");
    for (const locale of Object.values(definition.title)) expect(locale).not.toContain("[[missing");
    expect(topicOverviewPatchOutputContract.name).toBe("topic_overview_patch");
    const repair = buildTopicOverviewRepairPrompt(buildTopicOverviewPatchPrompt(patch), "x");
    expect(repair).toContain("was rejected");
  });
});
