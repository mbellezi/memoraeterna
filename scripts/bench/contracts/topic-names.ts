/**
 * Topic names (`topic.name`, repaired by `topic.name.repair`): the naming service needs a database and
 * the tree, so this is its `nameCall` loop over its own pure functions: `validateNamingOutput`,
 * `retryCall`, `describeRejections` and `buildTopicNameRepairPrompt`, with the rejected topics asked
 * again up to `naming.repairAttempts` times. The call is put back from the JSON the prompt shows.
 */
import { z } from "zod";
import {
  defaultTopicTreeConfig,
  describeRejections,
  namingCallTopics,
  namingPromptGroups,
  retryCall,
  validateNamingOutput,
  type NamingCall,
  type NamingGroup,
  type NamingMember,
  type NamingTopic,
  type NamingValidation
} from "@app/domain/topic-tree";

import { topicNameOperation } from "../../../apps/desktop/src/main/services/ai-task-parameters.js";
import {
  buildTopicNamePrompt,
  buildTopicNameRepairPrompt
} from "../../../apps/desktop/src/main/services/topic-tree/topic-prompts.js";
import { topicNamingLimits } from "../../../apps/desktop/src/main/services/topic-tree/topic-naming.js";
import { errorCode, normalizeName, share, wordOverlap } from "./text.ts";
import type { Digest, FlowOutcome, Prepared, ReplayCaller, YieldMetrics } from "./types.ts";
import { syntheticId, type RecordedCall } from "../replay-cassette.ts";

const firstPromptStart = "Name the numbered topics of a personal knowledge library";
const repairMarker = "\n\nThe answer you gave for the topics above was rejected.";

const answerShape = z.object({
  topics: z.array(
    z.object({
      alias: z.string(),
      title: z.string(),
      description: z.string(),
      aliases: z.array(z.string()).optional(),
      language: z.string()
    })
  )
});
export const topicNamesAnswerContract = { name: "topic_names", contract: answerShape } as const;

interface PromptNote {
  title: string;
  idea?: string;
}
interface PromptTopic {
  alias: string;
  current_title?: string;
  size: number;
  subtopics?: Array<{ title: string | null; size: number; notes?: PromptNote[] }>;
  notes?: PromptNote[];
}
interface PromptGroup {
  parent: string | null;
  named_siblings: string[];
  topics: PromptTopic[];
}

function members(notes: readonly PromptNote[] | undefined, seed: string): NamingMember[] {
  return (notes ?? []).map((note, index) => ({
    key: `${seed}:${index}` as NamingMember["key"],
    kind: "note" as const,
    title: note.title,
    idea: note.idea ?? null,
    rootSource: null
  }));
}

/** The call a `topics` block shows: its groups, topics, subtopics and the notes of each. */
export function namingCallOf(groups: readonly PromptGroup[]): NamingCall {
  return {
    groups: groups.map((group, groupIndex): NamingGroup => ({
      parentId: syntheticId(300_000 + groupIndex),
      parentTitle: group.parent,
      namedSiblings: [...group.named_siblings],
      topics: group.topics.map((topic): NamingTopic => {
        const subtopics = (topic.subtopics ?? []).map((subtopic, index) => ({
          title: subtopic.title,
          size: subtopic.size,
          members: members(subtopic.notes, `${topic.alias}:s${index}`)
        }));
        return {
          topicId: syntheticId(400_000 + Number(topic.alias.replace(/\D+/gu, ""))),
          alias: topic.alias,
          size: topic.size,
          members: members(topic.notes, topic.alias),
          subtopics,
          childTitles: subtopics.flatMap((subtopic) =>
            subtopic.title === null ? [] : [subtopic.title]
          ),
          currentTitle: topic.current_title ?? null
        };
      })
    }))
  };
}

function digestOfValidation(validation: NamingValidation): Digest {
  return {
    titles: Object.fromEntries(
      [...validation.accepted]
        .sort((a, b) => a.alias.localeCompare(b.alias))
        .map((name) => [name.alias, normalizeName(name.title)])
    ),
    rejected: validation.rejected.length
  };
}

function compare(local: Digest, recorded: Digest): YieldMetrics {
  const mine = local.titles as Record<string, string>;
  const theirs = recorded.titles as Record<string, string>;
  const aliases = Object.keys(theirs);
  const named = aliases.filter((alias) => mine[alias] !== undefined);
  return {
    namedShare: share(named.length, aliases.length),
    exactTitle: share(
      named.filter((alias) => mine[alias] === theirs[alias]).length,
      aliases.length
    ),
    titleOverlap:
      aliases.length === 0
        ? 1
        : named.reduce((sum, alias) => sum + wordOverlap(mine[alias]!, theirs[alias]!), 0) /
          aliases.length
  };
}

export function prepareTopicNames(
  call: RecordedCall,
  split: { language: string; body: string }
): Prepared | null {
  if (call.taskType !== "structured-output") return null;
  const { body, language } = split;
  if (!body.startsWith(firstPromptStart)) return null;
  if (body.includes(repairMarker)) return { kind: "recorded_repair", contract: "topic-names" };
  const topicsAt = body.lastIndexOf("\nTopics:\n");
  if (topicsAt < 0)
    return { kind: "unreconstructable", contract: "topic-names", reason: "no_topics_block" };
  const json = body.slice(topicsAt + "\nTopics:\n".length);
  let groups: PromptGroup[];
  try {
    groups = JSON.parse(json) as PromptGroup[];
  } catch {
    return { kind: "unreconstructable", contract: "topic-names", reason: "topics_not_parsed" };
  }
  if (!Array.isArray(groups) || groups.length === 0)
    return { kind: "unreconstructable", contract: "topic-names", reason: "topics_not_parsed" };
  const naming = defaultTopicTreeConfig.naming;
  const promptInput = { contentLanguage: language, config: naming };
  const namingCall = namingCallOf(groups);
  if (JSON.stringify(namingPromptGroups(namingCall)) !== JSON.stringify(groups))
    return {
      kind: "unreconstructable",
      contract: "topic-names",
      reason: "inputs_differ_when_rebuilt"
    };
  const current = buildTopicNamePrompt(namingCall, promptInput);
  const context = { contentLanguage: language, config: naming };
  const limitFor = (call: NamingCall) =>
    topicNamingLimits.outputTokensBase +
    topicNamingLimits.outputTokensPerTopic * namingCallTopics(call).length;
  return {
    kind: "item",
    item: {
      contract: "topic-names",
      fidelity: "product-pure",
      taskType: "structured-output",
      operation: topicNameOperation,
      language,
      body,
      current,
      answerContract: topicNamesAnswerContract,
      digestOf: (output) => digestOfValidation(validateNamingOutput(output, namingCall, context)),
      compare,
      async run(caller: ReplayCaller, prompts): Promise<FlowOutcome> {
        const ask = (asked: NamingCall, prompt: string, attempt: number) =>
          caller({
            contract: "topic-names",
            taskType: "structured-output",
            prompt,
            language,
            operation: topicNameOperation,
            attempt,
            isRepair: attempt > 0,
            maxOutputTokens: limitFor(asked),
            answerContract: topicNamesAnswerContract
          });
        try {
          const first = await ask(namingCall, prompts === "recorded" ? body : current, 0);
          let validation = validateNamingOutput(first.output, namingCall, context);
          for (
            let attempt = 1;
            attempt <= naming.repairAttempts && validation.rejected.length > 0;
            attempt += 1
          ) {
            const retry = retryCall(namingCall, validation);
            if (!retry) break;
            const prompt = buildTopicNameRepairPrompt(
              retry,
              promptInput,
              describeRejections(validation.rejected, retry, language)
            );
            const again = await ask(retry, prompt, attempt);
            const second = validateNamingOutput(again.output, retry, context);
            validation = {
              accepted: [...validation.accepted, ...second.accepted],
              rejected: second.rejected
            };
          }
          return {
            ok: validation.rejected.length === 0,
            error: validation.rejected.length === 0 ? null : "naming_rejected",
            digest: digestOfValidation(validation),
            salvagedItems: 0
          };
        } catch (error) {
          return { ok: false, error: errorCode(error), digest: null, salvagedItems: 0 };
        }
      }
    }
  };
}
