// Areas (D12, plan 4.1): the top two levels of the tree. An LLM proposes a Clio-style grouping of
// the level-2 topics into `areas.min`..`areas.max` Areas; this module is everything code does with
// that proposal, and none of it calls a model:
//
// - the input: the units the model regroups (every live level-2 topic under an Area that is not
//   fixed, and every level-1 leaf), aliased T1..Tn in content-anchor order (D22), and the fixed
//   Areas, aliased A1..Am: a protected (human or pinned) level-1 topic keeps all its children, and
//   an AI Area that holds a protected child keeps that child ("anchored"). A fixed Area is never
//   renamed, moved or retired; the model may only add units to it.
// - validation: every unit exactly once, known aliases, `areas.min`..`areas.max` Areas in the
//   result, at most `fanOut.hardMax` children per Area. A new Area with one member is not a
//   single-child chain: its member is promoted to the Areas level as it is. Titles are best effort:
//   an Area whose proposed title fails the naming rules (length, identifier-shaped, generic, equal
//   to a member's, taken by another Area) is created unnamed and naming names it later.
// - repair: an answer that fails validation is repaired in code first. A topic the answer left in
//   no Area joins the Area whose members' centroid is nearest, a topic in several Areas stays in
//   the nearest of them, unknown aliases are ignored, a pinned Area named twice is merged and an
//   Area left without topics is dropped; the repaired answer is validated again. Only when more
//   than `ai.areasRepairMaxMissingShare` of the topics were missing, or the repaired answer is still
//   invalid, is the model asked once more (the service makes that call, `describeAreaIssues`
//   lists what was wrong), and the answer that needed less repair is used.
// - the regroup as structure events: groups are mapped onto the current AI Areas by maximum member
//   Jaccard (hungarian.ts) so Area IDs survive; unmatched groups become new Areas, emptied Areas
//   retire with a redirect to the Area that took most of their topics, and their direct items
//   follow it. The order of events is valid statement by statement under the sibling-title index
//   (titles are cleared before they are reused, and set last).
// - the mis-parent pass at the Areas level: REBALANCE (repair.ts, its acceptance and protection
//   rules) re-parents the level-2 topics the deterministic audit finds closer to another Area.
// - acceptance: the mean silhouette of the level-2 centroids (cosine distance) under the result is
//   not lower than under the current grouping by more than `areas.silhouetteTolerance`, the E2
//   shape bars still hold (a bar met before is met after; a bar missed before does not get worse),
//   no single-child chain and no hard violation is added, and the Area count is in the band.
//
// Whether an accepted regroup applies or waits for review (D12, D29: automatic at bootstrap,
// `pending_review` afterwards and whenever it touches protected structure) is the service's call.
import { contentAnchor } from "./build.js";
import type { ShapeContext } from "./build.js";
import type { TopicTreeConfig } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import type { StructureEvent, TopicRenamePayload } from "./events.js";
import { maxWeightMatching } from "./hungarian.js";
import type { WeightedEdge } from "./hungarian.js";
import { compareStrings, normalizeTopicTitle } from "./ids.js";
import { cleanNameText, isGenericTopicTitle, isIdentifierShaped } from "./naming.js";
import { eventsTouchProtected, evacuateSecondaries, movePrimary } from "./operations.js";
import { topicsWithStaleStats } from "./place.js";
import { misParentAudit } from "./audit.js";
import { rebalanceTree, scopeHardViolations } from "./repair.js";
import { eventChurn, placedItemCount } from "./stability.js";
import { getTopic, isLive, isProtected, pathOf, walkTopics } from "./state.js";
import type { TopicNode, TopicTreeState } from "./state.js";
import { recomputePaths } from "./stats.js";
import { dot } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

/**
 * The E2 shape bars of the F2 exit (`docs/plan.md`, spec section 8): item-weighted mean depth (root
 * = 0) and the share of internal non-root topics whose fan-out is in fanOut.targetMin..targetMax.
 * The Areas acceptance holds a regroup to them (D12).
 */
export const areaShapeBars = { meanDepthMax: 4.5, fanOutInTargetMin: 0.8 } as const;

// ---------------------------------------------------------------------------
// Input

/** A topic the model regroups: a level-2 topic, or a level-1 leaf. */
export interface AreaUnit {
  /** `T1`, `T2`, ... in content-anchor order (D22). */
  alias: string;
  topicId: string;
  /** Its level-1 topic now: the Area above it, or itself for a level-1 leaf. */
  areaId: string;
  depth: 1 | 2;
  title: string | null;
}

/** A level-1 topic the regroup keeps as it is (it may only receive units). */
export interface FixedArea {
  /** `A1`, `A2`, ... in content-anchor order. */
  alias: string;
  topicId: string;
  title: string | null;
  description: string | null;
  /** Children that stay under it: all of them when it is protected, the protected ones otherwise. */
  kept: string[];
  reason: "protected" | "anchored";
}

export interface AreaGroupingInput {
  rootId: string;
  units: AreaUnit[];
  fixed: FixedArea[];
  /** Live level-1 topics now, in content-anchor order. */
  areas: string[];
}

function anchored(state: TopicTreeState, ids: readonly string[]): string[] {
  const anchors = new Map(ids.map((id) => [id, contentAnchor(state, id)]));
  return [...ids].sort(
    (a, b) =>
      compareStrings(anchors.get(a) as string, anchors.get(b) as string) || compareStrings(a, b)
  );
}

/** The units and fixed Areas of the current tree (see the module comment). */
export function areaGroupingInput(state: TopicTreeState): AreaGroupingInput {
  const root = getTopic(state, state.rootId);
  const areas = anchored(state, root.children);
  const fixed: Omit<FixedArea, "alias">[] = [];
  const units: Omit<AreaUnit, "alias">[] = [];
  for (const areaId of areas) {
    const area = getTopic(state, areaId);
    if (isProtected(area)) {
      fixed.push({
        topicId: areaId,
        title: area.title,
        description: area.description,
        kept: [...area.children],
        reason: "protected"
      });
      continue;
    }
    if (area.children.length === 0) {
      units.push({ topicId: areaId, areaId, depth: 1, title: area.title });
      continue;
    }
    const kept = area.children.filter((child) => isProtected(getTopic(state, child)));
    if (kept.length > 0) {
      fixed.push({
        topicId: areaId,
        title: area.title,
        description: area.description,
        kept,
        reason: "anchored"
      });
    }
    for (const child of area.children) {
      if (!isProtected(getTopic(state, child))) {
        units.push({ topicId: child, areaId, depth: 2, title: getTopic(state, child).title });
      }
    }
  }
  const unitOrder = anchored(
    state,
    units.map((unit) => unit.topicId)
  );
  const byId = new Map(units.map((unit) => [unit.topicId, unit]));
  return {
    rootId: state.rootId,
    units: unitOrder.map((id, index) => ({
      ...(byId.get(id) as AreaUnit),
      alias: `T${index + 1}`
    })),
    fixed: fixed.map((area, index) => ({ ...area, alias: `A${index + 1}` })),
    areas
  };
}

/**
 * What a proposal answered for: the units with their aliases and the fixed Areas. A proposal is
 * applied only to a tree with the same signature (the model saw that tree).
 */
export function areaGroupingSignature(input: AreaGroupingInput): string {
  return JSON.stringify([
    input.units.map((unit) => [unit.alias, unit.topicId, unit.areaId]),
    input.fixed.map((area) => [area.alias, area.topicId, area.kept])
  ]);
}

// ---------------------------------------------------------------------------
// Validation

/** The model's answer (the shape `TopicAreasOutputSchema` parses). */
export type AreaProposalEntry =
  | { alias: string; members: string[] }
  | { new: { title: string; description: string }; members: string[] };

export interface AreaProposal {
  areas: AreaProposalEntry[];
}

export const areaProposalIssueCodes = [
  "unknown-area",
  "duplicate-area",
  "unknown-topic",
  "duplicate-topic",
  "missing-topic",
  "empty-area",
  "area-count",
  "area-too-large"
] as const;
export type AreaProposalIssueCode = (typeof areaProposalIssueCodes)[number];

export interface AreaProposalIssue {
  code: AreaProposalIssueCode;
  /** The alias concerned (an Area or topic alias), when there is one. */
  alias: string | null;
}

export const areaTitleIssueCodes = [
  "title-empty",
  "title-length",
  "title-format",
  "title-identifier",
  "title-generic",
  "title-member",
  "title-taken",
  "description-invalid"
] as const;
export type AreaTitleIssueCode = (typeof areaTitleIssueCodes)[number];

/** One target Area of a valid proposal. */
export interface AreaGroup {
  /** The fixed Area the units join, or null for a new Area. */
  fixedId: string | null;
  /** Unit topic IDs in alias order (for a fixed Area: the units it receives). */
  units: string[];
  /** A valid title for a new Area of two or more units; null otherwise. */
  title: string | null;
  description: string | null;
}

export interface ValidAreaProposal {
  /** Fixed Areas first (in alias order), then new groups in the order of their first unit. */
  groups: AreaGroup[];
  /** Level-1 topics after the regroup (fixed Areas, new Areas and promoted units). */
  areaCount: number;
  /** New groups of one unit: the unit becomes an Area itself. */
  promoted: string[];
  titleIssues: { code: AreaTitleIssueCode; title: string }[];
}

export type AreaProposalValidation =
  { ok: true; proposal: ValidAreaProposal } | { ok: false; issues: AreaProposalIssue[] };

const aliasKey = (alias: string): string => alias.trim().toUpperCase();

/** Checks a proposal against its input (see the module comment). */
export function validateAreaProposal(
  input: AreaGroupingInput,
  proposal: AreaProposal,
  config: TopicTreeConfig
): AreaProposalValidation {
  const unitByAlias = new Map(input.units.map((unit) => [aliasKey(unit.alias), unit]));
  const unitIndex = new Map(input.units.map((unit, index) => [unit.topicId, index]));
  const fixedByAlias = new Map(input.fixed.map((area) => [aliasKey(area.alias), area]));
  const issues: AreaProposalIssue[] = [];
  const assigned = new Set<string>();
  const fixedUnits = new Map<string, string[]>();
  const drafts: { units: string[]; title: string; description: string }[] = [];
  for (const entry of proposal.areas) {
    const units: string[] = [];
    for (const member of entry.members) {
      const unit = unitByAlias.get(aliasKey(member));
      if (!unit) {
        issues.push({ code: "unknown-topic", alias: member });
        continue;
      }
      if (assigned.has(unit.topicId)) {
        issues.push({ code: "duplicate-topic", alias: unit.alias });
        continue;
      }
      assigned.add(unit.topicId);
      units.push(unit.topicId);
    }
    if ("alias" in entry) {
      const fixed = fixedByAlias.get(aliasKey(entry.alias));
      if (!fixed) issues.push({ code: "unknown-area", alias: entry.alias });
      else if (fixedUnits.has(fixed.topicId)) {
        issues.push({ code: "duplicate-area", alias: fixed.alias });
      } else fixedUnits.set(fixed.topicId, units);
    } else if (units.length === 0) {
      issues.push({ code: "empty-area", alias: null });
    } else {
      drafts.push({ units, title: entry.new.title, description: entry.new.description });
    }
  }
  for (const unit of input.units) {
    if (!assigned.has(unit.topicId)) issues.push({ code: "missing-topic", alias: unit.alias });
  }
  const byUnitOrder = (a: string, b: string): number =>
    (unitIndex.get(a) as number) - (unitIndex.get(b) as number);
  for (const draft of drafts) draft.units.sort(byUnitOrder);
  drafts.sort((a, b) => byUnitOrder(a.units[0] as string, b.units[0] as string));
  const areaCount = input.fixed.length + drafts.length;
  if (areaCount < config.areas.min || areaCount > config.areas.max) {
    issues.push({ code: "area-count", alias: null });
  }
  for (const area of input.fixed) {
    const added = fixedUnits.get(area.topicId)?.length ?? 0;
    if (area.kept.length + added > config.fanOut.hardMax) {
      issues.push({ code: "area-too-large", alias: area.alias });
    }
  }
  for (const draft of drafts) {
    if (draft.units.length > config.fanOut.hardMax) {
      const first = input.units[unitIndex.get(draft.units[0] as string) as number];
      issues.push({ code: "area-too-large", alias: first?.alias ?? null });
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // Titles: fixed Areas and promoted units keep theirs, so new titles must differ from them.
  const unitTitle = new Map(input.units.map((unit) => [unit.topicId, unit.title]));
  const taken = new Set<string>();
  for (const area of input.fixed) if (area.title) taken.add(normalizeTopicTitle(area.title));
  const promoted = drafts.filter((draft) => draft.units.length === 1).map((d) => d.units[0]!);
  for (const id of promoted) {
    const title = unitTitle.get(id);
    if (title) taken.add(normalizeTopicTitle(title));
  }
  const titleIssues: ValidAreaProposal["titleIssues"] = [];
  const groups: AreaGroup[] = input.fixed.map((area) => ({
    fixedId: area.topicId,
    units: [...(fixedUnits.get(area.topicId) ?? [])].sort(byUnitOrder),
    title: null,
    description: null
  }));
  for (const draft of drafts) {
    if (draft.units.length === 1) {
      groups.push({ fixedId: null, units: draft.units, title: null, description: null });
      continue;
    }
    const title = cleanNameText(draft.title);
    const memberTitles = new Set(
      draft.units.flatMap((id) => {
        const own = unitTitle.get(id);
        return own ? [normalizeTopicTitle(own)] : [];
      })
    );
    let code: AreaTitleIssueCode | null = null;
    if (title === "") code = "title-empty";
    else if ([...title].length > config.naming.titleMaxChars) code = "title-length";
    else if (title.includes("›") || /[{}[\]<>]/u.test(title)) code = "title-format";
    else if (isIdentifierShaped(title)) code = "title-identifier";
    else if (isGenericTopicTitle(title)) code = "title-generic";
    else if (memberTitles.has(normalizeTopicTitle(title))) code = "title-member";
    else if (taken.has(normalizeTopicTitle(title))) code = "title-taken";
    if (code !== null) titleIssues.push({ code, title: draft.title });
    else taken.add(normalizeTopicTitle(title));
    const description = draft.description.replace(/\s+/gu, " ").trim();
    const describable =
      description !== "" && [...description].length <= config.naming.descriptionMaxChars;
    if (!describable) titleIssues.push({ code: "description-invalid", title: draft.title });
    groups.push({
      fixedId: null,
      units: draft.units,
      title: code === null ? title : null,
      description: code === null && describable ? description : null
    });
  }
  return { ok: true, proposal: { groups, areaCount, promoted, titleIssues } };
}

// ---------------------------------------------------------------------------
// Repair of an incomplete answer

/** What the repair needs of a topic: the items under it and the sum of their unit vectors. */
export interface AreaTopicVector {
  n: number;
  ls: Float64Array;
}
export type AreaVectors = ReadonlyMap<string, AreaTopicVector>;

/**
 * Copies the statistics the repair compares: those of the units and of the children fixed Areas
 * keep. The copy keeps the repair independent of the tree, which moves on while the model answers.
 */
export function areaRepairVectors(state: TopicTreeState, input: AreaGroupingInput): AreaVectors {
  const vectors = new Map<string, AreaTopicVector>();
  const add = (id: string): void => {
    const node = state.topics.get(id);
    if (!node || !isLive(node) || node.stats.n === 0) return;
    vectors.set(id, { n: node.stats.n, ls: Float64Array.from(node.stats.ls) });
  };
  for (const unit of input.units) add(unit.topicId);
  for (const area of input.fixed) for (const id of area.kept) add(id);
  return vectors;
}

/** What the deterministic repair did to an answer. */
export interface AreaRepairReport {
  /** Topics the answer put in no Area that joined the nearest one (or only in an Area it had no right to name). */
  placed: number;
  /** Topics the answer put in several Areas (or twice in one) that stay in the nearest only. */
  deduplicated: number;
  /** Aliases that are no topic of the list and were ignored. */
  unknownTopics: number;
  /** Pinned Areas the answer named again, merged into their first entry. */
  mergedAreas: number;
  /** Areas dropped: named a pinned Area that does not exist, or left without a topic. */
  droppedAreas: number;
}

export const noAreaRepair: Readonly<AreaRepairReport> = Object.freeze({
  placed: 0,
  deduplicated: 0,
  unknownTopics: 0,
  mergedAreas: 0,
  droppedAreas: 0
});

/** Topics the repair put in an Area (`repaired: n` of the change-set summary). */
export function repairedTopics(report: AreaRepairReport): number {
  return report.placed + report.deduplicated;
}

/** Whether the repair changed anything of the answer. */
export function areaRepairChanged(report: AreaRepairReport): boolean {
  return (
    report.placed +
      report.deduplicated +
      report.unknownTopics +
      report.mergedAreas +
      report.droppedAreas >
    0
  );
}

interface RepairEntry {
  /** The pinned Area it adds to, or null for a new Area. */
  fixed: FixedArea | null;
  title: string;
  description: string;
  /** Topics it keeps, once each, in the order the answer gave them. */
  units: string[];
}

/** Cosine between two summed vectors; -Infinity when either has no direction. */
function sumCosine(a: Float64Array | undefined, b: Float64Array | undefined): number {
  if (!a || !b) return Number.NEGATIVE_INFINITY;
  const norms = Math.sqrt(dot(a, a) * dot(b, b));
  return norms > 0 ? dot(a, b) / norms : Number.NEGATIVE_INFINITY;
}

/**
 * Repairs an answer in code, without a model (see the module comment). Titles and descriptions
 * are the model's own and are never changed or invented, so a repaired answer keeps the language
 * and the title rules `validateAreaProposal` applies. The result may still be invalid: an Area
 * count outside the band, an Area above the hard fan-out, or no Area to join.
 */
export function repairAreaProposal(
  input: AreaGroupingInput,
  proposal: AreaProposal,
  config: TopicTreeConfig,
  vectors: AreaVectors
): { proposal: AreaProposal; report: AreaRepairReport } {
  const unitByAlias = new Map(input.units.map((unit) => [aliasKey(unit.alias), unit]));
  const unitIndex = new Map(input.units.map((unit, index) => [unit.topicId, index]));
  const fixedByAlias = new Map(input.fixed.map((area) => [aliasKey(area.alias), area]));
  const report: AreaRepairReport = { ...noAreaRepair };

  // The entries: what the answer says, unknown aliases ignored and repeats of a pinned Area
  // merged. The members of an entry that names no pinned Area are placed like missing topics.
  const fixedEntries = new Map<string, RepairEntry>();
  const entries: RepairEntry[] = [];
  const mentions = new Map<string, number>();
  for (const raw of proposal.areas) {
    let entry: RepairEntry;
    if ("alias" in raw) {
      const fixed = fixedByAlias.get(aliasKey(raw.alias));
      if (!fixed) {
        report.droppedAreas += 1;
        continue;
      }
      const known = fixedEntries.get(fixed.topicId);
      if (known) report.mergedAreas += 1;
      entry = known ?? { fixed, title: "", description: "", units: [] };
      if (!known) {
        fixedEntries.set(fixed.topicId, entry);
        entries.push(entry);
      }
    } else {
      entry = { fixed: null, title: raw.new.title, description: raw.new.description, units: [] };
      entries.push(entry);
    }
    for (const member of raw.members) {
      const unit = unitByAlias.get(aliasKey(member));
      if (!unit) {
        report.unknownTopics += 1;
        continue;
      }
      mentions.set(unit.topicId, (mentions.get(unit.topicId) ?? 0) + 1);
      if (!entry.units.includes(unit.topicId)) entry.units.push(unit.topicId);
    }
  }
  for (const count of mentions.values()) if (count > 1) report.deduplicated += 1;
  // A pinned Area the answer did not name still exists, and a missing topic may join it.
  for (const fixed of input.fixed) {
    if (fixedEntries.has(fixed.topicId)) continue;
    const entry: RepairEntry = { fixed, title: "", description: "", units: [] };
    fixedEntries.set(fixed.topicId, entry);
    entries.push(entry);
  }
  const isEmptyNew = (entry: RepairEntry): boolean =>
    entry.fixed === null && entry.units.length === 0;
  report.droppedAreas += entries.filter(isEmptyNew).length;

  // Fixed Areas first in alias order, then new Areas by their first topic: the order of
  // `validateAreaProposal`, so ties below never depend on how the model ordered its answer.
  const fixedOrder = new Map(input.fixed.map((area, index) => [area.topicId, index]));
  const firstUnit = (entry: RepairEntry): number =>
    Math.min(...entry.units.map((id) => unitIndex.get(id) as number));
  const ordered = entries
    .filter((entry) => !isEmptyNew(entry))
    .sort((a, b) =>
      a.fixed && b.fixed
        ? (fixedOrder.get(a.fixed.topicId) as number) - (fixedOrder.get(b.fixed.topicId) as number)
        : a.fixed
          ? -1
          : b.fixed
            ? 1
            : firstUnit(a) - firstUnit(b)
    );

  // The centroid of an entry's members: the sum of their vectors, from the topics only it
  // claims and the children a pinned Area keeps.
  const claims = new Map<string, RepairEntry[]>();
  for (const entry of ordered) {
    for (const id of entry.units) claims.set(id, [...(claims.get(id) ?? []), entry]);
  }
  const sums = new Map<RepairEntry, Float64Array>();
  const accumulate = (entry: RepairEntry, id: string): void => {
    const vector = vectors.get(id);
    if (!vector) return;
    const sum = sums.get(entry) ?? new Float64Array(vector.ls.length);
    for (let i = 0; i < sum.length; i += 1) sum[i] = (sum[i] as number) + (vector.ls[i] as number);
    sums.set(entry, sum);
  };
  for (const entry of ordered) {
    for (const id of entry.fixed?.kept ?? []) accumulate(entry, id);
    for (const id of entry.units) if (claims.get(id)?.length === 1) accumulate(entry, id);
  }
  const nearest = (id: string, among: readonly RepairEntry[]) => {
    const own = vectors.get(id)?.ls;
    let best: { entry: RepairEntry; score: number } | null = null;
    for (const entry of among) {
      const score = sumCosine(own, sums.get(entry));
      if (best === null || score > best.score) best = { entry, score };
    }
    return best;
  };

  // A topic in several Areas stays in the nearest of them.
  const keeps = new Map<string, RepairEntry>();
  for (const unit of input.units) {
    const claimants = claims.get(unit.topicId) ?? [];
    if (claimants.length > 1) keeps.set(unit.topicId, nearest(unit.topicId, claimants)!.entry);
  }
  for (const [id, keeper] of keeps) {
    for (const entry of claims.get(id) as RepairEntry[]) {
      if (entry !== keeper) entry.units.splice(entry.units.indexOf(id), 1);
    }
    claims.set(id, [keeper]);
    accumulate(keeper, id);
  }

  // A topic in no Area joins the nearest Area that has room, one topic at a time in alias order.
  // With no vectors to compare it joins the smallest Area.
  const size = (entry: RepairEntry): number => (entry.fixed?.kept.length ?? 0) + entry.units.length;
  for (const unit of input.units) {
    if ((claims.get(unit.topicId) ?? []).length > 0) continue;
    const room = ordered.filter((entry) => size(entry) < config.fanOut.hardMax);
    const best = nearest(unit.topicId, room);
    if (best === null) continue;
    const target =
      best.score === Number.NEGATIVE_INFINITY
        ? room.reduce((smallest, entry) => (size(entry) < size(smallest) ? entry : smallest))
        : best.entry;
    target.units.push(unit.topicId);
    claims.set(unit.topicId, [target]);
    report.placed += 1;
  }

  // The repaired answer. An Area whose topics all went elsewhere is dropped.
  const areas: AreaProposalEntry[] = [];
  for (const entry of ordered) {
    const members = [...entry.units]
      .sort((a, b) => (unitIndex.get(a) as number) - (unitIndex.get(b) as number))
      .map((id) => (input.units[unitIndex.get(id) as number] as AreaUnit).alias);
    if (entry.fixed) {
      if (members.length > 0) areas.push({ alias: entry.fixed.alias, members });
    } else if (members.length === 0) report.droppedAreas += 1;
    else areas.push({ new: { title: entry.title, description: entry.description }, members });
  }
  return { proposal: { areas }, report };
}

/** An answer checked and, when it is not valid, repaired in code (see the module comment). */
export interface AreaAnswerCheck {
  /** The issues of the answer as the model gave it (none when it was valid). */
  issues: AreaProposalIssue[];
  /** The answer after the repair: the answer itself when it was valid. */
  proposal: AreaProposal;
  report: AreaRepairReport;
  /** The repaired answer, validated. */
  validation: AreaProposalValidation;
  /** Topics the answer put in no Area, as a share of all the topics. */
  missingShare: number;
  /** Why the model should be asked once more: many topics missing, or invalid after repair. */
  callReason: "missing-share" | "invalid" | null;
}

export function checkAreaAnswer(
  input: AreaGroupingInput,
  proposal: AreaProposal,
  config: TopicTreeConfig,
  vectors: AreaVectors
): AreaAnswerCheck {
  const given = validateAreaProposal(input, proposal, config);
  if (given.ok) {
    return {
      issues: [],
      proposal,
      report: { ...noAreaRepair },
      validation: given,
      missingShare: 0,
      callReason: null
    };
  }
  const repaired = repairAreaProposal(input, proposal, config, vectors);
  const validation = validateAreaProposal(input, repaired.proposal, config);
  const missingShare = input.units.length > 0 ? repaired.report.placed / input.units.length : 0;
  return {
    issues: given.issues,
    proposal: repaired.proposal,
    report: repaired.report,
    validation,
    missingShare,
    callReason: !validation.ok
      ? "invalid"
      : missingShare > config.ai.areasRepairMaxMissingShare
        ? "missing-share"
        : null
  };
}

/** The line of the repair prompt for an answer that was not JSON of the required shape. */
export const areaUnreadableAnswerLine =
  "The answer was not valid JSON of the required shape. Return only the JSON.";

/** The most aliases a line of the repair prompt lists. */
const repairLineAliases = 20;

/**
 * The lines of the repair prompt: what was wrong with an answer, in a fixed order, with aliases
 * (never IDs) and counts only, so the prompt stays a function of content. Aliases the model made
 * up are shown reduced to plain characters.
 */
export function describeAreaIssues(
  input: AreaGroupingInput,
  proposal: AreaProposal,
  issues: readonly AreaProposalIssue[],
  config: TopicTreeConfig
): string {
  const unitIndex = new Map(input.units.map((unit, index) => [unit.alias, index]));
  const unknown = Number.MAX_SAFE_INTEGER;
  const listOf = (code: AreaProposalIssueCode): string | null => {
    const found = [
      ...new Set(
        issues.flatMap((issue) =>
          issue.code === code && issue.alias !== null
            ? [issue.alias.replace(/[^\p{L}\p{N}_.-]/gu, "").slice(0, 16)]
            : []
        )
      )
    ].filter((alias) => alias !== "");
    found.sort(
      (a, b) =>
        (unitIndex.get(a) ?? unknown) - (unitIndex.get(b) ?? unknown) || compareStrings(a, b)
    );
    if (found.length === 0) return null;
    const shown = found.slice(0, repairLineAliases).join(", ");
    return found.length > repairLineAliases
      ? `${shown} and ${found.length - repairLineAliases} more`
      : shown;
  };
  const lines: string[] = [];
  const add = (code: AreaProposalIssueCode, text: (list: string) => string): void => {
    const list = listOf(code);
    if (list !== null) lines.push(text(list));
  };
  add("missing-topic", (list) => `Topics in no Area (put each in exactly one Area): ${list}`);
  add("duplicate-topic", (list) => `Topics in more than one Area (keep each in one): ${list}`);
  add("unknown-topic", (list) => `Not topics of the list (use only the aliases given): ${list}`);
  add(
    "unknown-area",
    (list) => `Not pinned Areas (add to a pinned Area only by its alias): ${list}`
  );
  add("duplicate-area", (list) => `Pinned Areas listed more than once (list each once): ${list}`);
  const empty = issues.filter((issue) => issue.code === "empty-area").length;
  if (empty > 0) {
    lines.push(
      `${empty} ${empty === 1 ? "Area has" : "Areas have"} no topic (every Area needs at least one)`
    );
  }
  if (issues.some((issue) => issue.code === "area-count")) {
    const known = new Set(input.units.map((unit) => aliasKey(unit.alias)));
    const created = proposal.areas.filter(
      (entry) => "new" in entry && entry.members.some((member) => known.has(aliasKey(member)))
    ).length;
    const count = input.fixed.length + created;
    lines.push(
      `The answer makes ${count} ${count === 1 ? "Area" : "Areas"} (pinned Areas included); ` +
        `make between ${config.areas.min} and ${config.areas.max}`
    );
  }
  add(
    "area-too-large",
    (list) => `Too many topics in the Area of ${list} (at most ${config.fanOut.hardMax} per Area)`
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The regroup as structure events

export interface AreaRegroupPlanOptions {
  /** The change-set the events belong to (created and named topics record it). */
  changeSetId: string;
  /** The content language the model wrote the titles in. */
  contentLanguage: string;
}

export interface AreaRegroupOutcome {
  /** The Area of every group of two or more units: fixed, matched AI Area or new. */
  targets: string[];
  created: string[];
  /** New groups that kept the ID of a current AI Area. */
  matched: number;
  retired: string[];
  /** Areas that took the model's title. */
  renamed: string[];
  /** Units promoted to the Areas level. */
  promoted: string[];
  /** Units that changed Area. */
  movedTopics: string[];
  /** Direct items of retired Areas that moved to their successor. */
  movedItems: number;
  /** Unit titles given up because two siblings would share them (I7); naming names them again. */
  clearedTitles: string[];
}

/** The name fields of a topic that gives its title up (a fresh object each time). */
function unnamed(): TopicRenamePayload {
  return {
    title: null,
    nameState: "unnamed",
    nameSource: null,
    nameLanguage: null,
    namedChangeSetId: null,
    aliases: []
  };
}

/**
 * Applies a valid proposal to `context.state` through `context.editor`. Statistics are not
 * recomputed here. Every intermediate state keeps sibling titles unique (the repository applies
 * the events statement by statement under the sibling-title index):
 *
 * 1. titles that change or go are cleared: AI Areas whose title changes, units that would share a
 *    title with a final sibling (for good: naming names them again) and units that would meet a
 *    same-titled sibling that has not left yet (for the move only);
 * 2. new Areas are created unnamed;
 * 3. units move to their Area;
 * 4. emptied AI Areas retire, their direct items following the Area that took most of their units;
 * 5. promoted units join the Areas level;
 * 6. Areas take their final titles and the units cleared for the move get theirs back.
 */
export function applyAreaRegroup(
  context: ShapeContext,
  input: AreaGroupingInput,
  proposal: ValidAreaProposal,
  options: AreaRegroupPlanOptions
): AreaRegroupOutcome {
  const { state, editor, config } = context;
  const rootId = state.rootId;
  const fixedIds = new Set(input.fixed.map((area) => area.topicId));
  const unitIds = new Set(input.units.map((unit) => unit.topicId));
  const areaOfUnit = new Map(input.units.map((unit) => [unit.topicId, unit.areaId]));
  const keyOf = (id: string): string | null => {
    const title = getTopic(state, id).title;
    return title === null ? null : normalizeTopicTitle(title);
  };
  const humanNamed = (id: string): boolean => getTopic(state, id).nameSource === "human";
  const promoted = new Set(proposal.promoted);
  const newGroups = proposal.groups.filter(
    (group) => group.fixedId === null && group.units.length > 1
  );
  const outcome: AreaRegroupOutcome = {
    targets: [],
    created: [],
    matched: 0,
    retired: [],
    renamed: [],
    promoted: [...proposal.promoted],
    movedTopics: [],
    movedItems: 0,
    clearedTitles: []
  };

  // Matching: new groups against the AI Areas whose units are in play, by member Jaccard.
  const candidates = input.areas.filter(
    (id) => !fixedIds.has(id) && !unitIds.has(id) && getTopic(state, id).children.length > 0
  );
  const candidateIndex = new Map(candidates.map((id, index) => [id, index]));
  const candidateSize = new Map<string, number>();
  for (const unit of input.units) {
    if (candidateIndex.has(unit.areaId)) {
      candidateSize.set(unit.areaId, (candidateSize.get(unit.areaId) ?? 0) + 1);
    }
  }
  const edges: WeightedEdge[] = [];
  newGroups.forEach((group, left) => {
    const overlap = new Map<string, number>();
    for (const id of group.units) {
      const area = areaOfUnit.get(id) as string;
      if (candidateIndex.has(area)) overlap.set(area, (overlap.get(area) ?? 0) + 1);
    }
    for (const [area, shared] of overlap) {
      const union = group.units.length + (candidateSize.get(area) as number) - shared;
      edges.push({ left, right: candidateIndex.get(area) as number, weight: shared / union });
    }
  });
  const matching = maxWeightMatching(newGroups.length, candidates.length, edges, {
    exactMaxNodes: config.rebuild.hungarianExactMaxTopics
  });
  const matchedOf = new Map<AreaGroup, string>();
  newGroups.forEach((group, left) => {
    const right = matching.leftToRight[left] as number;
    if (right >= 0) matchedOf.set(group, candidates[right] as string);
  });
  outcome.matched = matchedOf.size;

  // The title plan. Root level: fixed Areas, then promoted units, then the Areas' titles.
  const rootTitles = new Set<string>();
  for (const area of input.fixed) {
    const key = keyOf(area.topicId);
    if (key) rootTitles.add(key);
  }
  const clearForever: string[] = [];
  for (const id of proposal.promoted) {
    const key = keyOf(id);
    if (!key) continue;
    if (rootTitles.has(key) && !humanNamed(id)) clearForever.push(id);
    else rootTitles.add(key);
  }
  const finalTitle = new Map<AreaGroup, { title: string; fromModel: boolean } | null>();
  for (const group of newGroups) {
    const matched = matchedOf.get(group);
    if (matched && humanNamed(matched)) {
      const title = getTopic(state, matched).title as string;
      finalTitle.set(group, { title, fromModel: false });
      rootTitles.add(normalizeTopicTitle(title));
    }
  }
  for (const group of newGroups) {
    if (finalTitle.has(group) || !group.title) continue;
    const key = normalizeTopicTitle(group.title);
    if (rootTitles.has(key)) continue;
    rootTitles.add(key);
    finalTitle.set(group, { title: group.title, fromModel: true });
  }
  for (const group of newGroups) {
    if (finalTitle.has(group)) continue;
    const matched = matchedOf.get(group);
    const current = matched ? getTopic(state, matched).title : null;
    if (current !== null && !rootTitles.has(normalizeTopicTitle(current))) {
      rootTitles.add(normalizeTopicTitle(current));
      finalTitle.set(group, { title: current, fromModel: false });
    } else finalTitle.set(group, null);
  }

  // Area level: the final children of every target must keep sibling titles unique.
  // Where each unit lands, as a key: its fixed Area, its group (first unit) or the root.
  const destination = new Map<string, string>();
  for (const group of proposal.groups) {
    const key = group.fixedId ?? `group:${group.units[0] as string}`;
    for (const id of group.units) destination.set(id, promoted.has(id) ? rootId : key);
  }
  const keptOf = new Map(input.fixed.map((area) => [area.topicId, area.kept]));
  for (const group of proposal.groups) {
    if (group.fixedId === null && group.units.length < 2) continue;
    const seen = new Set<string>();
    for (const child of group.fixedId ? (keptOf.get(group.fixedId) ?? []) : []) {
      const key = keyOf(child);
      if (key) seen.add(key);
    }
    for (const id of group.units) {
      const key = keyOf(id);
      if (!key) continue;
      if (seen.has(key) && !humanNamed(id)) clearForever.push(id);
      else seen.add(key);
    }
  }
  const cleared = new Set(clearForever);
  // A unit that arrives where a same-titled unit has not left yet gives its title up for the move.
  const clearForMove: string[] = [];
  for (const group of proposal.groups) {
    if (group.fixedId === null && group.units.length < 2) continue;
    const matched = group.fixedId ?? matchedOf.get(group) ?? null;
    if (matched === null) continue; // a new Area is empty before the moves
    for (const id of group.units) {
      const key = keyOf(id);
      if (!key || cleared.has(id) || getTopic(state, id).parentId === matched) continue;
      const meets = getTopic(state, matched).children.some(
        (child) =>
          child !== id &&
          unitIds.has(child) &&
          destination.get(child) !== destination.get(id) &&
          keyOf(child) === key
      );
      if (meets) clearForMove.push(id);
    }
  }

  // 1. Clear the titles that change or go.
  const restore = new Map<string, TopicRenamePayload>();
  for (const group of newGroups) {
    const matched = matchedOf.get(group);
    if (!matched || humanNamed(matched)) continue;
    const node = getTopic(state, matched);
    if (node.title !== null && node.title !== (finalTitle.get(group)?.title ?? null)) {
      editor.renameTopic(matched, unnamed());
    }
  }
  for (const id of clearForever) {
    editor.renameTopic(id, unnamed());
    outcome.clearedTitles.push(id);
  }
  for (const id of clearForMove) {
    const node = getTopic(state, id);
    restore.set(id, {
      title: node.title,
      nameState: node.nameState,
      nameSource: node.nameSource,
      nameLanguage: node.nameLanguage,
      namedChangeSetId: node.namedChangeSetId,
      aliases: [...node.aliases]
    });
    editor.renameTopic(id, unnamed());
  }

  // 2. New Areas, unnamed for now.
  const targetOf = new Map<AreaGroup, string>();
  for (const group of proposal.groups) {
    if (group.fixedId !== null) targetOf.set(group, group.fixedId);
  }
  for (const group of newGroups) {
    const matched = matchedOf.get(group);
    if (matched) {
      targetOf.set(group, matched);
      continue;
    }
    const id = context.newTopicId();
    editor.createTopic(id, rootId, { createdChangeSetId: options.changeSetId });
    targetOf.set(group, id);
    outcome.created.push(id);
  }

  // 3. Units move to their Area.
  for (const group of proposal.groups) {
    const target = targetOf.get(group);
    if (target === undefined) continue;
    outcome.targets.push(target);
    for (const id of group.units) {
      if (getTopic(state, id).parentId === target) continue;
      editor.moveTopic(id, target);
      outcome.movedTopics.push(id);
    }
  }

  // 4. Emptied AI Areas retire; their direct items (and any secondaries) follow the Area that
  //    took most of their units, ties in unit order.
  const landing = (id: string): string => {
    if (promoted.has(id)) return id;
    const group = proposal.groups.find((candidate) => candidate.units.includes(id));
    return targetOf.get(group as AreaGroup) as string;
  };
  const kept = new Set(targetOf.values());
  for (const id of candidates) {
    const node = getTopic(state, id);
    if (kept.has(id) || node.children.length > 0) continue;
    const received = new Map<string, number>();
    for (const unit of input.units) {
      if (unit.areaId !== id) continue;
      const to = landing(unit.topicId);
      received.set(to, (received.get(to) ?? 0) + 1);
    }
    let successor: string | null = null;
    for (const [to, count] of received) {
      if (successor === null || count > (received.get(successor) as number)) successor = to;
    }
    if (successor === null) continue;
    for (const item of [...node.items]) {
      movePrimary(context, item, successor);
      outcome.movedItems += 1;
    }
    evacuateSecondaries(context, id, successor);
    editor.retireTopic(id, successor, context.now);
    outcome.retired.push(id);
  }

  // 5. Promoted units join the Areas level.
  for (const id of proposal.promoted) {
    if (getTopic(state, id).parentId === rootId) continue;
    editor.moveTopic(id, rootId);
    outcome.movedTopics.push(id);
  }

  // 6. Final titles: the Areas, then the units cleared for the move.
  for (const group of newGroups) {
    const target = targetOf.get(group) as string;
    const final = finalTitle.get(group);
    if (!final || humanNamed(target)) continue;
    const node = getTopic(state, target);
    if (final.fromModel) {
      if (node.title !== final.title || node.nameSource !== "llm" || node.nameState !== "named") {
        editor.renameTopic(target, {
          title: final.title,
          nameState: "named",
          nameSource: "llm",
          nameLanguage: options.contentLanguage,
          namedChangeSetId: options.changeSetId,
          aliases: []
        });
        outcome.renamed.push(target);
      }
      if (group.description !== null && node.description !== group.description) {
        editor.describeTopic(target, group.description);
      }
    }
  }
  for (const [id, fields] of restore) editor.renameTopic(id, fields);
  return outcome;
}

// ---------------------------------------------------------------------------
// Acceptance

/** The E2 readings the acceptance compares (root excluded from the fan-out share). */
export interface AreaShape {
  meanDepth: number;
  fanOutInTarget: number;
  internalTopics: number;
  singleChildTopics: number;
  /** Level-1 topics. */
  areas: number;
}

export function areaShape(state: TopicTreeState, config: TopicTreeConfig): AreaShape {
  let depthSum = 0;
  let items = 0;
  let internal = 0;
  let inTarget = 0;
  let singleChild = 0;
  walkTopics(state, (node, depth) => {
    depthSum += depth * node.items.length;
    items += node.items.length;
    const fanOut = node.children.length;
    if (fanOut === 1) singleChild += 1;
    if (fanOut === 0 || node.id === state.rootId) return;
    internal += 1;
    if (fanOut >= config.fanOut.targetMin && fanOut <= config.fanOut.targetMax) inTarget += 1;
  });
  return {
    meanDepth: items > 0 ? depthSum / items : 0,
    fanOutInTarget: internal > 0 ? inTarget / internal : 1,
    internalTopics: internal,
    singleChildTopics: singleChild,
    areas: getTopic(state, state.rootId).children.length
  };
}

/** The level-1 topic above a live topic (itself at level 1). */
export function levelOneTopic(state: TopicTreeState, topicId: string): string {
  const path = pathOf(state, topicId);
  return (path[1] ?? path[0]) as string;
}

/** The points of the level-2 silhouette: live level-2 topics and level-1 leaves with statistics. */
export function silhouettePoints(state: TopicTreeState): string[] {
  const points: string[] = [];
  walkTopics(state, (node, depth) => {
    if (node.stats.n === 0) return;
    if (depth === 2 || (depth === 1 && node.children.length === 0)) points.push(node.id);
  });
  return points.sort(compareStrings);
}

/**
 * Mean silhouette of `points` (topic centroids, cosine distance 1 - cos) under `labelOf`: for
 * each point (a - b) / max(a, b) with a the mean distance to the rest of its group and b the
 * smallest mean distance to another group; a point alone in its group scores 0.
 */
export function centroidSilhouette(
  state: TopicTreeState,
  points: readonly string[],
  labelOf: (topicId: string) => string
): number {
  if (points.length === 0) return 0;
  const centroids = points.map((id) => getTopic(state, id).stats.centroid);
  const labels = points.map(labelOf);
  const groups = new Map<string, number[]>();
  labels.forEach((label, index) => groups.set(label, [...(groups.get(label) ?? []), index]));
  if (groups.size < 2) return 0;
  const similarity: number[][] = centroids.map(() => []);
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i; j < points.length; j += 1) {
      const value = i === j ? 1 : dot(centroids[i]!, centroids[j]!);
      similarity[i]![j] = value;
      similarity[j]![i] = value;
    }
  }
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const own = groups.get(labels[i] as string) as number[];
    if (own.length < 2) continue;
    let a = 0;
    for (const j of own) if (j !== i) a += 1 - (similarity[i]![j] as number);
    a /= own.length - 1;
    let b = Number.POSITIVE_INFINITY;
    for (const [label, members] of groups) {
      if (label === labels[i]) continue;
      let sum = 0;
      for (const j of members) sum += 1 - (similarity[i]![j] as number);
      b = Math.min(b, sum / members.length);
    }
    const scale = Math.max(a, b);
    total += scale > 0 ? (b - a) / scale : 0;
  }
  return total / points.length;
}

export const areaRejectionReasons = [
  "area-count",
  "silhouette",
  "mean-depth",
  "fan-out",
  "single-child",
  "hard-violation"
] as const;
export type AreaRejectionReason = (typeof areaRejectionReasons)[number];

export interface AreaAcceptance {
  accepted: boolean;
  reasons: AreaRejectionReason[];
  silhouette: { before: number; after: number; tolerance: number };
  shape: { before: AreaShape; after: AreaShape };
  hardViolations: { before: number; after: number; added: number };
}

/** D12's acceptance of a regroup (see the module comment). */
export function judgeAreaRegroup(
  measured: {
    silhouette: { before: number; after: number };
    shape: { before: AreaShape; after: AreaShape };
    hard: { before: ReadonlySet<string>; after: ReadonlySet<string> };
  },
  config: TopicTreeConfig
): AreaAcceptance {
  const { silhouette, shape, hard } = measured;
  const reasons: AreaRejectionReason[] = [];
  const tolerance = config.areas.silhouetteTolerance;
  if (shape.after.areas < config.areas.min || shape.after.areas > config.areas.max) {
    reasons.push("area-count");
  }
  if (silhouette.after < silhouette.before - tolerance) reasons.push("silhouette");
  const depthBar = areaShapeBars.meanDepthMax;
  if (
    shape.before.meanDepth <= depthBar
      ? shape.after.meanDepth > depthBar
      : shape.after.meanDepth > shape.before.meanDepth
  ) {
    reasons.push("mean-depth");
  }
  const fanOutBar = areaShapeBars.fanOutInTargetMin;
  if (
    shape.before.fanOutInTarget >= fanOutBar
      ? shape.after.fanOutInTarget < fanOutBar
      : shape.after.fanOutInTarget < shape.before.fanOutInTarget
  ) {
    reasons.push("fan-out");
  }
  if (shape.after.singleChildTopics > shape.before.singleChildTopics) reasons.push("single-child");
  let added = 0;
  for (const key of hard.after) if (!hard.before.has(key)) added += 1;
  if (added > 0) reasons.push("hard-violation");
  return {
    accepted: reasons.length === 0,
    reasons,
    silhouette: { ...silhouette, tolerance },
    shape,
    hardViolations: { before: hard.before.size, after: hard.after.size, added }
  };
}

// ---------------------------------------------------------------------------
// The whole regroup: events, the mis-parent pass, measurements and the verdict

export interface RegroupAreasInput {
  /** Changed in place: callers pass a copy unless they mean to keep the result. */
  state: TopicTreeState;
  vectors: ItemVectorSource;
  config: TopicTreeConfig;
  input: AreaGroupingInput;
  proposal: ValidAreaProposal;
  seed: number;
  now: string;
  day: string;
  newTopicId: () => string;
  changeSetId: string;
  contentLanguage: string;
  /** Run REBALANCE's mis-parent re-parents at the Areas level on the result (default true). */
  reparent?: boolean;
}

export interface RegroupAreasResult {
  events: StructureEvent[];
  outcome: AreaRegroupOutcome;
  /** Mis-parented level-2 topics re-parented on the result. */
  reparented: string[];
  acceptance: AreaAcceptance;
  /** The events touch a human or pinned topic or placement: the result waits for review (D29). */
  protectedTouched: boolean;
  /** Live topics whose statistics the events changed (exact again in `state`). */
  touchedTopics: string[];
  /** Items whose primary path changed, and their share of the placed items. */
  churn: { items: number; share: number };
  /** Mis-parented level-2 topics before and after (the audit's depth-2 count). */
  misParented: { before: number; after: number; level2Topics: number };
}

function depth2MisParents(state: TopicTreeState, config: TopicTreeConfig) {
  const audit = misParentAudit(state, config);
  const summary = audit.byDepth.find((entry) => entry.depth === 2);
  return {
    findings: audit.findings.filter((finding) => finding.depth === 2),
    count: summary?.misParented ?? 0,
    topics: summary?.topics ?? 0
  };
}

/** Applies a valid proposal to `input.state`, re-parents mis-parents and judges the result. */
export function regroupAreas(args: RegroupAreasInput): RegroupAreasResult {
  const { state, vectors, config } = args;
  const points = silhouettePoints(state);
  const labelsBefore = new Map(points.map((id) => [id, levelOneTopic(state, id)]));
  const silhouetteBefore = centroidSilhouette(state, points, (id) => labelsBefore.get(id)!);
  const shapeBefore = areaShape(state, config);
  const hardBefore = scopeHardViolations(state, config, state.rootId);
  const misBefore = depth2MisParents(state, config);

  const editor = createTopicTreeEditor(state);
  const context: ShapeContext = {
    state,
    vectors,
    config,
    seed: args.seed,
    editor,
    newTopicId: args.newTopicId,
    now: args.now,
    markMoves: true
  };
  const outcome = applyAreaRegroup(context, args.input, args.proposal, {
    changeSetId: args.changeSetId,
    contentLanguage: args.contentLanguage
  });
  const events = [...editor.events];
  recomputePaths(state, vectors, [...editor.touched, ...topicsWithStaleStats(state, events)]);

  // The Areas level settles through REBALANCE: the deterministic audit's depth-2 re-parents, with
  // its acceptance and protection rules; here Area-level operations are part of this regroup.
  const reparented: string[] = [];
  if (args.reparent !== false) {
    const targets = depth2MisParents(state, config)
      .findings.filter((finding) => finding.reparent !== null && !finding.protected)
      .map((finding) => finding.topicId);
    if (targets.length > 0) {
      const settled = rebalanceTree({
        state,
        vectors,
        config,
        seed: args.seed,
        now: args.now,
        day: args.day,
        newTopicId: args.newTopicId,
        topics: targets,
        conditions: new Set(["mis-parented"]),
        areasActive: true,
        areaLevelReview: false,
        force: true
      });
      events.push(...settled.events);
      for (const operation of settled.applied) reparented.push(operation.topicId);
      recomputePaths(state, vectors, [
        ...settled.touchedTopics,
        ...topicsWithStaleStats(state, settled.events)
      ]);
    }
  }

  const live = (id: string): boolean => {
    const node = state.topics.get(id);
    return node !== undefined && isLive(node);
  };
  const silhouetteAfter = centroidSilhouette(state, points.filter(live), (id) =>
    levelOneTopic(state, id)
  );
  const acceptance = judgeAreaRegroup(
    {
      silhouette: { before: silhouetteBefore, after: silhouetteAfter },
      shape: { before: shapeBefore, after: areaShape(state, config) },
      hard: { before: hardBefore, after: scopeHardViolations(state, config, state.rootId) }
    },
    config
  );
  const touched = new Set<string>();
  for (const id of topicsWithStaleStats(state, events)) touched.add(id);
  for (const id of editor.touched) if (live(id)) touched.add(id);
  const churn = eventChurn(state, events, config);
  const placed = placedItemCount(state);
  const misAfter = depth2MisParents(state, config);
  return {
    events,
    outcome,
    reparented,
    acceptance,
    protectedTouched: eventsTouchProtected(state, events),
    touchedTopics: [...touched].sort(compareStrings),
    churn: { items: churn.items.length, share: placed > 0 ? churn.items.length / placed : 0 },
    misParented: { before: misBefore.count, after: misAfter.count, level2Topics: misAfter.topics }
  };
}

/** The Areas of a tree as the prompt and reports show them (level-1 topics with their units). */
export function areaMembers(state: TopicTreeState): Map<string, TopicNode[]> {
  const output = new Map<string, TopicNode[]>();
  for (const id of getTopic(state, state.rootId).children) {
    output.set(
      id,
      getTopic(state, id).children.map((child) => getTopic(state, child))
    );
  }
  return output;
}
