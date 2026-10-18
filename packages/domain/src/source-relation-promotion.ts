// Promotion of note relations into source relations (design E, F3 D27): every typed shown (applied,
// kept or suggested, decision 29) cross-root note relation becomes evidence of a source relation
// with no call. Whether the result is a suggestion is read from its support, never planned here:
// the plan counts every shown relation alike. Pure: the repository
// reads the note relations and writes what this plans, so the order replay and the tests share it.
import {
  directedNoteRelationTypes,
  noteRelationWriteTypes,
  type NoteRelationWriteType
} from "./knowledge.js";
import { promotableNoteRelationType } from "./source-relations.js";

/** A typed shown note relation between two roots, read in its direction. */
export interface PromotionNoteRelation {
  id: string;
  /** Its stored type, write or legacy; a type that promotes nothing is left out. */
  type: string | null;
  /** Root of the subject note (of the lower endpoint for a symmetric type). */
  subjectRootId: string;
  /** Root of the object note. */
  objectRootId: string;
  /**
   * Whether the subject to object reading is a direction the owner or the Decisions decider gave
   * (decision 31b). False: the notes are only linked, and the subject is just the lower endpoint.
   */
  directed: boolean;
  /** The calibrated probability, or the decider's own score; null when unknown. */
  probability: number | null;
  /** The two notes' ideas in reading order: content-order ties, never IDs. */
  contentKey: string;
}

/** One source relation promotion makes (or keeps): one per root pair and type (D27). */
export interface PromotedSourceRelationPlan {
  /**
   * The subject's root when a note relation gave the type a direction; otherwise the root first in
   * content order.
   */
  sourceRootId: string;
  targetRootId: string;
  type: NoteRelationWriteType;
  /** Reads both ways: a symmetric type, or a directed type none of whose notes gave a direction. */
  symmetric: boolean;
  /** The supporting note relations in content order (its `support_count`). */
  noteRelationIds: string[];
}

interface Tally {
  type: NoteRelationWriteType;
  relations: PromotionNoteRelation[];
  probability: number;
  firstContent: string;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isDirected = (type: NoteRelationWriteType) =>
  (directedNoteRelationTypes as readonly string[]).includes(type);
const promotesDirected = (relation: PromotionNoteRelation) => {
  const type = promotableNoteRelationType(relation.type);
  return type !== null && isDirected(type) && relation.directed;
};

/**
 * The majority type: most relations, then the highest summed probability, then the first relation
 * in content order, then the vocabulary order (D27). Null when no relation promotes anything.
 */
function majority(relations: readonly PromotionNoteRelation[]): Tally | null {
  const tallies = new Map<NoteRelationWriteType, Tally>();
  for (const relation of relations) {
    const type = promotableNoteRelationType(relation.type);
    if (!type) continue;
    const tally = tallies.get(type) ?? { type, relations: [], probability: 0, firstContent: "" };
    if (!tally.relations.length || compareText(relation.contentKey, tally.firstContent) < 0)
      tally.firstContent = relation.contentKey;
    tally.relations.push(relation);
    tally.probability += relation.probability ?? 0;
    tallies.set(type, tally);
  }
  return (
    [...tallies.values()].toSorted(
      (a, b) =>
        b.relations.length - a.relations.length ||
        b.probability - a.probability ||
        compareText(a.firstContent, b.firstContent) ||
        noteRelationWriteTypes.indexOf(a.type) - noteRelationWriteTypes.indexOf(b.type)
    )[0] ?? null
  );
}

const inContentOrder = (relations: readonly PromotionNoteRelation[]) =>
  relations
    .toSorted((a, b) => compareText(a.contentKey, b.contentKey) || compareText(a.id, b.id))
    .map((relation) => relation.id);

/**
 * What promotion makes of a root's typed shown cross-root note relations (D27): per other root,
 * the majority type; a symmetric one gives one relation; a directed one gives one relation per
 * direction in which it is also the majority of that direction's directed relations, and, when no
 * direction has its own majority, the direction holding most of its relations. Only a direction the
 * owner or the decider gave counts (decision 31b): a directed type none of whose note relations has
 * one gives a single relation that reads both ways, and the notes without a direction add no
 * support to a directed one. `compareRoots` is a content order of roots (title, then ID): the
 * endpoint order of a relation that reads both ways.
 */
export function planPromotedSourceRelations(input: {
  rootId: string;
  relations: readonly PromotionNoteRelation[];
  compareRoots: (a: string, b: string) => number;
}): PromotedSourceRelationPlan[] {
  const byOther = new Map<string, PromotionNoteRelation[]>();
  for (const relation of input.relations) {
    if (relation.subjectRootId === relation.objectRootId) continue;
    if (relation.subjectRootId !== input.rootId && relation.objectRootId !== input.rootId) continue;
    const other =
      relation.subjectRootId === input.rootId ? relation.objectRootId : relation.subjectRootId;
    byOther.set(other, [...(byOther.get(other) ?? []), relation]);
  }
  const plans: PromotedSourceRelationPlan[] = [];
  for (const other of [...byOther.keys()].toSorted(input.compareRoots)) {
    const relations = byOther.get(other)!;
    const winner = majority(relations);
    if (!winner) continue;
    if (!isDirected(winner.type) || !winner.relations.some((item) => item.directed)) {
      const [sourceRootId, targetRootId] = [input.rootId, other].toSorted(input.compareRoots) as [
        string,
        string
      ];
      plans.push({
        sourceRootId,
        targetRootId,
        type: winner.type,
        symmetric: true,
        noteRelationIds: inContentOrder(winner.relations)
      });
      continue;
    }
    const directions = [
      [input.rootId, other],
      [other, input.rootId]
    ] as const;
    const kept: PromotedSourceRelationPlan[] = [];
    const candidates: Array<{ plan: PromotedSourceRelationPlan; tally: Tally }> = [];
    for (const [subject, object] of directions) {
      const inDirection = relations.filter(
        (relation) =>
          relation.subjectRootId === subject &&
          relation.objectRootId === object &&
          promotesDirected(relation)
      );
      const own = winner.relations.filter((relation) => inDirection.includes(relation));
      if (!own.length) continue;
      const plan: PromotedSourceRelationPlan = {
        sourceRootId: subject,
        targetRootId: object,
        type: winner.type,
        symmetric: false,
        noteRelationIds: inContentOrder(own)
      };
      candidates.push({
        plan,
        tally: { ...winner, relations: own, probability: sum(own), firstContent: first(own) }
      });
      if (majority(inDirection)?.type === winner.type) kept.push(plan);
    }
    if (kept.length) plans.push(...kept);
    else {
      const best = candidates.toSorted(
        (a, b) =>
          b.tally.relations.length - a.tally.relations.length ||
          b.tally.probability - a.tally.probability ||
          compareText(a.tally.firstContent, b.tally.firstContent)
      )[0];
      if (best) plans.push(best.plan);
    }
  }
  return plans;
}

const sum = (relations: readonly PromotionNoteRelation[]) =>
  relations.reduce((total, relation) => total + (relation.probability ?? 0), 0);
const first = (relations: readonly PromotionNoteRelation[]) =>
  relations.map((relation) => relation.contentKey).toSorted(compareText)[0] ?? "";
