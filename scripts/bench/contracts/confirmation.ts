/**
 * Confirmation (`graph.entity_identity`, `graph.relation_identity`): which candidate of each row is the
 * same thing. The product's own flow, `confirmMatchGroup`, runs with a service whose `runDefaultTask`
 * answers from the local writer. Its tolerant row-by-row reading and its single repair, which asks only
 * for the rows still undecided, are the product's.
 */
import {
  buildRelationMatchPrompt,
  confirmMatchGroup,
  parseRelationMatchesTolerant,
  relationMatchOutputSchema,
  type RelationMatchRow
} from "../../../apps/desktop/src/main/services/relation-type-resolution.js";
import { renderPrompt } from "../../../apps/desktop/src/main/services/prompt-runtime.js";
import { defaultTaskService } from "./flow.ts";
import { errorCode, share } from "./text.ts";
import type { Digest, FlowOutcome, Prepared, YieldMetrics } from "./types.ts";
import type { RecordedCall } from "../replay-cassette.ts";

export const confirmationAnswerContract = {
  name: "confirmation",
  contract: relationMatchOutputSchema
} as const;

const entityStart = "Match entities only when the evidence establishes";
const relationStart = "Match directed relation types only when their FULL meanings";

interface CandidatesBlock {
  relations: Array<[string, string, string, string[]]>;
  candidates: Array<[string, string, string]>;
}

/** The rows of the `candidates` JSON a confirmation prompt ends with. */
function parseRows(json: string): RelationMatchRow[] | null {
  let block: CandidatesBlock;
  try {
    block = JSON.parse(json) as CandidatesBlock;
  } catch {
    return null;
  }
  if (!Array.isArray(block.relations) || !Array.isArray(block.candidates)) return null;
  // A candidate named by a row's key is that row's provisional identity: its own line (F4 D20).
  const candidates = new Map<string, readonly [string, string, string]>([
    ...block.relations.map(
      ([key, predicate, definition]) => [key, [key, predicate, definition]] as const
    ),
    ...block.candidates.map((candidate) => [candidate[0], candidate] as const)
  ]);
  const rows: RelationMatchRow[] = [];
  for (const [key, predicate, definition, candidateKeys] of block.relations) {
    const row: RelationMatchRow = { key, predicate, definition, candidates: [] };
    for (const candidateKey of candidateKeys) {
      const candidate = candidates.get(candidateKey);
      if (!candidate) return null;
      row.candidates.push({ key: candidate[0], predicate: candidate[1], definition: candidate[2] });
    }
    rows.push(row);
  }
  return rows;
}

function compare(local: Digest, recorded: Digest): YieldMetrics {
  const mine = local.decisions as Record<string, string | null>;
  const theirs = recorded.decisions as Record<string, string | null>;
  const keys = Object.keys(theirs);
  const same = keys.filter((key) => mine[key] === theirs[key]).length;
  const merged = keys.filter((key) => mine[key] != null && theirs[key] == null).length;
  const split = keys.filter((key) => mine[key] == null && theirs[key] != null).length;
  return {
    agreement: share(same, keys.length),
    overMergeRate: merged / Math.max(1, keys.length),
    underMergeRate: split / Math.max(1, keys.length),
    decidedRatio: share(Object.keys(mine).length, keys.length)
  };
}

export function prepareConfirmation(
  call: RecordedCall,
  split: { language: string; body: string }
): Prepared | null {
  if (call.taskType !== "knowledge-graph-generation") return null;
  const { body, language } = split;
  const entityIdentity = body.startsWith(entityStart);
  if (!entityIdentity && !body.startsWith(relationStart)) return null;
  const repairFragment = renderPrompt(
    entityIdentity ? "graph.entity_identity.repair" : "graph.relation_identity.repair"
  );
  if (body.endsWith(repairFragment)) return { kind: "recorded_repair", contract: "confirmation" };
  const jsonAt = body.lastIndexOf('\n{"relations":');
  if (jsonAt < 0)
    return { kind: "unreconstructable", contract: "confirmation", reason: "no_candidates_block" };
  const json = body.slice(jsonAt + 1);
  const rows = parseRows(json);
  if (!rows || rows.length === 0)
    return { kind: "unreconstructable", contract: "confirmation", reason: "rows_not_parsed" };
  const current = buildRelationMatchPrompt(rows, entityIdentity);
  if (!current.endsWith(json))
    return {
      kind: "unreconstructable",
      contract: "confirmation",
      reason: "inputs_differ_when_rebuilt"
    };
  const decisionsOf = (decided: ReadonlyMap<string, string | null>): Digest => ({
    decisions: Object.fromEntries([...decided].sort(([a], [b]) => a.localeCompare(b)))
  });
  return {
    kind: "item",
    item: {
      contract: "confirmation",
      fidelity: "product-flow",
      taskType: "knowledge-graph-generation",
      operation: entityIdentity ? "entity_identity_resolution" : "relation_type_resolution",
      language,
      body,
      current,
      answerContract: confirmationAnswerContract,
      digestOf: (output) => decisionsOf(parseRelationMatchesTolerant(output, rows).decided),
      compare,
      async run(caller, prompts): Promise<FlowOutcome> {
        const ai = defaultTaskService(
          caller,
          {
            contract: "confirmation",
            taskType: "knowledge-graph-generation",
            language,
            answerContract: confirmationAnswerContract
          },
          prompts === "recorded" ? body : undefined
        );
        try {
          const decisions = await confirmMatchGroup({
            ai,
            group: rows,
            entityIdentity,
            context: {},
            promptVersion: "replay",
            stage: "replay",
            pinned: false,
            invalidOutputError: "errors.relationTypes.invalidOutput"
          });
          return {
            ok: true,
            error: null,
            salvagedItems: 0,
            digest: decisionsOf(
              new Map([...decisions].map(([key, value]) => [key, value.candidate]))
            )
          };
        } catch (error) {
          return { ok: false, error: errorCode(error), digest: null, salvagedItems: 0 };
        }
      }
    }
  };
}
