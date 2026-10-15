import { z } from "zod";

/**
 * Browser-safe topic vocabulary (F2 Topic Tree Engine, docs/plan.md 4.1). The engine itself is
 * exported only through `@app/domain/topic-tree` (main process and workers); this module holds
 * the enums, limits and push payloads that the database, IPC, preload and renderer share with it.
 * The IPC request and response contracts of the topic screens extend this module (T16).
 */

const uuid = z.string().uuid();

export const topicTreeStatuses = ["shadow", "active", "retired"] as const;
export const TopicTreeStatusSchema = z.enum(topicTreeStatuses);
export type TopicTreeStatus = z.infer<typeof TopicTreeStatusSchema>;

export const topicRoles = ["root", "topic"] as const;
export const TopicRoleSchema = z.enum(topicRoles);
export type TopicRole = z.infer<typeof TopicRoleSchema>;

/** `unnamed` topics store no title; the interface renders a localized "Unnamed topic". */
export const topicNameStates = ["named", "provisional", "unnamed"] as const;
export const TopicNameStateSchema = z.enum(topicNameStates);
export type TopicNameState = z.infer<typeof TopicNameStateSchema>;

export const topicNameSources = ["llm", "human", "tfidf"] as const;
export const TopicNameSourceSchema = z.enum(topicNameSources);
export type TopicNameSource = z.infer<typeof TopicNameSourceSchema>;

/** `human` and `pinned` topics are protected: automation never moves, renames or dissolves them. */
export const topicManagements = ["ai", "human", "pinned"] as const;
export const TopicManagementSchema = z.enum(topicManagements);
export type TopicManagement = z.infer<typeof TopicManagementSchema>;

export const topicHealthValues = ["good", "attention", "violation"] as const;
export const TopicHealthSchema = z.enum(topicHealthValues);
export type TopicHealth = z.infer<typeof TopicHealthSchema>;

/** Items placed in the tree: atomic notes and root sources (D8). */
export const topicItemKinds = ["note", "source"] as const;
export const TopicItemKindSchema = z.enum(topicItemKinds);
export type TopicItemKind = z.infer<typeof TopicItemKindSchema>;

export const topicPlacementRoles = ["primary", "secondary"] as const;
export const TopicPlacementRoleSchema = z.enum(topicPlacementRoles);
export type TopicPlacementRole = z.infer<typeof TopicPlacementRoleSchema>;

export const topicPlacementManagements = ["ai", "human"] as const;
export const TopicPlacementManagementSchema = z.enum(topicPlacementManagements);
export type TopicPlacementManagement = z.infer<typeof TopicPlacementManagementSchema>;

/** How a placement was decided (`topic_placements.decided_by`). */
export const topicPlacementDecisions = [
  "build",
  "auto",
  "gate",
  "fallback",
  "human",
  "rebuild"
] as const;
export const TopicPlacementDecisionSchema = z.enum(topicPlacementDecisions);
export type TopicPlacementDecision = z.infer<typeof TopicPlacementDecisionSchema>;

export const topicChangeSetOrigins = [
  "build",
  "place",
  "gate",
  "rebalance",
  "audit",
  "naming",
  "areas",
  "human",
  "undo",
  "rebuild",
  "switch"
] as const;
export const TopicChangeSetOriginSchema = z.enum(topicChangeSetOrigins);
export type TopicChangeSetOrigin = z.infer<typeof TopicChangeSetOriginSchema>;

export const topicChangeSetStatuses = ["applied", "undone", "pending_review", "dismissed"] as const;
export const TopicChangeSetStatusSchema = z.enum(topicChangeSetStatuses);
export type TopicChangeSetStatus = z.infer<typeof TopicChangeSetStatusSchema>;

export const topicChangeSetRisks = ["low", "medium", "high"] as const;
export const TopicChangeSetRiskSchema = z.enum(topicChangeSetRisks);
export type TopicChangeSetRisk = z.infer<typeof TopicChangeSetRiskSchema>;

/** The complete structure-event vocabulary (`topic_structure_events.op`). */
export const topicStructureEventOps = [
  "topic.create",
  "topic.retire",
  "topic.restore",
  "topic.move",
  "topic.rename",
  "topic.describe",
  "topic.manage",
  "item.place",
  "item.unplace",
  "item.move"
] as const;
export const TopicStructureEventOpSchema = z.enum(topicStructureEventOps);
export type TopicStructureEventOp = z.infer<typeof TopicStructureEventOpSchema>;

export const topicGateModes = ["shadow", "live"] as const;
export const TopicGateModeSchema = z.enum(topicGateModes);
export type TopicGateMode = z.infer<typeof TopicGateModeSchema>;

/** `topics.status` phase (section 3.2 of the F2 spec). */
export const topicsPhases = [
  "legacy",
  "ready_to_switch",
  "switching",
  "building",
  "active"
] as const;
export const TopicsPhaseSchema = z.enum(topicsPhases);
export type TopicsPhase = z.infer<typeof TopicsPhaseSchema>;

/** Informative reasons the engine is waiting; never blocking. */
export const topicsBlockedReasons = [
  "no_embedding_route",
  "space_changed",
  "waiting_for_embeddings",
  "no_decider"
] as const;
export const TopicsBlockedReasonSchema = z.enum(topicsBlockedReasons);
export type TopicsBlockedReason = z.infer<typeof TopicsBlockedReasonSchema>;

/** Field limits shared by the engine, the database checks and the contracts. */
export const topicLimits = {
  titleMaxLength: 120,
  descriptionMaxLength: 400,
  aliasMaxLength: 120,
  aliasesMax: 10,
  languageMaxLength: 16,
  maxSecondaryPlacements: 2,
  changedTopicIdsMax: 200
} as const;

export const TopicTitleSchema = z.string().trim().min(1).max(topicLimits.titleMaxLength);
export const TopicDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(topicLimits.descriptionMaxLength);
export const TopicAliasesSchema = z
  .array(z.string().trim().min(1).max(topicLimits.aliasMaxLength))
  .max(topicLimits.aliasesMax);

/**
 * Push payload after a topic change-set commits (D15): coalesced, `topicIds` null when the change
 * is too broad to list.
 */
export const TopicsChangedEventSchema = z
  .object({
    treeId: uuid,
    generation: z.number().int().min(0),
    topicIds: z.array(uuid).max(topicLimits.changedTopicIdsMax).nullable(),
    changeSetId: uuid.nullable()
  })
  .strict();
export type TopicsChangedEvent = z.infer<typeof TopicsChangedEventSchema>;
