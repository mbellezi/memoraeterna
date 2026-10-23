/**
 * Knowledge graph (`graph.atomic_notes`, `graph.source_chunks`, `graph.catalog_metadata`, repaired by
 * their `.repair` prompts): the product's own flow, `generateKnowledgeGraphFromAtomicNotes`, runs with a
 * runner that sends its prompts to the local writer. Its salvage (valid items kept with no call), its
 * single repair and its final answer are the product's.
 *
 * The recording may hold a graph prompt older than today's (golden-small-f2 asks for claims, which the
 * product no longer extracts). The inputs, which did not change, are put back from the prompt's tail;
 * the recorded body is what `recorded` sends and today's builder makes `current`.
 */
import { KnowledgeGraphGenerationOutputSchema } from "@app/domain";

import {
  buildKnowledgeGraphPrompt,
  generateKnowledgeGraphFromAtomicNotes,
  type KnowledgeGraphAtomicNoteInput
} from "../../../apps/desktop/src/main/services/knowledge-processing.js";
import { knowledgeRunner } from "./flow.ts";
import {
  errorCode,
  intersectionSize,
  isRecord,
  normalizeName,
  readObject,
  share,
  stringField
} from "./text.ts";
import type { Digest, FlowOutcome, Prepared, YieldMetrics } from "./types.ts";
import { syntheticId, type RecordedCall } from "../replay-cassette.ts";

type InputKind = "atomic_notes" | "source_chunks" | "catalog_metadata";

const firstPromptStart = "Extract knowledge graph elements only from the ";
const repairPromptStart = "The previous knowledge-graph response was invalid";
const kindByLabel: Record<string, InputKind> = {
  "atomic notes": "atomic_notes",
  "source excerpts": "source_chunks",
  "source catalog metadata": "catalog_metadata"
};

export const graphAnswerContract = {
  name: "knowledge_graph",
  contract: KnowledgeGraphGenerationOutputSchema
} as const;

interface ParsedGraphPrompt {
  inputKind: InputKind;
  source: { title: string; language: string };
  aliases: string[];
  limits: { maxEntities: number; maxRelations: number };
  notes: KnowledgeGraphAtomicNoteInput[];
}

/** The chunk ID that stands for an evidence alias of a replayed batch. */
const aliasChunkId = (index: number) => syntheticId(100_000 + index);

/** The notes of a `graph_inputs` block: `[n1; evidence=c1,c2]`, title, idea (notes), blank line, body. */
function parseGraphInputs(
  text: string,
  inputKind: InputKind,
  chunkIdOf: ReadonlyMap<string, string>
): KnowledgeGraphAtomicNoteInput[] | null {
  const prefix = inputKind === "atomic_notes" ? "n" : "s";
  const header = (number: number) =>
    new RegExp(`(?:^|\\n\\n)\\[${prefix}${number}; evidence=([^\\]\\n]*)\\]\\n`, "u");
  const starts: Array<{ at: number; length: number; evidence: string }> = [];
  let from = 0;
  for (let number = 1; ; number += 1) {
    const match = header(number).exec(text.slice(from));
    if (!match) break;
    const at = from + match.index;
    if (number === 1 && at !== 0) return null;
    starts.push({ at, length: match[0].length, evidence: match[1]! });
    from = at + match[0].length;
  }
  if (starts.length === 0) return null;
  const notes: KnowledgeGraphAtomicNoteInput[] = [];
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1]?.at ?? text.length;
    const block = text.slice(start.at + start.length, end);
    const parsed =
      inputKind === "atomic_notes"
        ? /^Title: ([^\n]*)\nIdea: ([^\n]*)\n\n([\s\S]*)$/u.exec(block)
        : /^Title: ([^\n]*)\n\n([\s\S]*)$/u.exec(block);
    if (!parsed) return null;
    const ids = start.evidence
      .split(",")
      .filter((alias) => alias.length > 0)
      .map((alias) => chunkIdOf.get(alias));
    if (ids.some((id) => id === undefined)) return null;
    notes.push({
      id: syntheticId(200_000 + index),
      title: parsed[1]!,
      ideaStatement: inputKind === "atomic_notes" ? parsed[2]! : "",
      bodyMarkdown: inputKind === "atomic_notes" ? parsed[3]! : parsed[2]!,
      evidenceChunkIds: ids as string[]
    });
  }
  return notes;
}

/** Takes a recorded graph prompt apart; null when its pieces cannot be read. */
export function parseGraphPrompt(body: string): ParsedGraphPrompt | null {
  const label = /^Extract knowledge graph elements only from the (.+?) below\./u.exec(body)?.[1];
  const inputKind = label ? kindByLabel[label] : undefined;
  if (!inputKind) return null;
  const aliasMatch = /The only allowed evidence aliases in this batch are: (\[[^\]\n]*\])\./u.exec(
    body
  );
  const limitMatch = /at most (\d+) entities[^.\n]*?(\d+) relations/u.exec(body);
  const tail = /\nSource title: ([^\n]*)\nSource language: ([^\n]*)\n([^\n]*):\n/u.exec(body);
  if (!aliasMatch || !limitMatch || !tail) return null;
  let aliases: string[];
  try {
    aliases = JSON.parse(aliasMatch[1]!) as string[];
  } catch {
    return null;
  }
  const chunkIdOf = new Map(aliases.map((alias, index) => [alias, aliasChunkId(index)] as const));
  const notes = parseGraphInputs(body.slice(tail.index + tail[0].length), inputKind, chunkIdOf);
  if (!notes) return null;
  return {
    inputKind,
    source: { title: tail[1]!, language: tail[2]! },
    aliases,
    limits: { maxEntities: Number(limitMatch[1]), maxRelations: Number(limitMatch[2]) },
    notes
  };
}

interface GraphParts {
  entities: Array<{ key: string; name: string }>;
  relations: Array<{ subject: string; predicate: string; object: string }>;
}

function digestOfParts(parts: GraphParts): Digest {
  const nameOf = new Map(parts.entities.map((entity) => [entity.key, normalizeName(entity.name)]));
  const named = parts.relations.flatMap((relation) => {
    const subject = nameOf.get(relation.subject);
    const object = nameOf.get(relation.object);
    return subject !== undefined && object !== undefined
      ? [{ subject, object, predicate: relation.predicate }]
      : [];
  });
  return {
    entities: [...new Set(parts.entities.map((entity) => normalizeName(entity.name)))].sort(),
    pairs: [...new Set(named.map((r) => [r.subject, r.object].sort().join("|")))].sort(),
    triples: [...new Set(named.map((r) => `${r.subject}|${r.predicate}|${r.object}`))].sort()
  };
}

function digestOfAnswer(output: string): Digest | null {
  const root = readObject(output);
  if (!root || (!Array.isArray(root.entities) && !Array.isArray(root.relations))) return null;
  const entities = (Array.isArray(root.entities) ? root.entities : [])
    .filter(isRecord)
    .flatMap((entity) => {
      const key = stringField(entity, "key");
      const name = stringField(entity, "canonicalName");
      return key !== null && name !== null ? [{ key, name }] : [];
    });
  const relations = (Array.isArray(root.relations) ? root.relations : [])
    .filter(isRecord)
    .flatMap((relation) => {
      const subject = stringField(relation, "subjectEntityKey");
      const object = stringField(relation, "objectEntityKey");
      const predicate = stringField(relation, "predicate");
      return subject !== null && object !== null && predicate !== null
        ? [{ subject, predicate, object }]
        : [];
    });
  return digestOfParts({ entities, relations });
}

function compare(local: Digest, recorded: Digest): YieldMetrics {
  const list = (digest: Digest, key: string) => digest[key] as string[];
  const entityHits = intersectionSize(list(local, "entities"), list(recorded, "entities"));
  const pairHits = intersectionSize(list(local, "pairs"), list(recorded, "pairs"));
  const tripleHits = intersectionSize(list(local, "triples"), list(recorded, "triples"));
  return {
    entityRecall: share(entityHits, list(recorded, "entities").length),
    entityPrecision: share(entityHits, list(local, "entities").length),
    relationRecall: share(pairHits, list(recorded, "pairs").length),
    relationPrecision: share(pairHits, list(local, "pairs").length),
    predicateAgreement: pairHits === 0 ? 1 : Math.min(1, tripleHits / pairHits),
    entityCountRatio: share(list(local, "entities").length, list(recorded, "entities").length)
  };
}

export function prepareGraph(
  call: RecordedCall,
  split: { language: string; body: string }
): Prepared | null {
  if (call.taskType !== "knowledge-graph-generation") return null;
  const { body, language } = split;
  if (body.startsWith(repairPromptStart)) return { kind: "recorded_repair", contract: "graph" };
  if (!body.startsWith(firstPromptStart)) return null;
  const parsed = parseGraphPrompt(body);
  if (!parsed)
    return { kind: "unreconstructable", contract: "graph", reason: "prompt_not_taken_apart" };
  const aliasMap = new Map(parsed.aliases.map((alias, index) => [alias, aliasChunkId(index)]));
  const current = buildKnowledgeGraphPrompt(
    parsed.source,
    parsed.notes,
    aliasMap,
    parsed.inputKind,
    parsed.limits
  );
  const tail = (text: string) => text.slice(text.indexOf("\nSource title: "));
  if (tail(current) !== tail(body))
    return { kind: "unreconstructable", contract: "graph", reason: "inputs_differ_when_rebuilt" };
  return {
    kind: "item",
    item: {
      contract: "graph",
      fidelity: "product-flow",
      taskType: "knowledge-graph-generation",
      operation: `graph_${parsed.inputKind}`,
      language,
      body,
      current,
      answerContract: graphAnswerContract,
      digestOf: digestOfAnswer,
      compare,
      async run(caller, prompts): Promise<FlowOutcome> {
        const runner = knowledgeRunner(
          caller,
          {
            contract: "graph",
            taskType: "knowledge-graph-generation",
            language,
            answerContract: graphAnswerContract
          },
          prompts === "recorded" ? body : undefined
        );
        let salvagedItems = 0;
        try {
          const result = await generateKnowledgeGraphFromAtomicNotes(
            parsed.source,
            parsed.notes,
            runner,
            Number.MAX_SAFE_INTEGER,
            {
              inputKind: parsed.inputKind,
              contentLanguage: language,
              chunkPositions: new Map(
                parsed.aliases.map((_, index) => [aliasChunkId(index), index])
              ),
              batchLimits: parsed.limits,
              onSalvage: ({ salvage }) => {
                salvagedItems += salvage.salvagedItems;
              }
            }
          );
          const batch = result?.batches[0];
          if (!batch) return { ok: false, error: "no_batch", digest: null, salvagedItems };
          return {
            ok: true,
            error: null,
            salvagedItems,
            digest: digestOfParts({
              entities: batch.entities.map((entity) => ({
                key: entity.key,
                name: entity.canonicalName
              })),
              relations: batch.relations.map((relation) => ({
                subject: relation.subjectEntityKey,
                predicate: relation.predicate,
                object: relation.objectEntityKey
              }))
            })
          };
        } catch (error) {
          return { ok: false, error: errorCode(error), digest: null, salvagedItems };
        }
      }
    }
  };
}
