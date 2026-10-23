/**
 * Relation typing (`relations.type`, re-asked by `relations.type.repair`): a type and a direction for up
 * to 24 pairs of notes. The typer needs a database for its cache and counters, so this is the loop of
 * its `typeBatch` over its own pure functions: `validateRelationTypingAnswer`,
 * `buildRelationTypingRepairPrompt` and the typing limits, with the pairs still unanswered asked again
 * up to `attemptsPerBatch` times. The batch is put back from the `relation_pairs` JSON the prompt shows.
 */
import {
  relationTypingLimits,
  relationTypingOutputSchema,
  validateRelationTypingAnswer,
  type RelationTypingProblem
} from "@app/domain";

import {
  relationTypingOperation,
  relationTypingRepairOperation
} from "../../../apps/desktop/src/main/services/ai-task-parameters.js";
import {
  buildRelationTypingPrompt,
  buildRelationTypingRepairPrompt,
  type TypingBatchItem
} from "../../../apps/desktop/src/main/services/relations/relation-typing.js";
import { errorCode, share } from "./text.ts";
import type { Digest, FlowOutcome, Prepared, ReplayCaller, YieldMetrics } from "./types.ts";
import type { RecordedCall } from "../replay-cassette.ts";

const firstPromptStart = "Classify how each pair of atomic notes is related";
const repairMarker = "\n\nThe previous answer was missing or invalid for some of the pairs";

interface PromptPair {
  p: string;
  a: string;
  b: string;
}

/** A batch item with only what the prompts read: the id and the two note texts. */
function batchItem(pair: PromptPair): TypingBatchItem {
  const note = (text: string) => ({ id: pair.p, text, hash: pair.p });
  return {
    alias: pair.p,
    pair: {
      pairKey: pair.p,
      lo: note(pair.a),
      hi: note(pair.b),
      a: note(pair.a),
      b: note(pair.b),
      band: "accept"
    } as unknown as TypingBatchItem["pair"]
  };
}

function digestOfAccepted(
  accepted: ReadonlyMap<string, { type: string; direction: string }>
): Digest {
  return {
    verdicts: Object.fromEntries(
      [...accepted]
        .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
        .map(([alias, item]) => [alias, `${item.type}/${item.direction}`])
    )
  };
}

function compare(local: Digest, recorded: Digest): YieldMetrics {
  const mine = local.verdicts as Record<string, string>;
  const theirs = recorded.verdicts as Record<string, string>;
  const aliases = Object.keys(theirs);
  const typeOf = (verdict: string | undefined) => verdict?.split("/")[0];
  return {
    answeredShare: share(
      aliases.filter((alias) => mine[alias] !== undefined).length,
      aliases.length
    ),
    typeAgreement: share(
      aliases.filter((alias) => typeOf(mine[alias]) === typeOf(theirs[alias])).length,
      aliases.length
    ),
    verdictAgreement: share(
      aliases.filter((alias) => mine[alias] === theirs[alias]).length,
      aliases.length
    )
  };
}

export function prepareTyping(
  call: RecordedCall,
  split: { language: string; body: string }
): Prepared | null {
  if (call.taskType !== "structured-output") return null;
  const { body, language } = split;
  if (!body.startsWith(firstPromptStart)) return null;
  if (body.includes(repairMarker)) return { kind: "recorded_repair", contract: "typing" };
  const pairsAt = body.lastIndexOf("\nPAIRS:\n");
  if (pairsAt < 0)
    return { kind: "unreconstructable", contract: "typing", reason: "no_pairs_block" };
  const json = body.slice(pairsAt + "\nPAIRS:\n".length);
  let pairs: PromptPair[];
  try {
    pairs = JSON.parse(json) as PromptPair[];
  } catch {
    return { kind: "unreconstructable", contract: "typing", reason: "pairs_not_parsed" };
  }
  if (!Array.isArray(pairs) || pairs.length === 0 || pairs.some((pair) => !pair.p))
    return { kind: "unreconstructable", contract: "typing", reason: "pairs_not_parsed" };
  const batch = pairs.map(batchItem);
  const current = buildRelationTypingPrompt(batch);
  if (!current.endsWith(json))
    return { kind: "unreconstructable", contract: "typing", reason: "inputs_differ_when_rebuilt" };
  const aliases = pairs.map((pair) => pair.p);
  const answerContract = {
    name: "relation_typing",
    contract: relationTypingOutputSchema(
      Math.max(aliases.length, relationTypingLimits.pairsPerCall)
    )
  };
  const limitFor = (count: number) =>
    relationTypingLimits.outputTokensBase + relationTypingLimits.outputTokensPerPair * count;
  return {
    kind: "item",
    item: {
      contract: "typing",
      fidelity: "product-pure",
      taskType: "structured-output",
      operation: relationTypingOperation,
      language,
      body,
      current,
      answerContract,
      digestOf(output) {
        return digestOfAccepted(validateRelationTypingAnswer(output, aliases).accepted);
      },
      compare,
      async run(caller: ReplayCaller, prompts): Promise<FlowOutcome> {
        let remaining = batch;
        let problems: Map<string, RelationTypingProblem> | null = null;
        const accepted = new Map<string, { type: string; direction: string }>();
        let lastError: string | null = null;
        try {
          for (
            let attempt = 0;
            remaining.length > 0 && attempt < relationTypingLimits.attemptsPerBatch;
            attempt += 1
          ) {
            const repair = problems !== null;
            const prompt = repair
              ? buildRelationTypingRepairPrompt(remaining, problems!)
              : prompts === "recorded"
                ? body
                : current;
            let result;
            try {
              result = await caller({
                contract: "typing",
                taskType: "structured-output",
                prompt,
                language,
                operation: repair ? relationTypingRepairOperation : relationTypingOperation,
                attempt,
                isRepair: repair,
                maxOutputTokens: limitFor(remaining.length),
                answerContract
              });
            } catch (error) {
              // A failed call costs the attempt and the next one asks the first prompt again.
              lastError = errorCode(error);
              problems = null;
              continue;
            }
            const answer = validateRelationTypingAnswer(
              result.output,
              remaining.map((item) => item.alias)
            );
            for (const [alias, item] of answer.accepted) accepted.set(alias, item);
            remaining = remaining.filter((item) => !answer.accepted.has(item.alias));
            problems = answer.problems.size ? new Map(answer.problems) : null;
          }
          return {
            ok: remaining.length === 0,
            error: remaining.length === 0 ? null : (lastError ?? "typing_unanswered"),
            digest: digestOfAccepted(accepted),
            salvagedItems: 0
          };
        } catch (error) {
          return { ok: false, error: errorCode(error), digest: null, salvagedItems: 0 };
        }
      }
    }
  };
}
