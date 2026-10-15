// The prompts of the Topic Tree Engine (F2 T18): topic names, the repair that re-asks only the
// rejected topics, the Areas grouping (T24 calls it) and the placement gate's ranker instruction
// (T23). Every prompt lives in the catalog (`rules/ai.md`); these builders only supply declared,
// bounded data. Prompts are a function of content, never of IDs (D22): the data they receive is
// already in content-key order and carries aliases, not IDs.
import { namingPromptGroups, parseModelJson } from "@app/domain/topic-tree";
import type { NamingCall, TopicNamingConfig } from "@app/domain/topic-tree";
import { z } from "zod";

import { topicNameOperation } from "../ai-task-parameters.js";
import { joinPrompts, renderPrompt } from "../prompt-runtime.js";

export { topicNameOperation };

export const topicNamePromptVersion = "topic-name-v1";
export const topicAreasPromptVersion = "topic-areas-v1";

// The naming operation (`op:topic_name` may route it; `class:write-fast` is the default) is declared
// beside the other operations that change a task's parameter defaults.
/** The AI operation of the Areas call. */
export const topicAreasOperation = "topic_areas";
/** The AI operation of label embeddings. */
export const topicLabelOperation = "topic_label_embedding";

export interface TopicNamePromptInput {
  /** The library's content language as configured (`pt-BR`); the renderer writes its full name. */
  contentLanguage: string;
  config: TopicNamingConfig;
}

/** The naming prompt for one call: groups of sibling topics with their central notes. */
export function buildTopicNamePrompt(call: NamingCall, input: TopicNamePromptInput): string {
  return renderPrompt("topic.name", {
    content_language: input.contentLanguage,
    title_max_chars: input.config.titleMaxChars,
    description_max_chars: input.config.descriptionMaxChars,
    max_aliases: input.config.maxAliases,
    topics: namingPromptGroups(call)
  });
}

/** The same prompt for the rejected topics, with what was wrong with each answer. */
export function buildTopicNameRepairPrompt(
  retry: NamingCall,
  input: TopicNamePromptInput,
  validationErrors: string
): string {
  return joinPrompts(
    buildTopicNamePrompt(retry, input),
    "\n\n",
    renderPrompt("topic.name.repair", { validation_errors: validationErrors })
  );
}

// ---------------------------------------------------------------------------
// Areas (T24 calls this; the grouping is validated in code, D12)

export interface TopicAreasPromptInput {
  contentLanguage: string;
  /** Typed configuration `areas.target`, `areas.min`, `areas.max`. */
  areas: { target: number; min: number; max: number };
  /** Pinned Areas, which stay fixed: an alias (`A1`..) for the answer to refer to. */
  pinned: ReadonlyArray<{ alias: string; title: string; description: string | null }>;
  /** Level-2 topics in content-key order, each with a few central note titles. */
  topics: ReadonlyArray<{ alias: string; titles: readonly string[] }>;
}

export function buildTopicAreasPrompt(input: TopicAreasPromptInput): string {
  return renderPrompt("topic.areas", {
    content_language: input.contentLanguage,
    areas_target: input.areas.target,
    areas_min: input.areas.min,
    areas_max: input.areas.max,
    pinned_areas: input.pinned.map((area) => ({
      alias: area.alias,
      title: area.title,
      ...(area.description === null ? {} : { description: area.description })
    })),
    area_topics: input.topics.map((topic) => ({ alias: topic.alias, titles: [...topic.titles] }))
  });
}

/** The wire contract of the Areas answer: a pinned Area to add to, or a new Area, with members. */
export const TopicAreasOutputSchema = z.object({
  areas: z.array(
    z.union([
      z.object({ alias: z.string().min(1), members: z.array(z.string().min(1)) }),
      z.object({
        new: z.object({ title: z.string().min(1), description: z.string().min(1) }),
        members: z.array(z.string().min(1))
      })
    ])
  )
});
export type TopicAreasOutput = z.output<typeof TopicAreasOutputSchema>;

/** The shape of an Areas answer; T24 validates its meaning (every topic once, size bounds). */
export function parseTopicAreasOutput(output: unknown): TopicAreasOutput {
  return TopicAreasOutputSchema.parse(parseModelJson(output));
}

// ---------------------------------------------------------------------------
// The gate (T23)

/** The ranker instruction of the placement gate (F2 D10), rendered from the catalog. */
export function topicGateInstruction(): string {
  return renderPrompt("topic.gate.instruction");
}
