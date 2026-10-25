// The prompts of the Topic Tree Engine (F2 T18): topic names, the repair that re-asks only the
// rejected topics, the Areas grouping (T24 calls it) and the placement gate's ranker instruction
// (T23) and the overview with its support check (T31). Every prompt lives in the catalog
// (`rules/ai.md`); these builders only supply declared, bounded data. Prompts are a function of
// content, never of IDs (D22): the data they receive is already in content-key order and carries
// aliases, not IDs.
import {
  TopicOverviewOutputSchema,
  TopicOverviewPatchOutputSchema,
  overviewPatchCitedExcerpt,
  topicOverviewLimits,
  type AiOutputContract
} from "@app/domain";
import { NamingItemSchema, namingPromptGroups, parseModelJson } from "@app/domain/topic-tree";
import type { NamingCall, TopicNamingConfig } from "@app/domain/topic-tree";
import { z } from "zod";

import { topicNameOperation, topicOverviewOperation } from "../ai-task-parameters.js";
import { joinPrompts, renderPrompt } from "../prompt-runtime.js";

export { topicNameOperation, topicOverviewOperation };

export const topicNamePromptVersion = "topic-name-v2";
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

/**
 * The one repair of an Areas answer that code could not mend: the grouping prompt followed by what
 * was wrong with the answer (aliases and counts, never IDs) and the language the titles stay in.
 */
export function buildTopicAreasRepairPrompt(
  prompt: string,
  contentLanguage: string,
  validationErrors: string
): string {
  return joinPrompts(
    prompt,
    "\n\n",
    renderPrompt("topic.areas.repair", {
      content_language: contentLanguage,
      validation_errors: validationErrors
    })
  );
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

/**
 * The contracts the topic tree's structured calls state (F4 D23). The service derives the schema each
 * runtime is sent: the overview and the Areas grouping qualify for a strict one; the naming answer
 * (an optional `aliases` member) is sent a remote provider in strict terms (owner, 10-25), where
 * `aliases` is required and empty when the subject has no other name (the validation reads a
 * missing list as empty), and keeps the contract's own grammar on a local runtime.
 */
export const topicNamingOutputContract: AiOutputContract = {
  name: "topic_naming",
  contract: z.object({ topics: z.array(NamingItemSchema) }),
  strictContract: z.object({
    topics: z.array(NamingItemSchema.extend({ aliases: z.array(z.string()) }))
  })
};
export const topicAreasOutputContract: AiOutputContract = {
  name: "topic_areas",
  contract: TopicAreasOutputSchema
};
export const topicOverviewOutputContract: AiOutputContract = {
  name: "topic_overview",
  contract: TopicOverviewOutputSchema
};
/** REFRESH's additive patch (F4 D17): strict, every member required. */
export const topicOverviewPatchOutputContract: AiOutputContract = {
  name: "topic_overview_patch",
  contract: TopicOverviewPatchOutputSchema
};

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

// ---------------------------------------------------------------------------
// The overview (T31)

/** The version of the overview contract stored with every overview (with the catalog's revision). */
export const topicOverviewPromptVersion = "topic-overview-v1";

/** One evidence item as the prompt shows it; its number (E1..En) is its position. */
export interface TopicOverviewPromptEvidence {
  title: string;
  idea: string;
  /** The title of the source the passage comes from. */
  source: string;
  /** The note's whole primary passage: never cut (the evidence budget takes whole items). */
  passage: string;
}

export interface TopicOverviewPromptInput {
  /** The library's content language as configured (`pt-BR`); the renderer writes its full name. */
  contentLanguage: string;
  topic: { title: string | null; description: string | null };
  /** In evidence order (`orderOverviewCandidates`): content, never IDs. */
  evidence: readonly TopicOverviewPromptEvidence[];
}

/** The overview prompt: the topic and its numbered evidence, nothing that names an ID. */
export function buildTopicOverviewPrompt(input: TopicOverviewPromptInput): string {
  return renderPrompt("topic.overview", {
    content_language: input.contentLanguage,
    max_paragraphs: topicOverviewLimits.maxParagraphs,
    topic: {
      title: input.topic.title,
      ...(input.topic.description === null ? {} : { description: input.topic.description })
    },
    evidence: input.evidence.map((item, index) => ({
      n: index + 1,
      title: item.title,
      idea: item.idea,
      source: item.source,
      passage: item.passage
    }))
  });
}

/** One bounded repair: the first prompt followed by what was wrong with the answer. */
export function buildTopicOverviewRepairPrompt(prompt: string, validationErrors: string): string {
  return joinPrompts(
    prompt,
    "\n\n",
    renderPrompt("topic.overview.repair", { validation_errors: validationErrors })
  );
}

/** The version of the patch contract stored with a patched overview (with the catalog's revision). */
export const topicOverviewPatchPromptVersion = "topic-overview-patch-v1";

export interface TopicOverviewPatchPromptInput {
  /** The library's content language as configured (`pt-BR`); the renderer writes its full name. */
  contentLanguage: string;
  topic: { title: string | null; description: string | null };
  /** The stored paragraphs as stored (they stay byte-identical); their markers cite E1..Ek. */
  paragraphs: readonly string[];
  /** The stored citations E1..Ek in citation order: where each comes from and a short excerpt. */
  cited: ReadonlyArray<{ source: string; excerpt: string }>;
  /** The new evidence in evidence order (`orderOverviewCandidates`), numbered after the citations. */
  evidence: readonly TopicOverviewPromptEvidence[];
  /** New paragraphs asked for at most (`overviewPatchParagraphsMax`). */
  maxParagraphs: number;
}

/**
 * REFRESH's patch prompt (F4 D17): the topic, its stored paragraphs, the citations they make (E1..Ek)
 * and the new evidence numbered Ek+1.. Every part is content in stored or evidence order; nothing
 * names an ID.
 */
export function buildTopicOverviewPatchPrompt(input: TopicOverviewPatchPromptInput): string {
  const k = input.cited.length;
  return renderPrompt("topic.overview.patch", {
    content_language: input.contentLanguage,
    max_paragraphs: input.maxParagraphs,
    topic: {
      title: input.topic.title,
      ...(input.topic.description === null ? {} : { description: input.topic.description })
    },
    overview_paragraphs: [...input.paragraphs],
    cited_evidence: input.cited.map((item, index) => ({
      n: index + 1,
      source: item.source,
      excerpt: overviewPatchCitedExcerpt(item.excerpt)
    })),
    evidence: input.evidence.map((item, index) => ({
      n: k + index + 1,
      title: item.title,
      idea: item.idea,
      source: item.source,
      passage: item.passage
    }))
  });
}

/** The ranker instruction of the support check, rendered from the catalog. */
export function topicOverviewSupportInstruction(): string {
  return renderPrompt("topic.overview.support");
}

/** The overview answer as JSON (fenced or bare); `validateOverviewOutput` checks its meaning. */
export function parseTopicOverviewOutput(output: unknown): unknown {
  return parseModelJson(output);
}
