/**
 * Test fixtures of the prompt-replay harness (F4 T69): prompts built by the product's own builders,
 * recorded calls around them, and a cassette folder in the format `packages/ai/src/cassette.ts` writes.
 * Synthetic text only; no library content.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultTopicTreeConfig, type NamingCall } from "@app/domain/topic-tree";

import { buildRelationTypingPrompt } from "../../apps/desktop/src/main/services/relations/relation-typing.js";
import {
  buildAtomicNoteGenerationPrompt,
  buildKnowledgeGraphPrompt,
  summaryPrompt
} from "../../apps/desktop/src/main/services/knowledge-processing.js";
import { buildRelationMatchPrompt } from "../../apps/desktop/src/main/services/relation-type-resolution.js";
import {
  buildTopicNamePrompt,
  buildTopicOverviewPrompt
} from "../../apps/desktop/src/main/services/topic-tree/topic-prompts.js";
import { composeInput, type RecordedCall } from "./replay-cassette.ts";

export const chunkIds = [
  "0f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b",
  "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "2b3c4d5e-6f70-4b8c-9d0e-1f2a3b4c5d6e"
];

export function notesBody(title = "Spaced practice"): string {
  return buildAtomicNoteGenerationPrompt({ title, language: "en" }, [
    {
      id: chunkIds[0]!,
      content: "Practice spread over days improves recall.\n\nIt beats cramming."
    },
    { id: chunkIds[1]!, content: "Feedback after a test makes the next test easier." }
  ]);
}

/** A valid answer to {@link notesBody}. */
export const notesAnswer = JSON.stringify({
  notes: [
    {
      title: "Spacing helps recall",
      bodyMarkdown: "Spreading practice over days improves recall.",
      ideaStatement: "Spaced practice beats cramming.",
      language: "en",
      evidenceChunkIds: [chunkIds[0]]
    },
    {
      title: "Feedback helps tests",
      bodyMarkdown: "Feedback after a test eases the next one.",
      ideaStatement: "Feedback improves later tests.",
      language: "en",
      evidenceChunkIds: [chunkIds[1]]
    }
  ]
});

export const graphNotes = [
  {
    id: "00000000-0000-4000-8000-0000000000a1",
    title: "Ebbinghaus measured forgetting",
    ideaStatement: "Ebbinghaus measured how fast memory fades.",
    bodyMarkdown:
      "Ebbinghaus tested himself on nonsense syllables.\n\nHe plotted savings over time.",
    evidenceChunkIds: [chunkIds[0]!]
  },
  {
    id: "00000000-0000-4000-8000-0000000000a2",
    title: "The curve is steep at first",
    ideaStatement: "Most forgetting happens early.",
    bodyMarkdown: "The curve drops fast and then flattens.",
    evidenceChunkIds: [chunkIds[1]!, chunkIds[0]!]
  }
];

export const graphAliases = new Map([
  ["c1", chunkIds[0]!],
  ["c2", chunkIds[1]!]
]);

export function graphBody(kind: "atomic_notes" | "source_chunks" = "atomic_notes"): string {
  return buildKnowledgeGraphPrompt(
    { title: "Forgetting", language: "English" },
    graphNotes,
    graphAliases,
    kind,
    { maxEntities: 12, maxRelations: 12 }
  );
}

/** The graph prompt as an older revision worded the limits (it asked for claims too). */
export function oldGraphBody(): string {
  return graphBody().replace(
    "at most 12 entities and 12 relations",
    "at most 12 entities, 8 claims, and 12 relations"
  );
}

const entity = (key: string, name: string) => ({
  key,
  type: "Concept",
  identityDescription: "Insufficient identifying context.",
  canonicalName: name,
  aliases: [],
  confidence: 0.9,
  evidenceChunkIds: ["c1"]
});
const relation = (subject: string, object: string, predicate = "measures") => ({
  subjectEntityKey: subject,
  predicate,
  displayLabel: "measures",
  definition: "The subject measures the object.",
  objectEntityKey: object,
  confidence: 0.9,
  evidenceChunkIds: ["c1"]
});

export const graphAnswer = JSON.stringify({
  entities: [entity("e1", "Ebbinghaus"), entity("e2", "Forgetting curve")],
  relations: [relation("e1", "e2")]
});

/** An answer whose second relation points at an entity that is not there. */
export const graphAnswerWithBadRelation = JSON.stringify({
  entities: [entity("e1", "Ebbinghaus"), entity("e2", "Forgetting curve")],
  relations: [relation("e1", "e2"), relation("e1", "e9")]
});

export const confirmationRows = [
  {
    key: "r1",
    predicate: "Concept: Forgetting curve",
    definition: "How memory fades.",
    candidates: [
      { key: "c1", predicate: "Concept: Curve of forgetting", definition: "Memory fading." }
    ]
  },
  {
    key: "r2",
    predicate: "Person: Ebbinghaus",
    definition: "A psychologist.",
    candidates: [
      { key: "c2", predicate: "Person: H. Ebbinghaus", definition: "German psychologist." },
      { key: "c3", predicate: "Person: Ebbinghaus Jr.", definition: "A different person." }
    ]
  }
];

export function confirmationBody(entityIdentity = true): string {
  return buildRelationMatchPrompt(confirmationRows, entityIdentity);
}

export const overviewEvidence = [
  {
    title: "Spacing",
    idea: "Spacing helps.",
    source: "Study A",
    passage: "Spaced practice improved recall."
  },
  {
    title: "Feedback",
    idea: "Feedback helps.",
    source: "Study B",
    passage: "Feedback improved later tests."
  }
];

export function overviewBody(language = "en"): string {
  return buildTopicOverviewPrompt({
    contentLanguage: language,
    topic: { title: "Learning", description: null },
    evidence: overviewEvidence
  });
}

export const overviewAnswer = JSON.stringify({
  paragraphs: [
    { text: "Spacing practice helps recall [1].", citations: [1] },
    { text: "Feedback improves later tests [2].", citations: [2] }
  ]
});

export const namingCall: NamingCall = {
  groups: [
    {
      parentId: "00000000-0000-4000-8000-0000000000b0",
      parentTitle: "Memory",
      namedSiblings: ["Sleep"],
      topics: [
        {
          topicId: "00000000-0000-4000-8000-0000000000b1",
          alias: "T1",
          size: 2,
          members: [
            {
              key: "n1" as never,
              kind: "note",
              title: "Spacing helps",
              idea: "Spacing improves recall.",
              rootSource: null
            },
            {
              key: "n2" as never,
              kind: "note",
              title: "Cramming fails",
              idea: "Cramming fades fast.",
              rootSource: null
            }
          ],
          subtopics: [],
          childTitles: [],
          currentTitle: null
        },
        {
          topicId: "00000000-0000-4000-8000-0000000000b2",
          alias: "T2",
          size: 1,
          members: [
            {
              key: "n3" as never,
              kind: "note",
              title: "Feedback",
              idea: "Feedback helps tests.",
              rootSource: null
            }
          ],
          subtopics: [],
          childTitles: [],
          currentTitle: null
        }
      ]
    }
  ]
};

export function namesBody(language = "en"): string {
  return buildTopicNamePrompt(namingCall, {
    contentLanguage: language,
    config: defaultTopicTreeConfig.naming
  });
}

const nameItem = (alias: string, title: string) => ({
  alias,
  title,
  description: "A sentence about the topic.",
  aliases: [],
  language: "en"
});
export const namesAnswer = JSON.stringify({
  topics: [nameItem("T1", "Spaced practice"), nameItem("T2", "Test feedback")]
});

export function typingBody(): string {
  const note = (text: string) => ({ id: text, text, hash: text });
  const item = (alias: string, a: string, b: string) => ({
    alias,
    pair: { pairKey: alias, lo: note(a), hi: note(b), a: note(a), b: note(b), band: "accept" }
  });
  return buildRelationTypingPrompt([
    item("p1", "Spacing helps recall.", "Cramming fades fast.") as never,
    item("p2", "Feedback helps tests.", "Tests need feedback.") as never
  ]);
}

export const typingAnswer = JSON.stringify({
  pairs: [
    { p: "p1", t: "contradicts", d: "both" },
    { p: "p2", t: "same_as", d: "both" }
  ]
});

export function summaryBody(): string {
  return summaryPrompt(
    [
      { id: "x1", content: "Practice spread over days improves recall." },
      { id: "x2", content: "Feedback makes the next test easier." }
    ],
    false
  );
}

export const summaryAnswer = JSON.stringify({
  summary: "Spread practice and feedback improve recall.",
  concepts: [{ idea: "Spacing improves recall.", evidenceChunkIds: ["c1"] }]
});

let counter = 0;

/** A recorded remote call around a prompt body, as `readCassette` would return it. */
export function recorded(input: {
  taskType: string;
  body: string;
  output: string;
  language?: string;
  recordedAt?: string;
  inputTokens?: number;
  outputTokens?: number;
}): RecordedCall {
  counter += 1;
  const text = composeInput(input.body, input.language ?? "en");
  return {
    key: createHash("sha256").update(`${counter}:${text}`).digest("hex"),
    taskType: input.taskType,
    input: text,
    parameters: { contextWindow: 128_000, reasoningLevel: "low" },
    output: input.output,
    providerId: "openai-codex",
    modelId: "gpt-5.6-luna",
    runtime: "remote",
    durationMs: 3_000,
    inputTokens: input.inputTokens ?? 1_000,
    outputTokens: input.outputTokens ?? 300,
    recordedAt: input.recordedAt ?? new Date(2026, 9, 14, 12, 0, counter).toISOString(),
    responses: 1
  };
}

/** Writes a cassette folder (`cassette.json`, sharded `entries/`) holding the given calls. */
export async function writeCassette(
  directory: string,
  calls: ReadonlyArray<RecordedCall & { rawInput?: string }>
): Promise<void> {
  await mkdir(join(directory, "entries"), { recursive: true });
  await writeFile(
    join(directory, "cassette.json"),
    JSON.stringify({
      format: "memora-ai-cassette",
      version: 1,
      createdAt: "2026-10-14T00:00:00.000Z"
    })
  );
  for (const call of calls) {
    const shard = join(directory, "entries", call.key.slice(0, 2));
    await mkdir(shard, { recursive: true });
    await writeFile(
      join(shard, `${call.key}.json`),
      JSON.stringify({
        format: "memora-ai-cassette-entry",
        version: 1,
        key: call.key,
        taskType: call.taskType,
        request: {
          version: 1,
          taskType: call.taskType,
          model: { providerId: call.providerId, modelId: call.modelId, runtime: call.runtime },
          parameters: call.parameters,
          input: call.rawInput ?? call.input,
          instruction: "You are a helpful assistant.",
          schema: null
        },
        responses: [
          {
            output: call.output,
            providerId: call.providerId,
            modelId: call.modelId,
            runtime: call.runtime,
            durationMs: call.durationMs,
            ...(call.inputTokens !== undefined ? { inputTokens: call.inputTokens } : {}),
            ...(call.outputTokens !== undefined ? { outputTokens: call.outputTokens } : {}),
            recordedAt: call.recordedAt
          }
        ]
      })
    );
  }
}

/** One of each contract, in a believable recorded order. */
export function everyContract(): RecordedCall[] {
  return [
    recorded({ taskType: "summarization", body: summaryBody(), output: summaryAnswer }),
    recorded({ taskType: "atomic-note-generation", body: notesBody(), output: notesAnswer }),
    recorded({ taskType: "knowledge-graph-generation", body: graphBody(), output: graphAnswer }),
    recorded({
      taskType: "knowledge-graph-generation",
      body: confirmationBody(),
      output: JSON.stringify({
        matches: [
          ["r1", "c1"],
          ["r2", null]
        ]
      })
    }),
    recorded({ taskType: "structured-output", body: namesBody(), output: namesAnswer }),
    recorded({ taskType: "structured-output", body: overviewBody(), output: overviewAnswer }),
    recorded({ taskType: "structured-output", body: typingBody(), output: typingAnswer })
  ];
}
