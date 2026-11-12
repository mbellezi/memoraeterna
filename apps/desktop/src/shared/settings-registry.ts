// The settings registry. The first half (F4 T98, D33) is the v1 registry that feeds the Settings
// screen of F4: every persisted setting with the screen that shows it, its category for E7 and
// the code that reads it. It goes with `SettingsView` when T166 deletes it. The second half is the
// v2 registry (F5 T159, D17, `settingsRegistryV2`) that Settings v2, the search and the reset read;
// `M/settings-registry.test.ts` holds it to a body that reads each key, to a reader that is not a
// schema or a test, and to a path from an app entry point. A setting added without an entry fails it.
import {
  defaultKnowledgeControls,
  recommendedMatchingConfiguration,
  recommendedMatchingPresetId,
  type MatchingValueControlId
} from "@app/domain";

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
  // `navigationCollapsed` left this list in F5 T159: the rail no longer collapses (T135).
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

// =================================================================================================
// Registry v2 (F5 T159, D17, spec 3.8). One entry per control of Settings v2: the persisted
// settings, the six workload routes, the provider credentials and the pages, in the order of the
// Settings v2 mockup. Persisted state with no control is `persistedStateRegistry`. The copy
// (`labelKey`, `helpKey`, the group names) lives in `@app/i18n` under `settingsRegistry`; the English
// keywords are `settingKeywords` below (T175). `settingsRegistryV2` takes
// the name `settingsRegistry` when T166 deletes the v1 rows above.
// =================================================================================================

/** The seven sections of Settings v2, in navigation order (D17). */
export const settingsSectionIds = [
  "general",
  "ai",
  "knowledge",
  "library",
  "integrations",
  "privacy",
  "advanced"
] as const;
export type SettingsSectionId = (typeof settingsSectionIds)[number];

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** What the control is. `block` is a read-only panel; `page` opens a page of its own. */
export type ControlKind =
  | "switch"
  | "select"
  | "segmented"
  | "choice"
  | "number"
  | "range"
  | "text"
  | "folder"
  | "copies"
  | "credential"
  | "action"
  | "info"
  | "page"
  | "block";

/** Where the value lives. `none`: nothing is stored (an action, a page or a read-only panel). */
export type StoreKind = SettingStore | "route" | "none";
/** `keys` are the stored keys the control edits (a merged control lists more than one). */
export interface StoreRef {
  kind: StoreKind;
  keys: readonly string[];
}

/** The value a "changed" marker compares with, and what a reset restores. */
export type DefaultRef =
  | { value: Json }
  | { osLocale: true }
  | { unset: true }
  /** Depends on the machine or on another setting; the key names what it depends on. */
  | { computed: string };

/**
 * How T160 puts a setting back; each adapter writes through the setting's existing writer, so a key
 * with a dedicated writer has an adapter that names it (`obsidian-layout` is the journaled layout
 * migration, which moves the vault's folders; `obsidian-wiki-scope` is `saveScope`).
 */
export const resetAdapterIds = [
  "ai-preset",
  "ai-route",
  "app-preference",
  "book-lookup",
  "credential",
  "decider-mode",
  "decisions-opt-in",
  "knowledge-control",
  "matching-preset",
  "matching-value",
  "none",
  "obsidian-layout",
  "obsidian-sync",
  "obsidian-wiki-scope",
  "storage-setting",
  "upload-copies"
] as const;
export type ResetAdapterId = (typeof resetAdapterIds)[number];

export type PageId =
  | "backup"
  | "callLog"
  | "gateway"
  | "models"
  | "processingPresets"
  | "profiles"
  | "prompts"
  | "taskHistory";

/** `tool` is an entry with no stored value: an action, a page, a read-only panel. */
export type EntryCategory = SettingCategory | "tool";

/** The message keys the copy card (T175) writes, one pair per entry. */
export type SettingMessageKey = `settingsRegistry.${string}.${"label" | "help"}`;

export interface SettingEntryV2 {
  /** The stored key path, or the control's own id when it merges keys or stores nothing. */
  id: string;
  section: SettingsSectionId;
  /** A group of the section; its name is `settingsRegistry.groups.<section>.<group>`. */
  group: string;
  labelKey: SettingMessageKey;
  helpKey: SettingMessageKey;
  /** English synonyms and task words for the search (T175). */
  keywords: string[];
  control: ControlKind;
  store: StoreRef;
  /** The Settings screen of F4 that shows it today; absent for what has no such control. */
  scope?: SettingsScope;
  default: DefaultRef;
  reset: ResetAdapterId;
  /** Production code that reads the value (or, with no store, performs the action). */
  reader: { file: string; symbol: string };
  /** Behind an Advanced disclosure in a section other than Advanced. */
  advanced?: boolean;
  page?: PageId;
  category: EntryCategory;
}

/** Persisted state with no control (counters, cursors, markers): it needs a reader, not a label. */
export interface PersistedStateEntry {
  id: string;
  store: StoreRef;
  reader: { file: string; symbol: string };
}

/** The flat message-key name of an entry id: `ai.preset.v1` is `aiPresetV1`. */
export function settingSlug(id: string): string {
  return id
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

const base = "apps/desktop/src/main/services";
const rendererApp = "apps/desktop/src/renderer/App.tsx";
const mainIndex = "apps/desktop/src/main/index.ts";
const read = (file: string, symbol: string) => ({ file, symbol });
/** The top-level code of a module (the main entry point wires its readers inline). */
const moduleCode = "<module>";

const matchingDefault = (id: MatchingValueControlId): Json => {
  const [group, member] = id.split(".") as [string, string | undefined];
  const configuration = recommendedMatchingConfiguration as unknown as Record<string, Json>;
  const value = member
    ? (configuration[group] as Record<string, Json> | undefined)?.[member]
    : configuration[group];
  return value ?? null;
};

/**
 * The English synonyms and task words of each entry (F5 T175): what a person types when they know
 * what they want and not what Settings calls it. The search matches them in every language, by the
 * start of each word, so an entry lists single words and the words of a phrase. A control that
 * stores a number lists the quantity it limits; a switch lists what turning it off does.
 */
const settingKeywords: Readonly<Record<string, string>> = {
  themeMode:
    "theme dark light night mode appearance colors color scheme system dark mode light mode",
  contentLanguage:
    "content language notes language writing summaries translation generated text output language answers topic names",
  language:
    "app language interface language ui menus buttons messages locale translate display language",
  "ai.preset.v1":
    "setup preset mode local hybrid cloud custom offline no internet run on this mac private where ai runs on device",
  "ai.provider.openai-codex":
    "chatgpt codex subscription oauth sign in login connect account provider plus pro openai",
  "ai.provider.openai-compatible":
    "openai compatible api key base url endpoint custom server openrouter lm studio ollama proxy provider",
  "ai.provider.google": "google gemini api key provider cloud model gemini key ai studio",
  "ai.thisMac":
    "this mac hardware chip memory ram apple silicon recommended setup tier specs which models fit",
  "ai.route.embed":
    "embeddings embedding vectors search model semantic similarity topics matching index",
  "ai.route.decide":
    "ranking ranker rerank decide relations related notes scoring judge matching model decider",
  "ai.route.write-fast":
    "quick writing fast model summaries topic names short explanations cheap small model writer",
  "ai.route.write-quality":
    "careful writing quality model notes entities knowledge graph best writer large model",
  "ai.route.answer": "answers ask questions model chat answer model responses question answering",
  "ai.route.judge":
    "generative judge decide relations when no ranker writing model judge sources relate decider fallback",
  "ai.models":
    "local models download install gguf import mlx catalog hugging face test default models on this mac",
  "local-models.repository-token-ref":
    "hugging face token hf access token private repository gated models download credentials",
  "ai.profiles":
    "profiles model parameters temperature max tokens reasoning effort settings per profile advanced model options",
  "relations.decisions":
    "openai decisions remote decider cloud ranker cheaper accurate connections relations paid opt in",
  "ai:decisions-openai-platform":
    "openai platform api key decisions credential secret token key for decisions",
  "knowledge.controls.v1.autonomy":
    "autonomy gardener automation off suggest automatic how much auto ask first confirm approve automatic manual hands off",
  "knowledge.controls.v1.paused":
    "pause gardener stop background work automation resume halt freeze disable",
  "knowledge.controls.v1.monthlyCapUsd":
    "monthly cap budget spending limit cost money dollars usd cloud spend maximum price",
  "knowledge.controls.v1.treeShape":
    "tree shape topics balanced broad deep shallow organization structure hierarchy depth broad flat narrow",
  "knowledge.controls.v1.onlyIdle":
    "idle only when idle mac not in use background wait inactive away battery cpu schedule quiet",
  "knowledge.controls.v1.onlyOnAc":
    "plugged in power adapter ac charger battery only on power laptop schedule save battery",
  relationLabels:
    "relation descriptions labels connection text regenerate rewrite missing descriptions language explanation connections",
  "library.storage":
    "storage database where data lives files folder location disk size space library location path",
  uploadCopies:
    "upload copies keep original files copy folder store imports originals backup copy of uploads second copy",
  "library.backup":
    "backup restore export copy database safety archive save library verify recover dated folder",
  processingPresets:
    "import plans processing presets saved plans import settings rename delete templates import options",
  obsidianVaultPath:
    "obsidian vault folder path directory pick choose notes sync location markdown vault location",
  obsidianSync:
    "obsidian sync two way on off pause markdown notes export vault write library back edits synchronize",
  "obsidian.wiki.scope":
    "obsidian wiki pages sources scope which sources become pages choose sources limit 100 publish export subset",
  "obsidian.wiki.includeDescendants":
    "chapters parts descendants include children sub sources obsidian wiki nested sections",
  "obsidian.layout.attachments":
    "attachments copy original files pdf images obsidian vault attach files text only binary files",
  bookLookup:
    "book lookup metadata internet isbn doi crossref google books cover authors title online fetch details lookup",
  "metadata:google-books":
    "google books api key metadata credential lookup quota rate limit book key",
  "integrations.gateway":
    "paired apps pairing chrome extension obsidian plugin connect local gateway mcp token browser extension clipper pair devices",
  "privacy.summary":
    "privacy what leaves this mac data sent remote cloud providers external network offline local only sharing",
  "privacy.clearViewHistory":
    "clear recents history recently opened list erase view history delete recent items",
  "privacy.clearQuestions":
    "delete questions erase answers ask history clear conversations saved questions remove chats",
  "privacy.callLog":
    "ai calls log recent calls what was sent models requests providers tokens history audit transparency",
  "privacy.reset":
    "reset everything wipe erase all data factory reset start over delete library clean slate danger zone",
  activeMatchingPresetId:
    "matching preset calibrated balanced recommended duplicate custom matching profile correspondence thresholds defaults",
  relationTypeSimilarityThreshold:
    "relation type similarity threshold cutoff merge types duplicates candidates strictness embedding score",
  entityIdentitySimilarityThreshold:
    "entity identity similarity threshold cutoff merge entities duplicates same person place candidates strictness",
  "canonicalMatchingSettings.relationTypeCandidateLimit":
    "candidates per relation type limit how many candidates relation types compare top k maximum",
  "canonicalMatchingSettings.entityCandidateLimit":
    "candidates per entity limit how many candidates entities compare top k maximum",
  "canonicalMatchingSettings.confirmationBatchSize":
    "identities per confirmation batch size request group items per call confirm batch count",
  "canonicalMatchingSettings.confirmationMaxCharacters":
    "confirmation batch characters size limit max characters text length per request prompt size",
  "atomicNoteMatchingSettings.maxRerankOutputTokens":
    "output token limit per note rerank max tokens ai output atomic notes answer length cap cost",
  "sourceRelationSettings.evidenceChunksPerSource":
    "evidence passages per source pair chunks excerpts quotes how many passages source relations context",
  "sourceRelationSettings.evidenceMaxCharacters":
    "characters per evidence passage excerpt length max characters passage size text limit",
  "sourceRelationSettings.summaryMaxCharacters":
    "summary characters per source summary length max characters source summary size",
  "sourceRelationSettings.maxOutputTokens":
    "output token limit per source pair max tokens ai output answer length cap cost source relations",
  "sourceRelationSettings.maxRelationsPerPair":
    "relations per source pair maximum connections between two sources limit how many relations cap",
  "sourceRelationSettings.maxInputTokens":
    "input token budget max input tokens limit cost cap per run source relations spending ceiling context size",
  "sourceRelationSettings.minImportance":
    "minimum importance conceptual importance threshold score filter relations quality cutoff weak relations",
  "sourceRelationSettings.minConfidence":
    "minimum confidence evidence confidence threshold score filter relations certainty cutoff",
  "sourceRelationSettings.includeWeakTypes":
    "weak relation types mentions related generic allow include vague connections loose links noise",
  summaryMinimumWordCount:
    "minimum words summary short items skip summaries word count threshold tiny sources save calls zero off",
  keepLocalEmbeddingModelsLoaded:
    "keep model loaded memory ram local embedding model preload unload faster search free memory resident",
  "relations.deciderMode":
    "decider mode who decides relations ranker judge automatic ranker only judge only matching connections decision",
  graphWheelZoomSensitivity:
    "graph zoom sensitivity speed mouse wheel scroll trackpad map zoom faster slower scale pinch",
  managedRoot:
    "managed folder root obsidian vault subfolder memora folder where files written directory name inside vault",
  "obsidian.layout.language":
    "vault folder language folder names obsidian layout language override rename folders translate folders",
  "advanced.prompts":
    "prompts instructions system prompts edit templates revisions catalog prompt text customize wording",
  debugMode:
    "debug diagnostics logging verbose trace troubleshoot problem investigate bug log operations similarity canonicalization",
  debugFullCapture:
    "full capture prompts responses complete text store raw record everything debug capture sensitive",
  "advanced.callLog":
    "ai call log history requests model calls tokens time latency cost audit prune read only log of calls",
  "advanced.taskHistory":
    "task history jobs finished failed cancelled runs past jobs activity log completed jobs history of jobs",
  "advanced.similarityRuns":
    "similarity debug runs clear delete comparisons recorded diagnostics erase similarity logs cleanup"
};
const keywordsOf = (id: string): string[] => [
  ...new Set((settingKeywords[id] ?? "").split(" ").filter(Boolean))
];

type Spec = Omit<SettingEntryV2, "labelKey" | "helpKey" | "keywords" | "category"> & {
  category?: EntryCategory;
};
const entry = (spec: Spec): SettingEntryV2 => ({
  ...spec,
  labelKey: `settingsRegistry.${settingSlug(spec.id)}.label`,
  helpKey: `settingsRegistry.${settingSlug(spec.id)}.help`,
  keywords: keywordsOf(spec.id),
  category: spec.category ?? "tool"
});
const at = (kind: StoreKind, ...keys: string[]): StoreRef => ({ kind, keys });
const nothing: StoreRef = { kind: "none", keys: [] };
/** A page, an action or a panel: no stored value, nothing to reset. */
const tool = (
  id: string,
  section: SettingsSectionId,
  group: string,
  control: ControlKind,
  reader: SettingEntryV2["reader"],
  more: Partial<Spec> = {}
) =>
  entry({
    id,
    section,
    group,
    control,
    store: nothing,
    default: { unset: true },
    reset: "none",
    reader,
    ...more
  });

const preference = (
  id: string,
  section: SettingsSectionId,
  group: string,
  control: ControlKind,
  value: DefaultRef,
  reader: SettingEntryV2["reader"],
  more: Partial<Spec> = {}
) =>
  entry({
    id,
    section,
    group,
    control,
    store: at("app.preferences", id),
    default: value,
    reset: "app-preference",
    reader,
    category: "preference",
    ...more
  });

const route = (name: string, key: string) =>
  entry({
    id: `ai.route.${name}`,
    section: "ai",
    group: "routes",
    control: "select",
    store: at("route", key),
    default: { computed: "ai.route.presetDefault" },
    reset: "ai-route",
    reader: read(`${base}/ai-class-routes.ts`, "AiClassRouteService.readView"),
    scope: "intelligence",
    category: "setup"
  });

const credential = (
  id: string,
  section: SettingsSectionId,
  group: string,
  reader: SettingEntryV2["reader"],
  more: Partial<Spec> = {}
) =>
  entry({
    id,
    section,
    group,
    control: "credential",
    store: at("credential", id),
    default: { unset: true },
    reset: "credential",
    reader,
    category: "credential",
    ...more
  });

const knowledgeControlKinds: Record<keyof typeof knowledgeControlDomIds, ControlKind> = {
  autonomy: "choice",
  monthlyCapUsd: "number",
  paused: "switch",
  treeShape: "segmented",
  onlyIdle: "switch",
  onlyOnAc: "switch"
};
const knowledge = (field: keyof typeof knowledgeControlDomIds, group: string, symbol: string) =>
  entry({
    id: `knowledge.controls.v1.${field}`,
    section: "knowledge",
    group,
    control: knowledgeControlKinds[field],
    store: at("settings", `knowledge.controls.v1.${field}`),
    default: { value: defaultKnowledgeControls[field] as Json },
    reset: "knowledge-control",
    reader: read(
      field === "monthlyCapUsd" || field === "treeShape"
        ? mainIndex
        : `${base}/gardener/background-gate.ts`,
      symbol
    ),
    scope: "knowledge",
    category: "automation"
  });

const matching = (id: MatchingValueControlId, file: string, symbol: string) =>
  entry({
    id,
    section: "advanced",
    group: "matching",
    control: id === "sourceRelationSettings.includeWeakTypes" ? "switch" : "number",
    store: at("app.preferences", id),
    default: { value: matchingDefault(id) },
    reset: "matching-value",
    reader: read(file, symbol),
    scope: "knowledge",
    category: "automation"
  });

const sourceJudge = `${base}/source-relation-processing.ts`;
const pairIdentity = "sourceJudgeRequestSettings";
const aiService = `${base}/ai-service.ts`;
/** The column of `ai_provider_configs` that names the secret of a provider; one path reads it for all three. */
const providerCredentialKey = "ai_provider_configs.credentialRef";
const monitoring = `${base}/monitoring-service.ts`;
const wikiProjection = `${base}/obsidian-wiki-projection.ts`;

/** Every control of Settings v2, in the order of the mockup. */
export const settingsRegistryV2: readonly SettingEntryV2[] = [
  // --- General: what people change most ------------------------------------------------------
  preference(
    "language",
    "general",
    "language",
    "select",
    { osLocale: true },
    read(rendererApp, "App"),
    {
      scope: "personalization"
    }
  ),
  preference(
    "contentLanguage",
    "general",
    "language",
    "select",
    { osLocale: true },
    read(mainIndex, moduleCode),
    {
      scope: "personalization"
    }
  ),
  preference(
    "themeMode",
    "general",
    "appearance",
    "segmented",
    { value: "dark" },
    read(rendererApp, "App"),
    {
      scope: "personalization"
    }
  ),

  // --- AI: the setup first, then the providers, the machine and the route of each job ---------
  entry({
    id: "ai.preset.v1",
    section: "ai",
    group: "setup",
    control: "choice",
    store: at("settings", "ai.preset.v1"),
    default: { computed: "ai.preset.recommendedForThisMac" },
    reset: "ai-preset",
    reader: read(`${base}/ai-class-routes.ts`, "AiClassRouteService.readState"),
    scope: "intelligence",
    category: "setup"
  }),
  credential(
    "ai.provider.openai-codex",
    "ai",
    "providers",
    read(aiService, "AiService.buildRemoteAdapter"),
    {
      store: at("credential", providerCredentialKey)
    }
  ),
  credential(
    "ai.provider.openai-compatible",
    "ai",
    "providers",
    read(aiService, "AiService.buildRemoteAdapter"),
    {
      store: at("credential", providerCredentialKey)
    }
  ),
  credential(
    "ai.provider.google",
    "ai",
    "providers",
    read(aiService, "AiService.buildRemoteAdapter"),
    {
      store: at("credential", providerCredentialKey)
    }
  ),
  tool(
    "ai.thisMac",
    "ai",
    "thisMac",
    "block",
    read(`${base}/hardware/hardware-service.ts`, "HardwareService.profile")
  ),
  route("embed", "class:embed"),
  route("decide", "class:decide"),
  route("write-fast", "class:write-fast"),
  route("write-quality", "class:write-quality"),
  route("answer", "class:answer"),
  route("judge", "judge"),
  tool(
    "ai.models",
    "ai",
    "models",
    "page",
    read(`${base}/local-model-service.ts`, "LocalModelService"),
    {
      scope: "models",
      page: "models"
    }
  ),
  credential(
    "local-models.repository-token-ref",
    "ai",
    "models",
    read(`${base}/local-model-service.ts`, "LocalModelService.getRepositoryToken"),
    { scope: "models", store: at("settings", "local-models.repository-token-ref") }
  ),
  tool("ai.profiles", "ai", "models", "page", read(aiService, "AiService.listProfiles"), {
    scope: "intelligence",
    page: "profiles"
  }),
  entry({
    id: "relations.decisions",
    section: "ai",
    group: "decisions",
    control: "switch",
    store: at("settings", "relations.decisions"),
    default: { value: false },
    reset: "decisions-opt-in",
    reader: read(`${base}/ai-decisions.ts`, "DecisionsRuntime.storedEnabled"),
    scope: "intelligence",
    category: "setup"
  }),
  credential(
    "ai:decisions-openai-platform",
    "ai",
    "decisions",
    read(`${base}/ai-decisions.ts`, "DecisionsRuntime.readKey"),
    { scope: "intelligence", category: "setup" }
  ),

  // --- Knowledge: the gardener, the tree, when to work -----------------------------------------
  knowledge("autonomy", "gardener", "BackgroundGate.activeReasons"),
  knowledge("paused", "gardener", "sharedHolds"),
  knowledge("monthlyCapUsd", "gardener", moduleCode),
  knowledge("treeShape", "tree", moduleCode),
  knowledge("onlyIdle", "schedule", "sharedHolds"),
  knowledge("onlyOnAc", "schedule", "sharedHolds"),
  tool(
    "relationLabels",
    "knowledge",
    "connections",
    "action",
    read(`${base}/relation-explanation-service.ts`, "RelationExplanationService.backfill"),
    { scope: "personalization" }
  ),

  // --- Library and storage ---------------------------------------------------------------------
  tool(
    "library.storage",
    "library",
    "data",
    "block",
    read(`${base}/database-service.ts`, "DatabaseService"),
    {
      scope: "data"
    }
  ),
  entry({
    id: "uploadCopies",
    section: "library",
    group: "uploads",
    control: "copies",
    store: at("storage_settings", "uploadCopiesEnabled", "uploadCopiesFolderPath"),
    default: { value: false },
    reset: "upload-copies",
    reader: read(`${base}/ingestion-service.ts`, "IngestionService.stageAssetFiles"),
    scope: "data",
    category: "data"
  }),
  tool(
    "library.backup",
    "library",
    "backup",
    "page",
    read(`${base}/backup-service.ts`, "BackupService.create"),
    {
      scope: "data",
      page: "backup"
    }
  ),
  entry({
    id: "processingPresets",
    section: "library",
    group: "imports",
    control: "page",
    store: at("app.preferences", "processingPresets"),
    default: { unset: true },
    reset: "app-preference",
    reader: read(
      "apps/desktop/src/renderer/components/ProcessingPlanPicker.tsx",
      "ProcessingPlanPicker"
    ),
    page: "processingPresets",
    category: "preference"
  }),

  // --- Integrations ----------------------------------------------------------------------------
  entry({
    id: "obsidianVaultPath",
    section: "integrations",
    group: "obsidian",
    control: "folder",
    store: at("storage_settings", "obsidianVaultPath"),
    default: { unset: true },
    reset: "storage-setting",
    reader: read(`${base}/obsidian-sync-service.ts`, "ObsidianSyncService.reconcileVault"),
    scope: "connections",
    category: "integration"
  }),
  entry({
    id: "obsidianSync",
    section: "integrations",
    group: "obsidian",
    control: "segmented",
    store: at("storage_settings", "obsidianSyncEnabled", "obsidianSyncPaused"),
    default: { value: "off" },
    reset: "obsidian-sync",
    reader: read(`${base}/obsidian-sync-service.ts`, "isSyncActive"),
    scope: "connections",
    category: "integration"
  }),
  entry({
    id: "obsidian.wiki.scope",
    section: "integrations",
    group: "obsidian",
    control: "info",
    store: at("settings", "obsidian.wiki.scope"),
    default: { unset: true },
    reset: "obsidian-wiki-scope",
    reader: read(wikiProjection, "ObsidianWikiProjection.scope"),
    scope: "connections",
    category: "integration"
  }),
  entry({
    id: "obsidian.wiki.includeDescendants",
    section: "integrations",
    group: "obsidian",
    control: "switch",
    store: at("settings", "obsidian.wiki.scope"),
    default: { value: true },
    reset: "obsidian-wiki-scope",
    reader: read(wikiProjection, "ObsidianWikiProjection.scope"),
    scope: "connections",
    category: "integration"
  }),
  entry({
    id: "obsidian.layout.attachments",
    section: "integrations",
    group: "obsidian",
    control: "switch",
    store: at("settings", "obsidian.layout"),
    default: { value: "omit" },
    reset: "obsidian-layout",
    reader: read(wikiProjection, "ObsidianWikiProjection.layout"),
    scope: "connections",
    category: "integration"
  }),
  entry({
    id: "bookLookup",
    section: "integrations",
    group: "books",
    control: "select",
    store: at("app.preferences", "metadataEnrichmentEnabled", "bookMetadataProvider"),
    default: { value: "auto" },
    reset: "book-lookup",
    reader: read(mainIndex, moduleCode),
    scope: "external-services",
    category: "integration"
  }),
  credential(
    "metadata:google-books",
    "integrations",
    "books",
    read(`${base}/metadata-enrichment-service.ts`, "MetadataEnrichmentService.getGoogleBooksKey"),
    { scope: "external-services" }
  ),
  tool(
    "integrations.gateway",
    "integrations",
    "local",
    "page",
    read(`${base}/integration-gateway.ts`, "IntegrationGateway.getStatus"),
    {
      scope: "connections",
      page: "gateway"
    }
  ),

  // --- Privacy and data ------------------------------------------------------------------------
  tool(
    "privacy.summary",
    "privacy",
    "leaving",
    "block",
    read(aiService, "AiService.pinOrganizationProfile")
  ),
  tool(
    "privacy.clearViewHistory",
    "privacy",
    "history",
    "action",
    read(`${base}/view-history-service.ts`, "ViewHistoryService.clear")
  ),
  tool(
    "privacy.clearQuestions",
    "privacy",
    "history",
    "action",
    read(`${base}/questions-service.ts`, "QuestionsService.clear")
  ),
  tool("privacy.callLog", "privacy", "logs", "block", read(monitoring, "MonitoringService.list")),
  tool(
    "privacy.reset",
    "privacy",
    "reset",
    "action",
    read(`${base}/library-reset-service.ts`, "LibraryResetService.reset"),
    {
      scope: "data"
    }
  ),

  // --- Advanced: matching (Q4), processing, local models, the map, Obsidian, prompts, diagnostics -
  entry({
    id: "activeMatchingPresetId",
    section: "advanced",
    group: "matching",
    control: "select",
    store: at("app.preferences", "activeMatchingPresetId", "matchingPresets"),
    default: { value: recommendedMatchingPresetId },
    reset: "matching-preset",
    reader: read(`${base}/settings-service.ts`, "SettingsService.updateApp"),
    scope: "knowledge",
    category: "automation"
  }),
  matching("relationTypeSimilarityThreshold", mainIndex, moduleCode),
  matching("entityIdentitySimilarityThreshold", mainIndex, moduleCode),
  matching(
    "canonicalMatchingSettings.relationTypeCandidateLimit",
    `${base}/relation-type-resolution.ts`,
    "createRelationTypeResolver"
  ),
  matching(
    "canonicalMatchingSettings.entityCandidateLimit",
    `${base}/entity-identity-resolution.ts`,
    "createEntityIdentityResolver"
  ),
  matching(
    "canonicalMatchingSettings.confirmationBatchSize",
    `${base}/entity-identity-resolution.ts`,
    "createEntityIdentityResolver"
  ),
  matching(
    "canonicalMatchingSettings.confirmationMaxCharacters",
    `${base}/entity-identity-resolution.ts`,
    "createEntityIdentityResolver"
  ),
  matching(
    "atomicNoteMatchingSettings.maxRerankOutputTokens",
    `${base}/relations/relation-matcher.ts`,
    "RelationMatcher.matchNotes"
  ),
  matching("sourceRelationSettings.evidenceChunksPerSource", sourceJudge, pairIdentity),
  matching("sourceRelationSettings.evidenceMaxCharacters", sourceJudge, pairIdentity),
  matching("sourceRelationSettings.summaryMaxCharacters", sourceJudge, pairIdentity),
  matching("sourceRelationSettings.maxOutputTokens", sourceJudge, pairIdentity),
  matching("sourceRelationSettings.maxRelationsPerPair", sourceJudge, pairIdentity),
  matching("sourceRelationSettings.maxInputTokens", sourceJudge, "judgeRoot"),
  matching(
    "sourceRelationSettings.minImportance",
    "packages/domain/src/source-relations.ts",
    "sourceDecisionPassesFloors"
  ),
  matching(
    "sourceRelationSettings.minConfidence",
    "packages/domain/src/source-relations.ts",
    "sourceDecisionPassesFloors"
  ),
  matching("sourceRelationSettings.includeWeakTypes", sourceJudge, pairIdentity),
  preference(
    "summaryMinimumWordCount",
    "advanced",
    "processing",
    "number",
    { value: 40 },
    read(mainIndex, moduleCode),
    {
      scope: "knowledge",
      category: "automation"
    }
  ),
  preference(
    "keepLocalEmbeddingModelsLoaded",
    "advanced",
    "localModels",
    "switch",
    { value: true },
    read(mainIndex, moduleCode),
    {
      scope: "intelligence",
      category: "automation"
    }
  ),
  entry({
    id: "relations.deciderMode",
    section: "advanced",
    group: "connections",
    control: "select",
    store: at("settings", "relations.deciderMode"),
    default: { unset: true },
    reset: "decider-mode",
    reader: read(`${base}/relations/relation-matcher.ts`, "RelationMatcher.resolveDecider"),
    scope: "intelligence",
    category: "automation"
  }),
  preference(
    "graphWheelZoomSensitivity",
    "advanced",
    "map",
    "range",
    { value: 1 },
    read(rendererApp, "App"),
    {
      scope: "personalization"
    }
  ),
  entry({
    id: "managedRoot",
    section: "advanced",
    group: "obsidian",
    control: "text",
    store: at("storage_settings", "managedRoot"),
    default: { value: "Memora" },
    reset: "storage-setting",
    reader: read(`${base}/obsidian-sync-service.ts`, "ObsidianSyncService.reconcileVault"),
    scope: "connections",
    category: "integration"
  }),
  entry({
    id: "obsidian.layout.language",
    section: "advanced",
    group: "obsidian",
    control: "select",
    store: at("settings", "obsidian.layout"),
    default: { computed: "obsidian.layout.followsContentLanguage" },
    reset: "obsidian-layout",
    reader: read(wikiProjection, "ObsidianWikiProjection.layout"),
    scope: "connections",
    category: "integration"
  }),
  tool(
    "advanced.prompts",
    "advanced",
    "prompts",
    "page",
    read(`${base}/prompt-service.ts`, "PromptService"),
    {
      scope: "prompts",
      page: "prompts"
    }
  ),
  preference(
    "debugMode",
    "advanced",
    "diagnostics",
    "switch",
    { value: false },
    read(monitoring, "MonitoringService.start"),
    {
      category: "diagnostics"
    }
  ),
  preference(
    "debugFullCapture",
    "advanced",
    "diagnostics",
    "switch",
    { value: false },
    read(monitoring, "MonitoringService.start"),
    {
      category: "diagnostics"
    }
  ),
  tool(
    "advanced.callLog",
    "advanced",
    "diagnostics",
    "page",
    read(monitoring, "MonitoringService.prune"),
    {
      page: "callLog"
    }
  ),
  tool(
    "advanced.taskHistory",
    "advanced",
    "diagnostics",
    "page",
    read(`${base}/job-supervisor.ts`, "JobSupervisor.listWithRuns"),
    {
      page: "taskHistory"
    }
  ),
  tool(
    "advanced.similarityRuns",
    "advanced",
    "diagnostics",
    "action",
    read(`${base}/similarity-debug-service.ts`, "SimilarityDebugService.clear")
  )
];

const state = (
  id: string,
  file: string,
  symbol: string,
  kind: StoreKind = "settings"
): PersistedStateEntry => ({ id, store: at(kind, id), reader: read(file, symbol) });
const repositories = "packages/db/src/repositories";

/** Persisted state no control edits. The reader test holds it to a reader like any other row. */
export const persistedStateRegistry: readonly PersistedStateEntry[] = [
  state("updatedAt", rendererApp, "App", "app.preferences"),
  state("import.lastDirectory", `${base}/settings-service.ts`, "createDbSettingsRepository"),
  state("ai.classTests.v1", `${base}/ai-class-routes.ts`, "AiClassRouteService.readState"),
  state("ai.routes.classMap.v1", `${base}/ai-route-mapping.ts`, "createRouteMappingStore"),
  state(
    "relations.decisions.dailySpend",
    `${base}/relations/decisions-budget.ts`,
    "createDecisionsSpendBudget"
  ),
  state("relations.decisions.state", `${base}/ai-decisions.ts`, "DecisionsRuntime.readState"),
  state(
    "relations.ai.dailyCalls",
    `${base}/relations/relation-call-budget.ts`,
    "createRelationCallBudget"
  ),
  state(
    "catalogHeader.dailyRoots",
    `${base}/job-supervisor.ts`,
    "JobSupervisor.catalogHeaderExecutor"
  ),
  state(
    "gardener.budget.subscriptionCalls.v1",
    `${base}/gardener/remote-budget.ts`,
    "RemoteBudget.current"
  ),
  state("gardener.budget.continue.v1", `${base}/gardener/remote-budget.ts`, "RemoteBudget.current"),
  state(
    "gardener.audit.cursors.v1",
    `${base}/topic-tree/topic-audit-lints.ts`,
    "AuditLints.readCursors"
  ),
  state("topics.ai.daily.v1", `${base}/topic-tree/topic-ai.ts`, "settingsAiBudgetStore"),
  state("topics.corpus.v1", `${base}/topic-tree/corpus-runner.ts`, "CorpusRunner.readMarker"),
  state(
    "local-models.first-run-ranker",
    `${base}/first-run-ranker.ts`,
    "settingsFirstRunRankerStore"
  ),
  state("prompts.active", `${repositories}/promptRepository.ts`, "createPromptRepository"),
  state(
    "jobs.history.dismissed-through.v1",
    `${repositories}/taskHistory.ts`,
    "taskHistoryVisibleSql"
  ),
  state(
    "obsidian.layout.presence",
    `${repositories}/obsidianLayoutRepository.ts`,
    "createObsidianLayoutRepository"
  ),
  state(
    "obsidian.editorial.client",
    `${repositories}/obsidianEditorialRepository.ts`,
    "createObsidianEditorialRepository"
  ),
  state(
    "relations.match.valuesHistory.v1",
    `${base}/relations/relation-match-backlog.ts`,
    "RelationMatchBacklog.recordedValues"
  ),
  state("onboarding.v1", `${base}/onboarding/onboarding-service.ts`, "pgOnboardingStore")
];

/**
 * Keys that were persisted settings and are not any more: no entry, and no production code reads
 * them. `navigationCollapsed` stays in the stored schema (`S/ipc.ts`) until the owner of that chain
 * file drops it; nothing reads it (the rail no longer collapses, F5 T135).
 */
export const retiredSettingKeys = [
  "deletionPolicy",
  "knowledgeGraphMaxEntitiesPerSource",
  "knowledgeGraphMaxRelationsPerSource",
  "navigationCollapsed",
  "wikiTreeWidth"
] as const;

/** E7 on v2: an `automation` entry outside Advanced (the section or the disclosure). */
export function visibleAutomationEntries(
  registry: readonly SettingEntryV2[] = settingsRegistryV2
): SettingEntryV2[] {
  return registry.filter(
    (candidate) =>
      candidate.category === "automation" && candidate.section !== "advanced" && !candidate.advanced
  );
}
