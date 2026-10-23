# Settings inventory (F4 T68, 2026-10-23)

Every persisted setting of the application at `refactoring` 35587041, with its reader, default, screen, fate and
category for E7. It is the input of T98 (the `settingsRegistry`, the Settings cut, the removal of dead keys, the static
tests) and of F5 (Settings v2). Binding sources: `docs/plan.md` decision 24, the F4 spec's D33 and E7
(`docs/f4-decisions.md` once T67 merges; until then `.cache/f4/spec-final.md`), and the owner's answer Q4 of 2026-10-23:
**the 17 matching controls and the two matching-preset keys go to Advanced › Matching, not to typed config.** Where this
file and a map differ, this file wins: it was read against the code at the commit above. Line numbers drift; re-find a
symbol with `grep -n` before relying on a line.

## 1. Result

- **The counts hold.** 35 controls by the strict rule (34 without the Decisions API key field); 43 by the broad rule is
  34 plus nine more value controls (35 plus nine is 44 with the key); 47 value controls in all on the Settings screens,
  plus three credential fields. The matching controls are **17** (section 3.2); the map's prose says 20 and cannot be
  reproduced: its own table and the code count 17, and the preset buttons, the two "reset" buttons and the per-field
  reset buttons are actions, not values.
- **By D33's rule** the 35 are 22 `automation`, 9 `setup` and 4 `integration`. Nine of the 22 already sit inside a
  `<details>` ("Advanced matching"), so 13 are outside a disclosure today. After T98 all 22 sit in Advanced and the six
  Knowledge controls are the only `automation` controls outside it: E7 reads 6.
- **Dead (section 10).** One key has no reader: `app.preferences.wikiTreeWidth`. One setting has a reader that changes
  nothing: `storage_settings.deletionPolicy` (its only read copies the value into Obsidian record metadata that no code
  reads, on a path format-2 records skip). Two profile columns are written and never read (`ai_profile_sets.privacy_mode`,
  `ai_profile_tasks.fallback_policy`; no control, no settings key, a column drop needs a migration, so outside T98).
  Four `settings` rows and their wipe machinery die with T78. Every other key was traced to a production reader.
- **Q4 keeps the stored keys.** The 17 controls, `matchingPresets` and `activeMatchingPresetId` keep their keys, their
  recommended defaults, their validators and their entries in the strict update schema; they change place, not storage.
  Three lines of the spec assumed typed config and are superseded (section 11).
- **Pair-key fields (section 9).** Six matching values, `contentLanguage` and the per-profile parameters of the
  reranking route are in the source judge's identity. Editing one makes the pair judge again when source matching next
  reaches it; nothing re-matches on save. The other eleven matching controls, the floors and the input budget among
  them, are in no key.
- **A risk for T67 and T98.** Four members of `SourceRelationSettingsSchema` default (Zod) to values other than the
  recommended set (3/1000/1200/20000 against 2/800/1000/60000). The product writes whole objects, so the recommended
  set wins; a partial stored object would not (section 11.4).

## 2. Method and vocabulary

A **reader** is production code that reads the stored value and acts on it, or a UI that shows and edits it. Schemas,
defaults, tests, fixtures and the golden and benchmark tooling that pins or restores a value are not readers; they are
listed apart as **tooling** where they matter. A key is **dead** when it has no reader; **behaviourally dead** when its
only reader changes nothing. Paths are relative to the repository root; `R` = `apps/desktop/src/renderer`, `M` =
`apps/desktop/src/main`, `S` = `apps/desktop/src/shared`.

**Category (E7, the `settingsRegistry` field)**

| Category | Meaning | Counted by E7 |
| --- | --- | --- |
| `automation` | Changes what the app does by itself in the background, or how automatic processing decides | Yes, outside Advanced |
| `setup` | AI setup: the mode, the five class routes, the judge route, the Decisions opt-in and its key | No (Q4) |
| `integration` | External services and sync: online lookup, Obsidian, the gateway | No (Q4) |
| `preference` | Language, theme, layout, graph feel, import presets | No |
| `diagnostics` | Debug capture | No |
| `data` | Where files are kept | No |
| `credential` | A secret held in the credential store | No |
| `internal` | Persisted state with no control | No |
| `dead` | No reader (or a reader that changes nothing) | Removed |

**Placement after F4** (proposed here; T98 and F5 may refine, the E7 count holds for any placement that keeps the 22
automation controls in Advanced): `Knowledge` (the new scope, six controls), `General`, `AI`, `Integrations`, `Data`,
`Import`, `Advanced › Matching` (the "Matching settings" group of Q4), `Advanced` (other disclosure content), `none`.
Q4 names the group, not the scope that hosts the Advanced disclosure. This inventory puts the group in the
Personalization scope's Advanced disclosure beside summary words and graph limits (spec 3.12: "Advanced disclosures in
Personalization and Intelligence"); moving it to the Knowledge scope's own Advanced disclosure changes no count.

## 3. The counts, verified

Settings has nine scopes (`SettingsScope`, `R/components/SettingsView.tsx:63-72`): prompts, overview, personalization,
matching, intelligence, models, external-services, connections, data. The unit is one persisted value with its own
control on a Settings screen; action buttons are not counted.

### 3.1 The 35 (strict rule)

| Group | Control (file:line) | Stored as | Category | Fate |
| --- | --- | --- | --- | --- |
| Matching, 17 | section 3.2 | `app.preferences` | automation | Advanced › Matching (Q4) |
| Personalization, 3 | Summary minimum words `SettingsView.tsx:1039`; graph max entities `:1092`; max relations `:1113` | `app.preferences` | automation | Advanced |
| External services, 2 | Online lookup switch `:1000`; provider select `:980` | `app.preferences` | integration | one control (section 4) |
| Intelligence, 11 | Keep embedders loaded switch `:496` | `app.preferences` | automation | Advanced |
| | Setup mode select `R/components/AiClassRoutes.tsx:150` | `settings` `ai.preset.v1` | setup | AI |
| | Five class route selects (`ClassRow` `:392`, via `ProfileSelect` `:373`) and the judge route select (`JudgeRow` `:454`) | `ai_task_profile_routes` (`class:<id>`, `op:` keys) | setup | AI |
| | Decider mode select `:544` | `settings` `relations.deciderMode` | automation | Advanced |
| | Decisions opt-in `R/components/DecisionsDecider.tsx:176-180` | `settings` `relations.decisions` | setup | AI (privacy notice stays at the choice) |
| | Decisions API key `DecisionsDecider.tsx:189` | credential `ai:decisions-openai-platform` | setup | AI |
| Connections, 2 | Obsidian sync enabled `SettingsView.tsx:1213`; paused `:1219` | `storage_settings` | integration | one tri-state |

Totals: 17 + 3 + 2 + 11 + 2 = **35**. Without the Decisions key: 34. By category: 22 automation (17 + 3 + keep-loaded +
decider mode), 9 setup (mode, six routes, opt-in, key), 4 integration.

### 3.2 The 17 matching controls

All sit in `MatchingCard` (`SettingsView.tsx:750-914`); with the Recommended preset selected the whole group is
read-only (`fieldset disabled={isRecommended}`, `:791-795`). Readers are the consumers of the value; the recommended
value is `recommendedMatchingConfiguration` (`packages/domain/src/matching-presets.ts:51-58`, id `recommended-v2`).

| # | Control | Stored key | Recommended | Control at | Reader (decides what) | In a pair key |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Matching preset selector | `activeMatchingPresetId` | `recommended-v2` | `R/components/MatchingPresetControls.tsx:59` | `parseSavedAppSettings` `M/services/settings-service.ts:92-130`, `updateApp` `:347-387` | no |
| 2 | Relation-type similarity threshold | `relationTypeSimilarityThreshold` | 0.92 | `SettingsView.tsx:797` | `M/services/knowledge-service.ts:1262` → `relation-type-resolution.ts:329,339,383` | no |
| 3 | Entity-identity similarity threshold | `entityIdentitySimilarityThreshold` | 0.92 | `:810` | `knowledge-service.ts:1278` → `entity-identity-resolution.ts:149,169,213` | no |
| 4 | Note decider output tokens | `atomicNoteMatchingSettings.maxRerankOutputTokens` | 4096 | `R/components/AdvancedMatchingSettings.tsx:34` | `M/services/relations/relation-matcher.ts:500,515` → `decideGeneratively` `:1447,1511`; effective only in the generative decider mode | no |
| 5 | Relation-type candidates | `canonicalMatchingSettings.relationTypeCandidateLimit` | 3 | `AdvancedMatchingSettings.tsx:53-59` | `M/services/relation-type-resolution.ts:330,349` | no |
| 6 | Entity candidates | `...entityCandidateLimit` | 3 | same | `M/services/entity-identity-resolution.ts:150,180` | no |
| 7 | Confirmation batch size | `...confirmationBatchSize` | 12 | same | `relation-type-resolution.ts:274`, `entity-identity-resolution.ts:85` | no |
| 8 | Confirmation max characters | `...confirmationMaxCharacters` | 12000 | same | `relation-type-resolution.ts:278`, `entity-identity-resolution.ts:89` | no |
| 9 | Evidence chunks per source | `sourceRelationSettings.evidenceChunksPerSource` | 2 | `AdvancedMatchingSettings.tsx:93-99` | `M/services/source-relation-processing.ts:133-147` | **yes** |
| 10 | Evidence max characters | `...evidenceMaxCharacters` | 800 | same | `source-relation-processing.ts:147` | **yes** |
| 11 | Source summary max characters | `...summaryMaxCharacters` | 1000 | same | `source-relation-processing.ts:250-264` | **yes** |
| 12 | Judge output tokens | `...maxOutputTokens` | 4096 | same | `source-relation-processing.ts:180-182` | **yes** |
| 13 | Relations per pair | `...maxRelationsPerPair` | 4 | `SettingsView.tsx:831-866` | `source-relation-processing.ts:175-176` | **yes** |
| 14 | Input-token budget | `...maxInputTokens` | 60000 | `:831-866` | `source-relation-processing.ts:1005` (later calls stop once the pair's running total exceeds it) | no (test `:639`) |
| 15 | Minimum importance | `...minImportance` | 0.75 | `:868-882` | `packages/domain/src/source-relations.ts:139-146` via `source-relation-processing.ts:481` | no (test `:639`) |
| 16 | Minimum confidence | `...minConfidence` | 0.85 | `:868-882` | same | no (test `:639`) |
| 17 | Include weak types | `...includeWeakTypes` | false | `:883-909` | `source-relation-processing.ts:257,988` and the floors `source-relations.ts:146` | **yes** |

17 = 1 selector + 2 thresholds + 1 note value + 4 canonical + 4 source values in the Advanced `<details>`
(`AdvancedMatchingSettings.tsx:27`) + 5 in the source block. The three "reset" affordances (`MatchingResetButton` per
field, "reset canonical", "reset sources") and the preset buttons (create, duplicate, rename, delete) are actions. The
two matching-preset keys are `matchingPresets` (the saved list, at most 50, edited by those buttons) and
`activeMatchingPresetId` (row 1); they have no reader of their own beyond the reconciliation in `settings-service.ts`
(the effective fields above stay authoritative, `:96-98`) and the preset UI. D33's "two matching-preset lists" is read
here as these two keys.

### 3.3 The 43 and the 47

The broad rule adds nine value controls to the 34 other than the Decisions key: vault path (`SettingsView.tsx:1186`),
managed root (`:1205`), deletion policy (`:1229-1255`), upload copies on (`:1286`) and folder (`:1294`), wiki scope's
source picker and "include descendants" (`R/components/ObsidianWikiCard.tsx:99-117`), layout language and attachments
(`R/components/ObsidianLayoutCard.tsx:103-132`): 1 + 1 + 1 + 2 + 2 + 2 = 9, so 34 + 9 = **43**. Four more value controls
are not automation-related by any rule (interface language `:668`, content language `:684` and `RelationLabelsCard.tsx:95`,
theme `:687`, graph wheel zoom `:719`): 43 + 4 = **47** value controls, plus three credential fields (Decisions key,
Google Books key `SettingsView.tsx:1454`, model-repository token `R/components/LocalModelsView.tsx:38,95`). Not counted
anywhere: the AI profile editor (name, model, per-task parameters, section 8), the 60 prompts, the gateway pairing form
(`R/components/IntegrationGatewaySettings.tsx`, transient inputs), the Debug view's capture toggles
(`MonitoringDashboard.tsx:110-119`, not a Settings screen) and the rail toggle.

## 4. `app.preferences`

One `settings` row, key `app.preferences` (`M/services/settings-service.ts:38`). Read schema `S/ipc.ts:347-377`
(non-strict: unknown keys are stripped on read), update schema `:379-404` (strict), defaults `:1805-1822`. Production
requires the database (`M/index.ts:239-243`); `app-settings.json` and `storage-settings.json` are the no-database
fallback of tests and scripts. The stored document carries `updatedAt` (internal).

| Key | Default | Reader(s) | Screen | Category | Fate |
| --- | --- | --- | --- | --- | --- |
| `language` | OS locale (`settings-service.ts:77-82`) | `R/App.tsx:207` (translator), `:214` (document language), `:583` (menu); `M/index.ts:295` → `M/services/ai-service.ts:894` (error copy) | Personalization › Appearance `SettingsView.tsx:668` | preference | keep: General; onboarding step 1 |
| `contentLanguage` | OS locale; `en` when absent (`S/ipc.ts:352`) | `M/index.ts:294` and 10 more getters → `knowledge-service.ts:359,1226,1898`, `topic-tree/topic-naming.ts:417`, `topic-areas.ts:436`, `topic-overview.ts:206`, `relation-explanation-service.ts:159`, `consultation-service.ts:460`, `ai-service.ts:1519`; written also by `M/ipc.ts:143` | Personalization › Appearance `:684` **and** Data › Relation labels `RelationLabelsCard.tsx:95` (two controls, one value) | preference | keep: General; one control (the Relation labels card keeps its action); onboarding step 1 |
| `themeMode` | `system` | `R/App.tsx:208,211,525`, `R/lib/theme.ts:69` (also remembered in `localStorage` `memora.themeMode`) | Appearance `:687`; rail toggle | preference | keep: General |
| `graphWheelZoomSensitivity` | 1 | `R/App.tsx:911` → `KnowledgeGraphDashboard.tsx:960`, `SourceConnectionGraph.tsx:278` | Appearance `:719` | preference | keep: Advanced (graph lens; F5 Map) |
| `navigationCollapsed` | false | `R/App.tsx:567,694,727` | none (rail button) | internal | keep, silent UI state |
| `wikiTreeWidth` | 320 | **none** | none | dead | **drop** (section 10) |
| `debugMode` | false | `M/services/monitoring-service.ts:32-36`, `M/index.ts:405,467`, `R/App.tsx:921` | Debug view `MonitoringDashboard.tsx:110-119` | diagnostics | keep: Advanced › Diagnostics |
| `debugFullCapture` | false | `monitoring-service.ts:33,57`, `R/App.tsx:923` | Debug view | diagnostics | keep: Advanced › Diagnostics |
| `metadataEnrichmentEnabled` | true | `M/index.ts:397` → `M/services/metadata-enrichment-service.ts:103,141`; `M/ipc.ts:302`; `LibraryView.tsx:357,854`, `ImportView.tsx:364,997` | External services `SettingsView.tsx:1000` | integration | merge with the next into one control "Look up book data online" (Off, Automatic, Open Library, Google Books); storage unchanged (the provider is kept while Off) |
| `bookMetadataProvider` | `auto` | `M/index.ts:398` → `metadata-enrichment-service.ts:104`; inert while lookup is off | External services `:980` | integration | merge (above) |
| `keepLocalEmbeddingModelsLoaded` | true | `M/index.ts:296` → `ai-service.ts:1523`; `M/index.ts:531`; `M/ipc.ts:185` (releases the runtime when set false); tooling `golden-runner.ts:1599` | Intelligence `:496` | automation | keep: Advanced (or derive from the hardware tier, F5) |
| `summaryMinimumWordCount` | 40 | `M/index.ts:473` → `knowledge-service.ts:639` | Personalization `:1039` | automation | keep: Advanced |
| `entityIdentitySimilarityThreshold` | 0.92 | section 3.2 row 3 | Matching `:810` | automation | **Advanced › Matching (Q4)**; the map said "drop to typed config" |
| `relationTypeSimilarityThreshold` | 0.92 | row 2 | Matching `:797` | automation | Advanced › Matching |
| `knowledgeGraphMaxEntitiesPerSource` | 250 | `M/index.ts:479-484` → `knowledge-service.ts:1228` → `M/services/knowledge-processing.ts:404-417,492-495` | Personalization `:1092` | automation | keep: Advanced |
| `knowledgeGraphMaxRelationsPerSource` | 500 | same | Personalization `:1113` | automation | keep: Advanced |
| `atomicNoteMatchingSettings` `{maxRerankOutputTokens}` | 4096 (schema and recommended agree) | row 4 | Matching › Advanced | automation | Advanced › Matching |
| `canonicalMatchingSettings` (4 members) | 3 / 3 / 12 / 12000 (schema and recommended agree) | rows 5-8 | Matching › Advanced | automation | Advanced › Matching |
| `sourceRelationSettings` (9 members) | recommended set: 2 / 800 / 1000 / 4096 / 4 / 60000 / 0.75 / 0.85 / false; **Zod member defaults differ** (section 11.4) | rows 9-17 | Matching | automation | Advanced › Matching |
| `matchingPresets` (≤50 saved presets) | `[]` | `parseSavedAppSettings` and `updateApp` (`settings-service.ts:92-130,347-387`), `migrateMatchingSettingsV2` `packages/domain/src/matching-settings-migration.ts:84-93`, `MatchingPresetControls.tsx`, `SettingsView.tsx:286-288,766-770` | Matching (preset buttons) | automation | Advanced › Matching |
| `activeMatchingPresetId` | `recommended-v2` | same; tooling `golden-runner.ts:1600` (recorded in the run) | Matching `MatchingPresetControls.tsx:59` | automation | Advanced › Matching |
| `processingPresets` (≤50 saved import plans) | unset | `R/components/ProcessingPlanPicker.tsx:119,132,143` | Import (not Settings) | preference | keep: Import |
| `updatedAt` | now | `settings-service.ts:124-131` | none | internal | keep |

Already retired by the matching settings v2 migration (F3 T53b, `matching-settings-migration.ts`): the top-level
`atomicNoteRelationThreshold`, 15 note members and 5 source members. They are not in the schema and leave stored
documents on first read; a test pins it. The fixture `packages/domain/src/fixtures/app-settings-matching-before-v2.json`
keeps a pre-v2 document (including `wikiTreeWidth`) on purpose.

## 5. `storage_settings`

One row (`packages/db/src/schema.ts:973`, repository `packages/db/src/repositories/storageSettingsRepository.ts`),
schema `S/ipc.ts:406-415`, defaults `:1824-1832`, validation `settings-service.ts:144-163`.

| Key | Default | Reader(s) | Screen | Category | Fate |
| --- | --- | --- | --- | --- | --- |
| `obsidianVaultPath` | null | `M/services/obsidian-sync-service.ts` (many), `obsidian-wiki-projection.ts:100,255,307`, `obsidian-editorial-service.ts:88`, `source-deletion-service.ts:357`, `library-reset-service.ts:65`, `topic-tree/corpus-runner.ts:540`; written by `M/ipc.ts:202-206` (vault pick) | Connections › Obsidian `SettingsView.tsx:1186` | integration | keep: Integrations |
| `managedRoot` | `Memora` | `obsidian-sync-service.ts:94,484,804,867`, `obsidian-wiki-projection.ts:255-259`, `obsidian-editorial-service.ts:92`, `library-reset-service.ts:45,67`, `source-deletion-service.ts:360` | Connections `:1205` | integration | keep: Advanced (Integrations) |
| `obsidianSyncEnabled` | false | `obsidian-sync-service.ts:1035` (`isSyncActive`), `obsidian-editorial-service.ts:87`, `obsidian-layout-migration.ts:103`, `obsidian-wiki-projection.ts:100`, `R/components/ObsidianLayoutCard.tsx:28` | Connections `:1213` | integration | **tri-state** (below) |
| `obsidianSyncPaused` | false | the same five places (every reader tests `enabled && !paused`) | Connections `:1219` | integration | tri-state (below) |
| `deletionPolicy` | `tombstone` | `obsidian-sync-service.ts:415` only | Connections `:1229-1255` | **dead (behaviour)** | **drop the control and the field** (section 10) |
| `uploadCopiesEnabled` | false | `M/services/ingestion-service.ts:1035`, `backup-service.ts:129` | Data › Storage `:1286` | data | merge with the folder into one control (on = a folder is set); storage unchanged |
| `uploadCopiesFolderPath` | null | `ingestion-service.ts:1035-1038`, `backup-service.ts:130`, `library-reset-service.ts:57`, `source-deletion-service.ts:347`, `M/index.ts:466,493-494` | Data › Storage `:1294` | data | merge (above) |

**Obsidian tri-state.** Off = `enabled=false`; On = `enabled=true, paused=false`; Paused = `enabled=true, paused=true`.
Safe because no reader distinguishes "off" from "paused": all of them test `enabled && !paused` (`isSyncActive`,
`obsidian-editorial-service.ts:87`, `obsidian-layout-migration.ts:103`, `obsidian-wiki-projection.ts:100`). A stored
`enabled=false, paused=true` reads as Off. `validateStorageSettings` (`settings-service.ts:152`) still requires a vault
path to turn sync on; the vault pick (`M/ipc.ts:202-207`) writes On.

## 6. The `settings` table (key-value)

`settings(key, value jsonb)` through `createSettingsRepository` (`packages/db/src/repositories/settingsRepository.ts`).

| Key | Reader(s) | Screen | Category | Fate |
| --- | --- | --- | --- | --- |
| `app.preferences` | section 4 | | | |
| `import.lastDirectory` | `settings-service.ts:233` | none (file dialog) | internal | keep |
| `ai.preset.v1` `{mode, at}` | `M/services/ai-class-routes.ts:231`, `M/services/ai-decisions.ts:316` | Intelligence mode select | setup | keep: AI; onboarding step 2 |
| `ai.classTests.v1` | `ai-class-routes.ts:232` | test state on the route rows | internal | keep |
| `ai.routes.classMap.v1` | `M/services/ai-route-mapping.ts:440`, `ai-class-routes.ts:498` | none | internal | keep |
| `relations.deciderMode` | `M/services/relations/relation-matcher.ts:588`, `ai-class-routes.ts:233` | Intelligence decider select `AiClassRoutes.tsx:544` | automation | keep: Advanced |
| `relations.decisions` `{enabled}` | `ai-decisions.ts:277` | Intelligence › Decisions | setup | keep: AI (opt-in, decision 30) |
| `relations.decisions.dailySpend` | `M/services/relations/decisions-budget.ts:41` | status line | internal | keep; may fold into the T76 ledger |
| `relations.decisions.state` | `ai-decisions.ts:323` | status line | internal | keep |
| `relations.ai.dailyCalls` | `M/services/relations/relation-call-budget.ts:75-80` | none | internal | keep as a sub-cap (spec D14) |
| `catalogHeader.dailyRoots` | `relation-call-budget.ts:75-80` with the key passed at `M/services/job-supervisor.ts:383` (`catalog-header-policy.ts:23`) | none | internal | keep as a sub-cap (the map missed it) |
| `topics.ai.daily.v1` | `M/services/topic-tree/topic-ai.ts:90` | none (the cap shows as `dailyCapReached`) | internal | keep as a sub-cap |
| `topics.corpus.v1` | `M/services/topic-tree/corpus-runner.ts:566` | none | internal | keep |
| `local-models.first-run-ranker` | `M/services/first-run-ranker.ts:102` | none (onboarding surfaces it) | internal | keep |
| `local-models.repository-token-ref` | `M/services/local-model-service.ts:377,817` | Models `LocalModelsView.tsx:95` | credential | keep: Advanced |
| `prompts.active` | the trigger `pin_job_prompt_catalog` (`packages/db/seed/baseline.sql:1775`); written by `packages/db/src/repositories/promptRepository.ts:139,153` | none | internal | keep |
| `prompts.sample:<revision>:<hash>` | `promptRepository.ts:24` | Prompts (validation progress) | internal | keep |
| `jobs.history.dismissed-through.v1` | `packages/db/src/repositories/taskHistory.ts:7`; written `jobRepository.ts:499` | Jobs › clear history | internal | keep (the Jobs screen leaves in F5) |
| `obsidian.layout` `{version 2, language, attachments}` | `obsidian-wiki-projection.ts:190-209`, `obsidian-layout-migration.ts:528,753` | Connections › layout card | integration | keep; seeded from `contentLanguage` once, independent after (merging the two languages is F5) |
| `obsidian.wiki.scope` `{sourceIds ≤100, includeDescendants}` | `obsidian-wiki-projection.ts:246-251` | Connections › wiki card | integration | keep |
| `obsidian.layout.presence.<clientId>` | `packages/db/src/repositories/obsidianLayoutRepository.ts:55-66` | none | internal | keep |
| `obsidian.editorial.client.<clientId>` | `packages/db/src/repositories/obsidianEditorialRepository.ts:25-33` | none | internal | keep |
| `legacy.wipe.v1` | `legacyWipeRepository.ts:360,414` (an audit record "nothing reads as a switch") | none | dead after T78 | dies with the wipe machinery (D35) |
| `knowledge.automation.policy.v1`, `knowledge.wiki-areas.v1`, `organization.active` | `legacyWipeSettingsKeys` only (`legacyWipeRepository.ts:49-53`); no product reader | none | dead after T78 | dies with the wipe machinery (D35) |

Planned by F4, none exists yet: `knowledge.controls.v1` `{autonomy, monthlyCapUsd, paused, treeShape, onlyIdle,
onlyOnAc}` (T75; defaults Auto, US$5, off, Balanced, off, off; the six `automation` controls of the Knowledge scope),
`onboarding.v1` (T96, internal), the Codex daily background-call counter (T76, internal, a typed-config cap with a DEV
override).

## 7. Other stores

| Store | What | Reader | Category | Fate |
| --- | --- | --- | --- | --- |
| Credential store (`safeStorage`, `M/services/credential-service.ts:21-39`) | provider keys, `metadata:google-books` (`metadata-enrichment-service.ts:79`), `ai:decisions-openai-platform`, the model-repository token behind `local-models.repository-token-ref` | the services named | credential | keep |
| `localStorage` `memora.themeMode` | the theme, to avoid a flash before settings load | `R/lib/theme.ts:69-79` | internal | keep (the only renderer-local persisted state) |
| `userData/app-settings.json`, `storage-settings.json`, `import-dialog.json` | the no-database fallback of `SettingsService` (`settings-service.ts:167-223`) | tests and scripts only; production requires the database | internal | keep for now |
| `userData/hardware/profile-v1.json` | planned (T97) | | internal | new |

Entities, not settings: `ai_provider_configs` (+ `default_parameters`), `ai_profile_sets`, `ai_profile_tasks`
(+ `parameters`), `ai_task_profile_routes`, `local_models` (+ `default_parameters`). UI: Intelligence tabs and Models.

## 8. Per-profile parameters, profile fields and prompts

**Parameters** (`AiModelParametersSchema`, `packages/domain/src/ai.ts:70-82`), stored in `ai_provider_configs`,
`local_models` and per task in `ai_profile_tasks.parameters`; edited in `R/components/AiParameterFields.tsx`; each field
is shown only if the model's capabilities offer it (`packages/ai/src/parameter-capabilities.ts`). Every one has a reader.

| Parameter | Reader(s) | Offered by |
| --- | --- | --- |
| `contextWindow` | `M/services/ai-task-parameters.ts:89,191`, `ai-service.ts:1379,1784` | all runtimes |
| `temperature` | `packages/ai/src/openai-compatible.ts:563`, `google.ts:444`, `local-adapters.ts:601,681` | not Codex |
| `maxTokens` | `ai-task-parameters.ts:195`, `ai-service.ts:1722,1742`, `openai-codex.ts:306` | local, remote (not Codex) |
| `reasoningLevel` | `packages/ai/src/reasoning.ts:44-48`, `ai-service.ts:1813` | models with reasoning |
| `reasoningMaxTokens` | `openai-compatible.ts:550`, `google.ts:440` | OpenAI-compatible, Google |
| `topP` | `openai-compatible.ts:564`, `google.ts:445`, `local-adapters.ts:602,682` | not Codex |
| `topK` | `openai-compatible.ts:565`, `google.ts:446`, `local-adapters.ts:603,683` | Google, Qwen3.5, local |
| `presencePenalty` | `openai-compatible.ts:566`, `google.ts:447`, `local-adapters.ts:604` | OpenAI-compatible, Google, MLX |
| `dimensions` | `ai-service.ts:2360,3632`, `google.ts:173`, `embed-many.ts:12` | embedding models |
| `seed` | `openai-compatible.ts:569`, `google.ts:450`, `local-adapters.ts:609,684` | not Codex |

Up to 10 fields per task and model (fewer for Codex and for embedding-only models), over the 16 task types of
`AiTaskTypes` (`packages/domain/src/ai.ts:6-23`; the profile editor lists those the model supports). Category: `setup`;
fate: Advanced (per-task parameters), unchanged in F4. The effective parameters are part of the typer key and the judge
identity (section 9).

**Profile fields without a control.** `ai_profile_sets.output_language` is read (`knowledge-service.ts:687,899,1039,1486`).
`ai_profile_sets.privacy_mode` is written in six places and mapped into `AiProfile` (`ai-service.ts:3976`) but no code
branches on it: effective privacy is derived from `localModelId` (`ai-service.ts:1347`; `_legacyPrivacy` is an unused
argument, `:1334,1385`). `ai_profile_tasks.fallback_policy` is written (`"block"` always,
`aiConfigRepository.ts:292,407,538`, `ai-service.ts:1284`) and never read. Both are dead columns (section 10).

**Prompts.** 60 prompt definitions, all with an editable body, in 10 categories (consultation 8, summary 4, notes 3,
relations 8, graph 12, sources 4, shared 3, embedding 7, diagnostics 3, topic 8): 58 shipped bodies
(`packages/domain/src/prompt-defaults.ts:2`) plus `consultation.guidance` and `consultation.advanced`, added by the loop
at `prompt-definitions.ts:376`, and one candidate revision. The map's 59 is the 58 shipped bodies plus the candidate
body of `prompt-defaults.ts`; the catalog (`promptDefinitions`) shows 60. Revisions and activations are entities
(`prompt_revisions`, `prompt_activations`), edited in `PromptsSettingsView.tsx`; the `prompts.active` row is a derived
publication. Category: `setup`; fate: Advanced, unchanged.

## 9. Pair keys and freshness fields

What makes a stored decision stale is the question plan 4.3 ("saving settings never invalidates coverage") asks of every
setting. Settings found in a key or fingerprint:

| Key | Built at | Settings in it |
| --- | --- | --- |
| Source judge identity (the pair key) | `source-relation-processing.ts:684-707` (`judgeIdentity`), request part `:558-576` | **Six matching values**: `evidenceChunksPerSource`, `evidenceMaxCharacters`, `summaryMaxCharacters`, `maxOutputTokens`, `maxRelationsPerPair`, `includeWeakTypes`; plus three typed judge values (`noteRelationsPerPair`, `exactEvidencePairs`, `boundedEvidenceChunks`); **`contentLanguage`** (`:693`); the prompt identity; the reranking route's model identity, `parameters` and `modelDefaultParameters`. **Not in it**: `minImportance`, `minConfidence` (applied to the stored raw verdicts), `maxInputTokens` (gates a call). Pinned by `source-relation-processing.test.ts:639` ("never for floors or budget") and `:929` |
| Typer key | `M/services/relations/relation-typing.ts:221-240` | contract, prompt identity, model identity and the effective parameters of the write-fast structured-output route (task defaults, model defaults, profile task parameters); no `app.preferences` field |
| Note decider key | `relation-matcher.ts:1708-1714`, generative key `:740-760` | ranker cache key (model, instruction, calibration), or the generative route's model identity and effective parameters; `maxRerankOutputTokens` is not in it |
| Entity identity fingerprint | `entity-identity-resolution.ts:58-75` | the entity's content, version and prompt identity; no settings |
| Topic overview staleness | `M/services/topic-tree/topic-overview.ts:206,216-219` | `contentLanguage` and the prompt revision |

`SettingsService.updateApp` only validates and saves (`settings-service.ts:347-387`; the IPC handler `M/ipc.ts:182-187`
adds the runtime release for `keepLocalEmbeddingModelsLoaded=false` and nothing else). Nothing re-matches on a save.

## 10. Dead settings

| Setting | Evidence | Fate for T98 |
| --- | --- | --- |
| `app.preferences.wikiTreeWidth` | `grep -w wikiTreeWidth` finds the read schema `S/ipc.ts:356`, the update schema `:389`, the defaults `:1810`, one test `settings-service.test.ts:621-640` and the pre-v2 fixture. No reader, no control | **Drop** from the three `S/ipc.ts` places; rewrite the test as "a stored `wikiTreeWidth` is stripped on read"; keep the fixture |
| `storage_settings.deletionPolicy` | The only read is `obsidian-sync-service.ts:415`, which copies it into a record's metadata `deletePolicy`; `grep deletePolicy` finds no reader of that metadata (also none in `apps/obsidian-plugin` or `packages/integration-contracts`). The method (`handleDeleted`) skips format-2 records (`:399-400`); for format-1 records it marks the record deleted whatever the policy, so the three options (tombstone, archive, delete) change nothing | **Drop** the control (`SettingsView.tsx:74-98,1226-1257`), the field from `storageSettingsSchema` and its update, `deletionPolicySchema` (`S/ipc.ts:290`) and its 7 copy keys per locale (section 11.5); keep the column (a column drop is a migration none of 0060-0064 owns) and let the repository write its default |
| `ai_profile_sets.privacy_mode` | Written in six places, mapped at `ai-service.ts:3976`, never branched on (effective privacy: `ai-service.ts:1347`) | Report only: a column, outside T98; F5 cleanup |
| `ai_profile_tasks.fallback_policy` | Written `"block"` only, copied in SQL (`aiConfigRepository.ts:292`), never read | Report only: same |
| `legacy.wipe.v1`, `knowledge.automation.policy.v1`, `knowledge.wiki-areas.v1`, `organization.active` | Touched only by `legacyWipeRepository.ts` and `verify-legacy-wipe.ts` | Die with T78 (D35) |

Conditionally inert (live, not dead): `bookMetadataProvider` while lookup is off; `uploadCopiesFolderPath` while copies
are off (its control is disabled, `SettingsView.tsx:1297`); `maxRerankOutputTokens` outside the generative decider mode.

Checked and live: every other key of sections 4 to 6 (reader lines given there), the ten parameters of section 8, and
`graphWheelZoomSensitivity` (its graph view is reachable from `R/App.tsx:897-915`).

## 11. What Q4 changes

**11.1 Spec lines superseded.** Q4 replaces "typed config" with "Advanced › Matching" for the 17 controls and the two
preset keys. Read as superseded: (a) spec section 4, "Settings (no SQL)": "`app.preferences` loses `wikiTreeWidth` and
the matching fields from its update schema" now loses `wikiTreeWidth` and the other keys section 10 marks dead, and
**no matching field**; (b) spec 3.12: "Golden and benchmark tooling (...) read typed config": they keep reading the stored
settings (`golden-runner.ts:1589-1601`, `matching-benchmark.ts:72-73,221-307`, `matching-pilot.ts:141-142,246,339-340`),
no change; (c) the T98 card's "matching typed config readers, golden and benchmark tooling readers": not needed, and
the map's section 4.2 fates "drop to typed config" for the matching rows are replaced by section 3.2 above.

**11.2 What T98 does with them.** Moves the content of `MatchingCard` into a "Matching settings" group inside an
Advanced `<details>`; deletes `matching` from `SettingsScope` and `scopes` (`SettingsView.tsx:63-72,142-149`) and its
overview card; gives the header tile "Knowledge matching" (`:338-339`, the active preset's name) a new home or drops it.
The registry rows carry `category: automation`, `placement: advanced`, so the E7 test (category `automation` outside
Advanced) does not count them; **the registry therefore needs a placement field, not the category alone.**

**11.3 Plan 4.3 for T67.** Facts for the sentence T67 writes ("a changed matching value applies to new decisions only,
re-matching is an optional backlog, pair keys stay as D33 tests them"): a save never re-matches (section 9); of the 17,
six change the judge identity, so a source pair decided before is judged again only when source matching next reaches
it (a regenerate, or a new source whose discovery selects the pair); three (importance, confidence, input budget) never
re-judge, and the stored raw verdicts can be re-filtered without calls (`source-relation-processing.ts:1078`); the other
eight (two thresholds, the note output tokens, the four canonical values, the selector) are in no key and apply to new
work. The Recommended preset is read-only, and a custom preset starts as a copy of the recommended or current values
(`MatchingPresetControls.tsx:32-50`), so the group already sits behind a deliberate "create preset" step.

**11.4 A value away from the frozen calibration.** What exists to show it: the active preset id (Recommended or a saved
one), `matchingConfigurationsEqual` (`matching-presets.ts:80`) to compare a configuration with the recommended one, and the
per-field reset buttons that restore the recommended value (`AdvancedMatchingSettings.tsx:18-24,143-165`). What is missing: a
marker on a custom preset or field that differs from `recommended-v2`. One trap to close in T98's tests: the Zod member
defaults of `SourceRelationSettingsSchema` (`packages/domain/src/source-relations.ts:14-26`) are 3 / 1000 / 1200 / 4096
/ 4 / 20000 / 0.75 / 0.85 / false, the recommended set is 2 / 800 / 1000 / 4096 / 4 / 60000 / 0.75 / 0.85 / false (measured
with `SourceRelationSettingsSchema.parse({})` against `recommendedMatchingConfiguration`). The product writes the whole
object, so the recommended set wins, and the `matchSources` callers parse `getSourceRelationSettings() ?? {}`
(`knowledge-service.ts:357,1896`), which falls back to the Zod defaults only where the getter is unwired (tests and
scripts). A test that `defaultAppSettings` equals `recommendedMatchingConfiguration` on all 16 values pins it.

**11.5 Copy.** Q4 spares the copy: `settings.matching` (38 leaf keys), `relationTypes` (2), `entityIdentity` (2) and the
`sourceRelations` limits stay and move with the controls; only the scope's navigation keys
(`settings.dashboard.navigation.matching`, `...matchingDescription`) and the header tile
(`settings.dashboard.summary.knowledgeMatching`) go, if the tile is dropped. Dropping `deletionPolicy` removes 7 keys per
locale (`settings.storage.deletePolicies.*`, `settings.storage.obsidianDeletePolicy`,
`settings.dashboard.deletePolicyDescriptions.*`).

## 12. The cut, and what T98 needs

**Target state (E7).** Automation controls outside Advanced after T98: the six Knowledge controls and nothing else.

| Placement | Controls | Category |
| --- | --- | --- |
| Knowledge (new) | autonomy, monthly remote cap, pause, tree shape, only idle, only on AC | automation (6) |
| General | interface language, content language, theme | preference (3) |
| AI | mode, five class routes, judge route, Decisions opt-in, Decisions key | setup (9) |
| Integrations | online lookup (merged, 1), Obsidian tri-state (1), vault path, wiki scope (2), layout (2) | integration (7) |
| Data | upload copies (merged, 1) | data (1) |
| Advanced › Matching | the 17 controls (section 3.2) | automation (17), inside Advanced |
| Advanced | summary minimum words, graph limits (2), keep embedders loaded, decider mode | automation (5), inside Advanced |
| Advanced | graph wheel zoom, managed root, model-repository token, debug capture (2) | preference, integration, credential, diagnostics |

Today: 22 `automation` controls (13 outside a disclosure); after: 28 `automation` controls, 6 outside Advanced.

**Rows the registry needs.** One per control above, with `id` = the stored key path (`sourceRelationSettings.minImportance`),
`category`, `placement`, `scope`, and `reader` (a symbol or path, for the next test).

**Tests this inventory supports** (T98 writes them): (1) E7: count of `category: automation` and `placement` not Advanced
is at most 6; (2) no stored key lacks a reader: every key of `appSettingsSchema` and `storageSettingsSchema` and every
`settings` key family of section 6 appears in the registry with a reader, and `wikiTreeWidth` and `deletionPolicy` do
not; (3) pair keys equal before and after on a fixture (`sourceJudgeRequestSettings` with `defaultAppSettings`); (4)
`defaultAppSettings` equals the recommended configuration (11.4); (5) a stored `wikiTreeWidth` and a stored
`deletionPolicy` are stripped on read, and the strict update schemas refuse them.

## 13. Reproduce

- Readers of a key: `grep -rn --include='*.ts' --include='*.tsx' -w <key> apps packages scripts | grep -v '\.test\.'`,
  then follow the `get...` getter wired in `M/index.ts:293-297,466-484` to its consumer.
- Dead check: `grep -rn -w wikiTreeWidth apps packages scripts` (schema, defaults, one test, one fixture) and
  `grep -rn deletePolicy apps packages` (the repository mapping and one metadata write, no read).
- Prompt count: import `promptDefinitions` from `packages/domain/src/prompt-definitions.ts` (60; `fields.some(f =>
  f.editable)` holds for all).
- Zod against recommended: `SourceRelationSettingsSchema.parse({})`, `CanonicalMatchingSettingsSchema.parse({})` and
  `AtomicNoteMatchingSettingsSchema.parse({})` against `recommendedMatchingConfiguration`.
- Copy counts: leaf keys of `packages/i18n/src/locales/en.json` under each prefix (total 2,456; `settings` 364).
