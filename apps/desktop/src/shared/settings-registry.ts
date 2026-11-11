// The settings registry (F4 T98, D33): every persisted setting of the application with the screen
// that shows it, its category for E7 and the production code that reads it. It feeds the static
// tests that keep the Settings cut honest: E7 (at most six `automation` controls outside an Advanced
// disclosure, the six Knowledge controls), "no stored key lacks a reader", and that the screens
// render what the registry says. A setting added without a row fails those tests.
import type { MatchingValueControlId } from "@app/domain";

/** The scopes of the Settings screen. */
export const settingsScopeIds = [
  "overview",
  "personalization",
  "prompts",
  "knowledge",
  "intelligence",
  "models",
  "external-services",
  "connections",
  "data"
] as const;
export type SettingsScope = (typeof settingsScopeIds)[number];

/**
 * What a setting is for (docs/settings-inventory.md section 2). E7 counts `automation`: a value
 * that changes what the app does by itself in the background or how automatic processing decides.
 */
export type SettingCategory =
  | "automation"
  | "setup"
  | "integration"
  | "preference"
  | "diagnostics"
  | "data"
  | "credential"
  | "internal";

/** Where the control sits: the `advanced` placement is inside an Advanced disclosure. */
export type SettingPlacement =
  "knowledge" | "general" | "ai" | "integrations" | "data" | "import" | "advanced" | "none";

/** The place a value is stored. */
export type SettingStore = "app.preferences" | "storage_settings" | "settings" | "credential";

export interface SettingEntry {
  /** The stored key path: `sourceRelationSettings.minImportance`, `knowledge.controls.v1.autonomy`. */
  id: string;
  store: SettingStore;
  category: SettingCategory;
  placement: SettingPlacement;
  /** The Settings scope that shows its control; null when there is no control on a Settings screen. */
  scope: SettingsScope | null;
  /**
   * The DOM `id` of its control, when the screen renders it without loading anything first. Null:
   * no control, or one of a component that loads its data (AI setup, the Debug view).
   */
  control: string | null;
  /** Production code that reads the value (repository-relative; never a test). */
  reader: string;
  /** Where the key is spelled when that is not the reader (a typed constant of a package). */
  defined?: string;
}

/** The DOM ids of the matching controls: Settings › Knowledge › Advanced › Matching settings. */
export const matchingControlDomIds: Readonly<Record<MatchingValueControlId, string>> = {
  relationTypeSimilarityThreshold: "relationTypeSimilarityThreshold",
  entityIdentitySimilarityThreshold: "entityIdentitySimilarityThreshold",
  "atomicNoteMatchingSettings.maxRerankOutputTokens": "matching-maxRerankOutputTokens",
  "canonicalMatchingSettings.relationTypeCandidateLimit": "matching-relationTypeCandidateLimit",
  "canonicalMatchingSettings.entityCandidateLimit": "matching-entityCandidateLimit",
  "canonicalMatchingSettings.confirmationBatchSize": "matching-confirmationBatchSize",
  "canonicalMatchingSettings.confirmationMaxCharacters": "matching-confirmationMaxCharacters",
  "sourceRelationSettings.evidenceChunksPerSource": "matching-evidenceChunksPerSource",
  "sourceRelationSettings.evidenceMaxCharacters": "matching-evidenceMaxCharacters",
  "sourceRelationSettings.summaryMaxCharacters": "matching-summaryMaxCharacters",
  "sourceRelationSettings.maxOutputTokens": "matching-maxOutputTokens",
  "sourceRelationSettings.maxRelationsPerPair": "matching-maxRelationsPerPair",
  "sourceRelationSettings.maxInputTokens": "matching-maxInputTokens",
  "sourceRelationSettings.minImportance": "sourceRelations-minImportance",
  "sourceRelationSettings.minConfidence": "sourceRelations-minConfidence",
  "sourceRelationSettings.includeWeakTypes": "matching-includeWeakTypes"
};

/** The DOM ids of the Knowledge controls. */
export const knowledgeControlDomIds = {
  autonomy: "knowledge-autonomy",
  monthlyCapUsd: "knowledge-monthly-cap",
  paused: "knowledge-paused",
  treeShape: "knowledge-tree-shape",
  onlyIdle: "knowledge-only-idle",
  onlyOnAc: "knowledge-only-ac"
} as const;

const main = "apps/desktop/src/main";
const renderer = "apps/desktop/src/renderer";
const gate = `${main}/services/gardener/background-gate.ts`;
const sourceRelations = `${main}/services/source-relation-processing.ts`;

const matchingEntry = (
  id: MatchingValueControlId,
  reader: string,
  defined?: string
): SettingEntry => ({
  id,
  store: "app.preferences",
  category: "automation",
  placement: "advanced",
  scope: "knowledge",
  control: matchingControlDomIds[id],
  reader,
  ...(defined ? { defined } : {})
});

const knowledgeEntry = (
  field: keyof typeof knowledgeControlDomIds,
  reader: string
): SettingEntry => ({
  id: `knowledge.controls.v1.${field}`,
  store: "settings",
  category: "automation",
  placement: "knowledge",
  scope: "knowledge",
  control: knowledgeControlDomIds[field],
  reader,
  defined: "packages/domain/src/gardener/controls.ts"
});

const internal = (
  id: string,
  store: SettingStore,
  reader: string,
  defined?: string
): SettingEntry => ({
  id,
  store,
  category: "internal",
  placement: "none",
  scope: null,
  control: null,
  reader,
  ...(defined ? { defined } : {})
});

/** Every persisted setting. Rows are grouped by store; the order within a group is the screen's. */
export const settingsRegistry: readonly SettingEntry[] = [
  // --- the six Knowledge controls (E7: the only `automation` controls outside Advanced) --------
  knowledgeEntry("autonomy", gate),
  knowledgeEntry("monthlyCapUsd", `${main}/index.ts`),
  knowledgeEntry("paused", gate),
  knowledgeEntry("treeShape", `${main}/index.ts`),
  knowledgeEntry("onlyIdle", gate),
  knowledgeEntry("onlyOnAc", gate),

  // --- Advanced › Matching settings (Q4): the 16 values, the selector and the saved presets -----
  matchingEntry("relationTypeSimilarityThreshold", `${main}/index.ts`),
  matchingEntry("entityIdentitySimilarityThreshold", `${main}/index.ts`),
  matchingEntry(
    "atomicNoteMatchingSettings.maxRerankOutputTokens",
    `${main}/services/relations/relation-matcher.ts`
  ),
  matchingEntry(
    "canonicalMatchingSettings.relationTypeCandidateLimit",
    `${main}/services/relation-type-resolution.ts`
  ),
  matchingEntry(
    "canonicalMatchingSettings.entityCandidateLimit",
    `${main}/services/entity-identity-resolution.ts`
  ),
  matchingEntry(
    "canonicalMatchingSettings.confirmationBatchSize",
    `${main}/services/entity-identity-resolution.ts`
  ),
  matchingEntry(
    "canonicalMatchingSettings.confirmationMaxCharacters",
    `${main}/services/entity-identity-resolution.ts`
  ),
  matchingEntry("sourceRelationSettings.evidenceChunksPerSource", sourceRelations),
  matchingEntry("sourceRelationSettings.evidenceMaxCharacters", sourceRelations),
  matchingEntry("sourceRelationSettings.summaryMaxCharacters", sourceRelations),
  matchingEntry("sourceRelationSettings.maxOutputTokens", sourceRelations),
  matchingEntry("sourceRelationSettings.maxRelationsPerPair", sourceRelations),
  matchingEntry("sourceRelationSettings.maxInputTokens", sourceRelations),
  matchingEntry("sourceRelationSettings.minImportance", "packages/domain/src/source-relations.ts"),
  matchingEntry("sourceRelationSettings.minConfidence", "packages/domain/src/source-relations.ts"),
  matchingEntry("sourceRelationSettings.includeWeakTypes", sourceRelations),
  {
    id: "activeMatchingPresetId",
    store: "app.preferences",
    category: "automation",
    placement: "advanced",
    scope: "knowledge",
    control: "matching-preset",
    reader: `${main}/services/settings-service.ts`
  },
  {
    id: "matchingPresets",
    store: "app.preferences",
    category: "automation",
    placement: "advanced",
    scope: "knowledge",
    control: "matching-preset",
    reader: `${main}/services/settings-service.ts`
  },

  // --- the other Advanced values --------------------------------------------------------------
  {
    id: "summaryMinimumWordCount",
    store: "app.preferences",
    category: "automation",
    placement: "advanced",
    scope: "knowledge",
    control: "summaryMinimumWordCount",
    reader: `${main}/index.ts`
  },
  {
    id: "keepLocalEmbeddingModelsLoaded",
    store: "app.preferences",
    category: "automation",
    placement: "advanced",
    scope: "intelligence",
    control: "keepLocalEmbeddingModelsLoaded",
    reader: `${main}/index.ts`
  },
  {
    id: "relations.deciderMode",
    store: "settings",
    category: "automation",
    placement: "advanced",
    scope: "intelligence",
    control: null,
    reader: `${main}/services/relations/relation-matcher.ts`,
    defined: "packages/domain/src/relations-config.ts"
  },
  {
    id: "graphWheelZoomSensitivity",
    store: "app.preferences",
    category: "preference",
    placement: "advanced",
    scope: "personalization",
    control: "graphWheelZoomSensitivity",
    reader: `${renderer}/App.tsx`
  },
  {
    id: "debugMode",
    store: "app.preferences",
    category: "diagnostics",
    placement: "advanced",
    scope: null,
    control: null,
    reader: `${main}/services/monitoring-service.ts`
  },
  {
    id: "debugFullCapture",
    store: "app.preferences",
    category: "diagnostics",
    placement: "advanced",
    scope: null,
    control: null,
    reader: `${main}/services/monitoring-service.ts`
  },
  {
    id: "managedRoot",
    store: "storage_settings",
    category: "integration",
    placement: "advanced",
    scope: "connections",
    control: "managedRoot",
    reader: `${main}/services/obsidian-sync-service.ts`
  },
  {
    id: "local-models.repository-token-ref",
    store: "credential",
    category: "credential",
    placement: "advanced",
    scope: "models",
    control: null,
    reader: `${main}/services/local-model-service.ts`
  },

  // --- general --------------------------------------------------------------------------------
  {
    id: "language",
    store: "app.preferences",
    category: "preference",
    placement: "general",
    scope: "personalization",
    control: "uiLocale",
    reader: `${renderer}/App.tsx`
  },
  {
    id: "contentLanguage",
    store: "app.preferences",
    category: "preference",
    placement: "general",
    scope: "personalization",
    control: null,
    reader: `${main}/index.ts`
  },
  {
    id: "themeMode",
    store: "app.preferences",
    category: "preference",
    placement: "general",
    scope: "personalization",
    control: null,
    reader: `${renderer}/lib/theme.ts`
  },

  // --- AI setup: the mode, the class routes, the judge, the Decisions opt-in ------------------
  {
    id: "ai.preset.v1",
    store: "settings",
    category: "setup",
    placement: "ai",
    scope: "intelligence",
    control: null,
    reader: `${main}/services/ai-class-routes.ts`
  },
  {
    id: "relations.decisions",
    store: "settings",
    category: "setup",
    placement: "ai",
    scope: "intelligence",
    control: null,
    reader: `${main}/services/ai-decisions.ts`,
    defined: "packages/domain/src/relation-decisions.ts"
  },
  {
    id: "ai:decisions-openai-platform",
    store: "credential",
    category: "setup",
    placement: "ai",
    scope: "intelligence",
    control: null,
    reader: `${main}/services/ai-decisions.ts`,
    defined: "packages/domain/src/relation-decisions.ts"
  },

  // --- integrations ---------------------------------------------------------------------------
  {
    id: "metadataEnrichmentEnabled",
    store: "app.preferences",
    category: "integration",
    placement: "integrations",
    scope: "external-services",
    control: "bookMetadataProvider",
    reader: `${main}/index.ts`
  },
  {
    id: "bookMetadataProvider",
    store: "app.preferences",
    category: "integration",
    placement: "integrations",
    scope: "external-services",
    control: "bookMetadataProvider",
    reader: `${main}/index.ts`
  },
  {
    id: "metadata:google-books",
    store: "credential",
    category: "credential",
    placement: "integrations",
    scope: "external-services",
    control: "googleBooksApiKey",
    reader: `${main}/services/metadata-enrichment-service.ts`
  },
  {
    id: "obsidianVaultPath",
    store: "storage_settings",
    category: "integration",
    placement: "integrations",
    scope: "connections",
    control: "obsidianVaultPath",
    reader: `${main}/services/obsidian-sync-service.ts`
  },
  {
    id: "obsidianSyncEnabled",
    store: "storage_settings",
    category: "integration",
    placement: "integrations",
    scope: "connections",
    control: "obsidianSyncMode",
    reader: `${main}/services/obsidian-sync-service.ts`
  },
  {
    id: "obsidianSyncPaused",
    store: "storage_settings",
    category: "integration",
    placement: "integrations",
    scope: "connections",
    control: "obsidianSyncMode",
    reader: `${main}/services/obsidian-sync-service.ts`
  },
  {
    id: "obsidian.layout",
    store: "settings",
    category: "integration",
    placement: "integrations",
    scope: "connections",
    control: null,
    reader: `${main}/services/obsidian-wiki-projection.ts`
  },
  {
    id: "obsidian.wiki.scope",
    store: "settings",
    category: "integration",
    placement: "integrations",
    scope: "connections",
    control: null,
    reader: `${main}/services/obsidian-wiki-projection.ts`
  },

  // --- data -----------------------------------------------------------------------------------
  {
    id: "uploadCopiesEnabled",
    store: "storage_settings",
    category: "data",
    placement: "data",
    scope: "data",
    control: "uploadCopiesEnabled",
    reader: `${main}/services/ingestion-service.ts`
  },
  {
    id: "uploadCopiesFolderPath",
    store: "storage_settings",
    category: "data",
    placement: "data",
    scope: "data",
    control: "uploadCopiesFolderPath",
    reader: `${main}/services/ingestion-service.ts`
  },

  // --- import (not a Settings screen) ---------------------------------------------------------
  {
    id: "processingPresets",
    store: "app.preferences",
    category: "preference",
    placement: "import",
    scope: null,
    control: null,
    reader: `${renderer}/components/ProcessingPlanPicker.tsx`
  },

  // --- state with no control ------------------------------------------------------------------
  internal("navigationCollapsed", "app.preferences", `${renderer}/App.tsx`),
  internal("updatedAt", "app.preferences", `${main}/services/settings-service.ts`),
  internal("import.lastDirectory", "settings", `${main}/services/settings-service.ts`),
  internal("ai.classTests.v1", "settings", `${main}/services/ai-class-routes.ts`),
  internal("ai.routes.classMap.v1", "settings", `${main}/services/ai-route-mapping.ts`),
  internal(
    "relations.decisions.dailySpend",
    "settings",
    `${main}/services/relations/decisions-budget.ts`,
    "packages/domain/src/relation-decisions.ts"
  ),
  internal(
    "relations.decisions.state",
    "settings",
    `${main}/services/ai-decisions.ts`,
    "packages/domain/src/relation-decisions.ts"
  ),
  internal(
    "relations.ai.dailyCalls",
    "settings",
    `${main}/services/relations/relation-call-budget.ts`,
    "packages/domain/src/relations-config.ts"
  ),
  internal("catalogHeader.dailyRoots", "settings", `${main}/services/catalog-header-policy.ts`),
  internal(
    "gardener.budget.subscriptionCalls.v1",
    "settings",
    `${main}/services/gardener/remote-budget.ts`,
    "packages/domain/src/remote-budget.ts"
  ),
  internal(
    "gardener.budget.continue.v1",
    "settings",
    `${main}/services/gardener/remote-budget.ts`,
    "packages/domain/src/remote-budget.ts"
  ),
  internal(
    "gardener.audit.cursors.v1",
    "settings",
    `${main}/services/topic-tree/topic-audit-lints.ts`
  ),
  internal("topics.ai.daily.v1", "settings", `${main}/services/topic-tree/topic-ai.ts`),
  internal("topics.corpus.v1", "settings", `${main}/services/topic-tree/corpus-runner.ts`),
  internal("local-models.first-run-ranker", "settings", `${main}/services/first-run-ranker.ts`),
  internal("prompts.active", "settings", "packages/db/src/repositories/promptRepository.ts"),
  internal(
    "jobs.history.dismissed-through.v1",
    "settings",
    "packages/db/src/repositories/taskHistory.ts"
  ),
  internal(
    "obsidian.layout.presence",
    "settings",
    "packages/db/src/repositories/obsidianLayoutRepository.ts"
  ),
  internal(
    "obsidian.editorial.client",
    "settings",
    "packages/db/src/repositories/obsidianEditorialRepository.ts"
  ),
  internal(
    "relations.match.valuesHistory.v1",
    "settings",
    `${main}/services/relations/relation-match-values.ts`
  ),
  internal(
    "onboarding.v1",
    "settings",
    `${main}/services/onboarding/onboarding-service.ts`,
    "packages/domain/src/onboarding.ts"
  )
];

/**
 * E7's rule (D33): a persisted value with its own control on a Settings screen, outside an Advanced
 * disclosure, that changes what the app does by itself in the background. Setup (the AI routes) and
 * integrations are not automation; neither is anything inside Advanced.
 */
export function isVisibleAutomation(entry: SettingEntry): boolean {
  return entry.category === "automation" && entry.scope !== null && entry.placement !== "advanced";
}

/** The settings E7 counts. */
export function visibleAutomationSettings(
  registry: readonly SettingEntry[] = settingsRegistry
): SettingEntry[] {
  return registry.filter(isVisibleAutomation);
}
