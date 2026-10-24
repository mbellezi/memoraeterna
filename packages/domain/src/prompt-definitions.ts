import { z } from "zod";
import { AtomicNoteGenerationOutputSchema } from "./knowledge.js";
import { promptMetadataLabels } from "@app/i18n";
import { candidatePromptBodies, shippedPromptBodies } from "./prompt-defaults.js";
import {
  parsePromptTemplate,
  PromptDefinitionSchema,
  type PromptDefinition,
  type PromptVariable
} from "./prompt-catalog.js";
export const promptCategoryLabels = Object.fromEntries(
  [
    "shared",
    "summary",
    "notes",
    "graph",
    "sources",
    "relations",
    "embedding",
    "consultation",
    "diagnostics",
    "topic"
  ].map((key) => [key, promptMetadataLabels("categories", key)])
);
export function promptLabel(key: string) {
  return promptMetadataLabels("labels", key);
}
const variableExamples: Record<string, z.infer<ReturnType<typeof z.json>>> = {
  chunks: [
    {
      id: "c1",
      content: "In a fictional study, retrieval with feedback improved recall."
    }
  ],
  partial_summaries: "PART 1\nRetrieval helped when feedback was available.",
  source_type: "Book",
  source_title: "A fictional study of recall",
  ordered_subparts: "1. Feedback\nRetrieval with feedback improved delayed recall.",
  validation_errors: "Unknown evidence alias: c9",
  allowed_chunk_ids: ["00000000-0000-4000-8000-000000000001"],
  previous_output: '{"notes":',
  source_idea: "Feedback improved delayed recall in a fictional trial.",
  candidate_notes:
    "[1]\nTitle: Spaced practice\nMain idea: Practice on separate days improved recall.",
  input_kind: "source_chunks",
  evidence_aliases: ["c1"],
  source_language: "en",
  input_heading: "ORIGINAL SOURCE CHUNKS",
  graph_inputs: "c1: Retrieval with feedback improved delayed recall.",
  relations: [
    {
      key: "r1",
      predicate: "improves_recall",
      definition: "The subject improves recall.",
      candidateKeys: ["c1"]
    }
  ],
  candidates: [
    {
      key: "c1",
      predicate: "supports_recall",
      definition: "The subject supports recall."
    }
  ],
  weak_types: "false",
  sources: [
    {
      key: "s1",
      title: "Fictional feedback study",
      chunks: [
        {
          key: "c1",
          content: "Feedback improved delayed recall."
        }
      ]
    }
  ],
  relation_type: "supports",
  relation_direction: "n1_to_n2",
  max_characters: 300,
  relation_notes: [
    {
      note: "n1",
      idea: "Feedback improved delayed recall in a fictional trial.",
      passage: "In a fictional study, retrieval with feedback improved recall."
    },
    {
      note: "n2",
      idea: "Retrieval practice strengthens long-term memory.",
      passage: "Practice that recalls studied material strengthened later recall."
    }
  ],
  relation_pairs: [
    {
      p: "p1",
      a: "Retrieval with feedback\nFeedback improved delayed recall in a fictional trial.",
      b: "Retrieval practice\nPractice that recalls studied material strengthens long-term memory."
    }
  ],
  relation_sources: [
    {
      source: "s1",
      title: "Fictional feedback study",
      passages: ["In a fictional study, retrieval with feedback improved recall."]
    },
    {
      source: "s2",
      title: "Fictional retrieval review",
      passages: ["Practice that recalls studied material strengthened later recall."]
    }
  ],
  note_relations: [
    {
      source: "s1",
      target: "s2",
      type: "supports",
      sourceIdea: "Feedback improved delayed recall in a fictional trial.",
      targetIdea: "Retrieval practice strengthens long-term memory.",
      evidence: ["c1", "c2"]
    }
  ],
  guidance: {
    guidance: "Explain the conditions under which retrieval helped.",
    advanced: "Use only the supplied evidence."
  },
  original_evidence: [
    {
      handle: "e1",
      title: "Fictional study",
      excerpt: "Retrieval helped when feedback was available."
    }
  ],
  related_knowledge: [],
  current_page: [],
  source_text: "In a fictional study, retrieval with feedback improved recall.",
  note_title: "Feedback and recall",
  note_idea: "Feedback qualified the observed recall benefit.",
  note_body: "The fictional trial found improved recall when feedback followed retrieval.",
  entity_type: "concept",
  entity_name: "Retrieval practice",
  entity_description: "Practice that recalls studied material from memory.",
  predicate: "improves_recall",
  definition: "The subject improves delayed recall in the described conditions.",
  catalog_metadata: {
    type: "Book",
    title: "Fictional recall study",
    language: "en"
  },
  title_max_chars: 80,
  description_max_chars: 200,
  max_aliases: 5,
  topics: [
    {
      parent: "Learning",
      named_siblings: ["Spaced practice"],
      topics: [
        {
          alias: "T1",
          notes: [
            {
              title: "Retrieval with feedback",
              idea: "Feedback improved delayed recall in a fictional trial."
            }
          ]
        }
      ]
    }
  ],
  areas_target: 10,
  areas_min: 7,
  areas_max: 16,
  pinned_areas: [{ alias: "A1", title: "Learning", description: "How people learn and remember." }],
  area_topics: [{ alias: "T1", titles: ["Retrieval with feedback", "Spaced practice"] }],
  max_paragraphs: 3,
  topic: { title: "Retrieval practice", description: "How recalling material changes memory." },
  evidence: [
    {
      n: 1,
      title: "Retrieval with feedback",
      idea: "Feedback improved delayed recall in a fictional trial.",
      source: "Fictional recall study",
      passage: "In a fictional study, retrieval with feedback improved recall."
    }
  ],
  overview_paragraphs: ["Recalling studied material with feedback improved later recall [1]."],
  cited_evidence: [{ n: 1, title: "Retrieval with feedback", source: "Fictional recall study" }]
};
function variable(key: string, id: string): PromptVariable {
  const numeric = [
    "max_entities",
    "max_relations",
    "title_max_chars",
    "description_max_chars",
    "max_aliases",
    "areas_target",
    "areas_min",
    "areas_max",
    "max_paragraphs"
  ].includes(key);
  return {
    key,
    description: promptMetadataLabels("variables", key),
    valueType: numeric ? "integer" : "text",
    scope: "run",
    required: true,
    originResolver: key,
    example:
      variableExamples[key] !== undefined
        ? typeof variableExamples[key] === "object"
          ? JSON.stringify(variableExamples[key])
          : variableExamples[key]
        : numeric
          ? 3
          : key === "content_language"
            ? "English"
            : key === "page_title" || key === "source_title"
              ? "Synthetic study"
              : key === "output_contract"
                ? '{"items":[]}'
                : key === "query" || key === "question"
                  ? "What improves fictional recall?"
                  : "Synthetic study",
    sensitivity:
      key === "guidance"
        ? "user_guidance"
        : numeric ||
            [
              "output_contract",
              "content_language",
              "input_kind",
              "input_heading",
              "relation_type",
              "relation_direction",
              "max_characters"
            ].includes(key)
          ? "public"
          : "source_content",
    serialization: "text",
    applicablePromptIds: [id],
    emptyRepresentation: null
  };
}
export const promptDefinitions: PromptDefinition[] = shippedPromptBodies.map((row) => {
  const parts = row.id.split("."),
    family = parts[0]!;
  const task =
    family === "summary"
      ? "summarization"
      : family === "notes"
        ? parts[1] === "match"
          ? "reranking"
          : "atomic-note-generation"
        : family === "graph"
          ? "knowledge-graph-generation"
          : family === "sources"
            ? "reranking"
            : family === "relations"
              ? parts[1] === "decide" || parts[1] === "decisions"
                ? "reranking"
                : parts[1] === "type"
                  ? "structured-output"
                  : "text-generation"
              : family === "embedding"
                ? "embedding"
                : family === "diagnostics"
                  ? parts[1] === "local_embedding"
                    ? "embedding"
                    : parts[1] === "local_ranking"
                      ? "reranking"
                      : "text-generation"
                  : family === "topic" && (parts[1] === "gate" || parts[2] === "support")
                    ? "reranking"
                    : family === "shared"
                      ? "fragment"
                      : "structured-output";
  const title = promptLabel(parts.at(-1)!);
  return PromptDefinitionSchema.parse({
    version: "prompt-catalog-v1",
    id: row.id,
    category: [family, ...parts.slice(1, -1)],
    title,
    purpose: promptMetadataLabels("purposes", family),
    caller: row.caller,
    task,
    supportsDomain: family === "consultation",
    defaultVersion:
      // Decide-only compact matching contract (atomic-note-matching-v9).
      row.id === "notes.match"
        ? "3"
        : // Revision 3 lets the writer answer NOT_RELATED when the notes are not related (F3 D22).
          row.id === "relations.explain"
          ? "3"
          : [
                "consultation.knowledge",
                "consultation.investigation",
                "consultation.gaps",
                // Entities and relations only: claims are no longer extracted (knowledge-graph-v8).
                "graph.atomic_notes",
                "graph.source_chunks",
                "graph.catalog_metadata",
                "graph.atomic_notes.repair",
                "graph.source_chunks.repair",
                "graph.catalog_metadata.repair",
                // Names that cover the whole topic: covering samples and subtopics (topic-name-v2).
                "topic.name",
                // The typer asks the panel's strict relatedness question first (F3 decision 29).
                "relations.type",
                // The F3 bake-off's `relation` ranker instruction (the frozen calibrations' own).
                "relations.decide.instruction",
                // One judge call per root names its pairs of works (source-relations-v6, F4 D21).
                "sources.decide",
                "sources.validation.default"
              ].includes(row.id)
            ? "2"
            : "1",
    fields: [
      {
        id: "body",
        template: row.template,
        editable: true,
        variableKeys: [...new Set(row.keys)],
        requiredContractIds: row.keys.includes("output_contract" as never)
          ? ["output_contract"]
          : []
      },
      ...("contract" in row
        ? [
            {
              id: "output_contract",
              template: row.contract,
              editable: false,
              variableKeys: [],
              requiredContractIds: []
            }
          ]
        : [])
    ],
    variables: [...new Set(row.keys)].map((key) => {
      const v = variable(key, row.id),
        format =
          "formats" in row
            ? (
                row.formats as Record<
                  string,
                  {
                    valueType: PromptVariable["valueType"];
                    serialization: PromptVariable["serialization"];
                  }
                >
              )[key]
            : undefined;
      return {
        ...v,
        ...format,
        example:
          format?.valueType === "object" && Array.isArray(variableExamples[key])
            ? { candidates: variableExamples[key], relations: variableExamples.relations }
            : format && ["list", "object"].includes(format.valueType)
              ? (variableExamples[key] ?? (format.valueType === "list" ? [] : {}))
              : v.example
      };
    }),
    fragmentIds: row.keys.includes("relation_language" as never)
      ? ["shared.relation_language"]
      : [],
    fixtureIds: ["automatic-wiki-prompts-v1"]
  });
});
export function promptDefinition(id: string): PromptDefinition {
  const found = promptDefinitions.find((d) => d.id === id);
  if (!found) throw new Error("prompts.errors.unknown");
  return found;
}
/** What Ask is told when a library keeps no wording of its own: the guidance and advanced slots. */
const consultationSlots = {
  guidance:
    "Attribute claims to their original sources; distinguish uncertainty, disagreements and missing evidence.",
  advanced:
    "Answer {{title}} in {{language}} from supplied original evidence. Keep the response read-only, cite each factual paragraph, and disclose limits of the selected material."
};
for (const slot of ["guidance", "advanced"] as const) {
  const id = `consultation.${slot}`,
    template = consultationSlots[slot]
      .replaceAll("{{title}}", "%page_title%")
      .replaceAll("{{language}}", "%content_language%");
  promptDefinitions.push(
    PromptDefinitionSchema.parse({
      version: "prompt-catalog-v1",
      id,
      category: ["consultation"],
      title: promptLabel(slot),
      purpose: promptMetadataLabels("purposes", "consultation"),
      caller: "ConsultationService.consultationInstructions",
      task: "structured-output",
      supportsDomain: true,
      defaultVersion: "1",
      fields: [
        {
          id: "body",
          template,
          editable: true,
          variableKeys: ["page_title", "content_language"],
          requiredContractIds: []
        }
      ],
      variables: ["page_title", "content_language"].map((key) => variable(key, id)),
      fragmentIds: [],
      fixtureIds: ["consultation-slots"]
    })
  );
}
for (const definition of promptDefinitions) {
  if (["notes.extract", "notes.repair"].includes(definition.id))
    definition.fields.push({
      id: "output_contract",
      template: JSON.stringify(z.toJSONSchema(AtomicNoteGenerationOutputSchema), null, 2),
      editable: false,
      variableKeys: [],
      requiredContractIds: []
    });
  const id = definition.id;
  if (
    !id.startsWith("shared.") &&
    !id.startsWith("embedding.") &&
    !id.startsWith("diagnostics.") &&
    // A ranker instruction is plain English text: rankers (and the Decisions API) get no language instruction.
    id !== "topic.gate.instruction" &&
    id !== "topic.overview.support" &&
    id !== "relations.decide.instruction" &&
    id !== "relations.decisions.instruction" &&
    !id.endsWith(".guidance") &&
    !id.endsWith(".advanced") &&
    !id.includes(".validation.")
  )
    definition.fragmentIds.push("shared.output_language");
  if (
    definition.task !== "embedding" &&
    definition.task !== "fragment" &&
    !id.endsWith(".guidance") &&
    !id.endsWith(".advanced") &&
    !id.includes(".validation.")
  )
    definition.providerFragments.push({
      id: "shared.codex_adapter_instruction",
      provider: "openai-codex"
    });
  const additional: Record<string, string[]> = {
    "consultation.answer": ["consultation.guidance", "consultation.advanced"],
    "consultation.knowledge": [
      "consultation.guidance",
      "consultation.advanced",
      "consultation.comparison",
      "consultation.investigation",
      "consultation.gaps",
      "consultation.repair"
    ],
    "sources.decide": ["sources.validation.default", "sources.validation.same_root"],
    // F3's per-pair judge (`source-relations-v5`), kept as the judge mode `perPair` (F4 D21).
    "sources.decide.pair": ["sources.validation.pair", "sources.validation.same_root"]
  };
  definition.fragmentIds.push(...(additional[id] ?? []));
  if (id.endsWith(".repair") && id !== "notes.repair")
    definition.fragmentIds.push(
      id === "consultation.repair" ? "consultation.answer" : id.slice(0, -7)
    );
}

/** A candidate revision of a catalog prompt: its editable body, never a default (plan decision 29). */
export interface PromptCandidate {
  id: string;
  revisionId: string;
  fields: { body: string };
}

/** The catalog's candidate revisions, each held to its prompt's variables and output contract. */
export const promptCandidates: readonly PromptCandidate[] = candidatePromptBodies.map((row) => {
  const body = promptDefinition(row.id).fields.find((field) => field.id === "body")!;
  const used = new Set(
    parsePromptTemplate(row.template)
      .filter((token) => token.kind === "variable")
      .map((token) => token.text)
  );
  if (
    !row.revisionId.startsWith("candidate-") ||
    used.size !== body.variableKeys.length ||
    body.variableKeys.some((key) => !used.has(key)) ||
    body.requiredContractIds.some((contract) => !used.has(contract))
  )
    throw new Error(`The candidate ${row.revisionId} of ${row.id} changes its prompt's variables.`);
  return { id: row.id, revisionId: row.revisionId, fields: { body: row.template } };
});

/** One candidate revision; an unknown one is refused. */
export function promptCandidate(id: string, revisionId: string): PromptCandidate {
  const found = promptCandidates.find(
    (candidate) => candidate.id === id && candidate.revisionId === revisionId
  );
  if (!found) throw new Error("prompts.errors.unknown");
  return found;
}
