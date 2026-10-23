/**
 * Topic overview (`topic.overview`, repaired by `topic.overview.repair`): a few cited paragraphs written
 * from numbered evidence. The product's service needs a database, so this is its loop in a few lines
 * over its own pure functions: `parseTopicOverviewOutput`, `validateOverviewOutput` and
 * `buildTopicOverviewRepairPrompt`, one repair at most. The ranker's support check is not part of it.
 */
import {
  TopicOverviewOutputSchema,
  topicOverviewLimits,
  validateOverviewOutput
} from "@app/domain";

import { topicOverviewOperation } from "../../../apps/desktop/src/main/services/ai-task-parameters.js";
import {
  buildTopicOverviewPrompt,
  buildTopicOverviewRepairPrompt,
  parseTopicOverviewOutput
} from "../../../apps/desktop/src/main/services/topic-tree/topic-prompts.js";
import { errorCode, intersectionSize, isRecord, share } from "./text.ts";
import type { Digest, FlowOutcome, Prepared, ReplayCaller, YieldMetrics } from "./types.ts";
import type { RecordedCall } from "../replay-cassette.ts";

export const overviewAnswerContract = {
  name: "topic_overview",
  contract: TopicOverviewOutputSchema
} as const;

const firstPromptStart = "Write a short overview of one topic of a personal knowledge library";
const repairMarker = "\n\nThe overview you wrote above was rejected.";

interface EvidenceItem {
  n: number;
  title: string;
  idea: string;
  source: string;
  passage: string;
}

function digestOfValidated(overview: { paragraphs: unknown[]; cited: number[] }): Digest {
  return {
    paragraphs: overview.paragraphs.length,
    evidence: [...new Set(overview.cited.map(String))].sort()
  };
}

function compare(local: Digest, recorded: Digest): YieldMetrics {
  const evidence = recorded.evidence as string[];
  return {
    paragraphRatio: (local.paragraphs as number) / Math.max(1, recorded.paragraphs as number),
    evidenceOverlap: share(intersectionSize(local.evidence as string[], evidence), evidence.length)
  };
}

export function prepareOverview(
  call: RecordedCall,
  split: { language: string; body: string }
): Prepared | null {
  if (call.taskType !== "structured-output") return null;
  const { body, language } = split;
  if (!body.startsWith(firstPromptStart)) return null;
  if (body.includes(repairMarker)) return { kind: "recorded_repair", contract: "overview" };
  const topicAt = body.indexOf("\nTopic:\n");
  const evidenceAt = body.indexOf("\nEvidence:\n", topicAt);
  if (topicAt < 0 || evidenceAt < 0)
    return { kind: "unreconstructable", contract: "overview", reason: "no_topic_or_evidence" };
  let topic: { title?: string | null; description?: string | null };
  let evidence: EvidenceItem[];
  try {
    topic = JSON.parse(body.slice(topicAt + "\nTopic:\n".length, evidenceAt)) as typeof topic;
    evidence = JSON.parse(body.slice(evidenceAt + "\nEvidence:\n".length)) as EvidenceItem[];
  } catch {
    return { kind: "unreconstructable", contract: "overview", reason: "inputs_not_parsed" };
  }
  if (!isRecord(topic) || !Array.isArray(evidence) || evidence.length === 0)
    return { kind: "unreconstructable", contract: "overview", reason: "inputs_not_parsed" };
  const current = buildTopicOverviewPrompt({
    contentLanguage: language,
    topic: { title: topic.title ?? null, description: topic.description ?? null },
    evidence: evidence.map((item) => ({
      title: item.title,
      idea: item.idea,
      source: item.source,
      passage: item.passage
    }))
  });
  const tail = (text: string) => text.slice(text.indexOf("\nTopic:\n"));
  if (tail(current) !== tail(body))
    return {
      kind: "unreconstructable",
      contract: "overview",
      reason: "inputs_differ_when_rebuilt"
    };
  const count = evidence.length;
  const read = (output: string) => validateOverviewOutput(parseTopicOverviewOutput(output), count);
  return {
    kind: "item",
    item: {
      contract: "overview",
      fidelity: "product-pure",
      taskType: "structured-output",
      operation: topicOverviewOperation,
      language,
      body,
      current,
      answerContract: overviewAnswerContract,
      digestOf(output) {
        const checked = read(output);
        return checked.ok ? digestOfValidated(checked.overview) : null;
      },
      compare,
      async run(caller: ReplayCaller, prompts): Promise<FlowOutcome> {
        const first = prompts === "recorded" ? body : current;
        const ask = (prompt: string, attempt: number) =>
          caller({
            contract: "overview",
            taskType: "structured-output",
            prompt,
            language,
            operation: topicOverviewOperation,
            attempt,
            isRepair: attempt > 0,
            maxOutputTokens: topicOverviewLimits.maxOutputTokens,
            answerContract: overviewAnswerContract
          });
        try {
          let validation = read((await ask(first, 0)).output);
          if (!validation.ok) {
            const again = await ask(
              buildTopicOverviewRepairPrompt(first, validation.errors.join("\n")),
              1
            );
            validation = read(again.output);
          }
          return validation.ok
            ? {
                ok: true,
                error: null,
                digest: digestOfValidated(validation.overview),
                salvagedItems: 0
              }
            : { ok: false, error: "overview_invalid", digest: null, salvagedItems: 0 };
        } catch (error) {
          return { ok: false, error: errorCode(error), digest: null, salvagedItems: 0 };
        }
      }
    }
  };
}
