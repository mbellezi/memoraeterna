# Application-wide AI prompt catalog: implementation design

Date: 2026-09-12. Status: A0 inventory, golden fixtures and domain contracts are
independently verified and accepted; the A1 runtime catalog/editor remains planned.
See the [A0 report](automatic-wiki-a0-contracts.md#prompt-caller-inventory-and-golden-evidence).

This is the prompt-configuration workstream of the
[automatic wiki implementation plan](automatic-wiki-implementation-plan.md).
It covers all application-owned AI prompts, not only wiki harness instructions.
The user requested a detailed hierarchical settings section, editable prompt
text and `%variable_name%` placeholders with their functions listed below each
field. This document defines that experience and the migration required to make
the catalog the actual source of runtime prompts.

## 1. Required user experience

Add a top-level **Prompts** section in Settings. Use a searchable expandable tree
on the left, the selected prompt editor in the center and optional preview/history
on the right. Search matches title, purpose, breadcrumb, stable prompt ID and
variable name. Filter by customized, inherited, invalid, active and pending draft.

Opening a leaf shows:

1. Human-readable title, breadcrumb and a short explanation of when it runs.
2. Its AI task route, current effective model and prompt origin. Model selection
   remains in existing routing/override settings, not duplicated in this editor.
3. The editable prompt body, with highlighted `%variable_name%` tokens and an
   insertion control. Use the shared theme, accessible editor and normal window size.
4. **Variables used in this field**, directly below the field, with each token,
   purpose, type, data origin, required/optional status and a synthetic example.
5. Available variables and reusable fragments, separately expandable. Unknown,
   malformed and missing required tokens produce field-specific errors.
6. Effective composition preview, draft/active comparison and optional bounded
   synthetic test. Show shared fragment dependencies and affected callers.
7. Save draft, validate/test, activate, restore inherited/default and revision
   history. Saving text does not run or reorganize existing content.

For a prompt with multiple editable messages/fragments, list variables below each
individual field. Also show a complete composition summary. Do not force users
to inspect JSON to understand a variable or inheritance.

## 2. Initial navigation hierarchy

Portuguese labels illustrate the intended UI. Stable registry IDs and variable
keys are language-independent; descriptions and titles support all app locales.
Future leaves appear as unavailable/planned only if useful, not as runnable tools.

```text
Configurações > Prompts
├── Instruções compartilhadas
│   ├── Idioma do conteúdo
│   ├── Atribuição, evidências e incerteza
│   ├── Orientação editorial global
│   └── Reparação de respostas estruturadas
├── Processamento de fontes
│   └── Resumos
│       ├── Resumo de fonte curta
│       ├── Resumo parcial e conceitos
│       ├── Consolidação dos resumos parciais
│       └── Resumo de livro, periódico ou artigo com subitens
├── Notas atômicas
│   ├── Extração de ideias
│   ├── Reparação da extração
│   ├── Avaliação de relações entre notas
│   ├── TOC da fonte
│   │   ├── Agrupamento e títulos
│   │   └── Introdução e ordem de leitura
│   └── Consolidação, união e divisão de notas
├── Grafo de conhecimento
│   ├── Extração a partir de trechos
│   ├── Extração a partir de notas
│   ├── Tratamento de metadados de catálogo
│   ├── Reparação da extração
│   ├── Confirmação de identidade de entidades
│   ├── Equivalência de tipos de relação
│   └── Descrições das relações
├── Conexões entre fontes
│   ├── Avaliação e classificação
│   └── Reparação da avaliação
├── Busca e recuperação
│   ├── Instruções de embeddings de consulta
│   └── Formatos de entrada de embeddings de conteúdo
├── Wiki automática
│   ├── Descoberta de temas e páginas existentes
│   ├── Planejamento de alterações
│   ├── Síntese de páginas
│   ├── Atualização incremental
│   ├── TOCs temáticos e mapas transversais
│   ├── Hierarquia e posicionamento
│   └── Reparação de propostas
├── Consulta e investigações
│   ├── Resposta fundamentada
│   ├── Comparação e síntese
│   ├── Atualização de pergunta acompanhada
│   ├── Lacunas e interpretações divergentes
│   └── Reparação da resposta
├── Manutenção automática
│   ├── Após novas entradas
│   ├── Revisão diária de conteúdo
│   ├── Revisão semanal de organização
│   ├── Revisão mensal de consolidação
│   ├── Reavaliação temporal e arquivamento
│   └── Lições e procedimentos reutilizáveis
└── Diagnóstico e testes
    ├── Teste de modelo generativo
    ├── Teste de embeddings
    └── Amostras de validação dos prompts
```

A leaf may use shared fragments or have several input variants. The tree is a
view over one registry; common prompts must not be copied into unrelated leaves.
Expose function/domain overrides beneath the chosen leaf or in its scope picker
with effective breadcrumbs. Do not duplicate the whole tree per domain.

## 3. Inventory of current runtime owners

This source inventory was inspected on 2026-09-12. A0 repeats it against the
current working tree and records every prompt-producing path and repair suffix.
Task names declared in a schema are not proof that a corresponding prompt runs.

| Family | Current owner | Registry migration scope |
| --- | --- | --- |
| Source summary | [knowledge-processing.ts](../apps/desktop/src/main/services/knowledge-processing.ts), `summaryPrompt` and `summaryReductionPrompt` | Short summary, map summary with grounded concepts, reduce prompt and non-content result instruction. |
| Hierarchy summary | Same file, `buildAggregateSummaryPrompt` | Parent kind/title, ordered child summaries and aggregate instructions. |
| Atomic notes | Same file, `buildAtomicNoteGenerationPrompt` and `buildAtomicNoteRepairPrompt` | Source/chunk input, extraction instructions, repair feedback and output-schema reference. |
| Note matching | Same file, `buildBatchRerankPrompt`; [KnowledgeService](../apps/desktop/src/main/services/knowledge-service.ts) | Candidate ordering, relation explanations, permitted types, reference aliases and effective matching parameters. |
| Graph extraction | Same file, `buildKnowledgeGraphPrompt` and `buildKnowledgeGraphRepairPrompt` | Source-chunk/note/catalog variants, identity descriptions, language instructions, remaining limits and repair. |
| Relation-type equivalence | [relation-type-resolution.ts](../apps/desktop/src/main/services/relation-type-resolution.ts) | `buildRelationMatchPrompt`, candidate lists and repair suffix. |
| Entity identity | [entity-identity-resolution.ts](../apps/desktop/src/main/services/entity-identity-resolution.ts) | Identity variant of the shared matching prompt, evidence and repair suffix. |
| Relation descriptions | [relation-label-processing.ts](../apps/desktop/src/main/services/relation-label-processing.ts) | Natural-language labels and repair text. |
| Source matching | [source-relation-processing.ts](../apps/desktop/src/main/services/source-relation-processing.ts) | `sourceRelationPrompt`, limits, directed evidence, prior decisions and validation-feedback suffix. |
| Wiki synthesis | [organization-service.ts](../apps/desktop/src/main/services/organization-service.ts), [organization.ts](../packages/domain/src/organization.ts) | Fixed action contract, built-in guidance/advanced slots, state guidance, target/context composition and repair. |
| Consultation | [consultation-service.ts](../apps/desktop/src/main/services/consultation-service.ts) | `consultationPrompt`, configured guidance, scope/context blocks and repair suffix. |
| Maintenance | [maintenance-service.ts](../apps/desktop/src/main/services/maintenance-service.ts), domain built-in weekly/monthly/cleanup slots | Structural contract, routine guidance, candidate/policy composition and forthcoming content routines. |
| Embedding instructions | [ai-service.ts](../apps/desktop/src/main/services/ai-service.ts), `withEmbeddingInputInstruction` | Model-specific query prefix; explicitly label models/inputs that have no natural-language instruction. |
| Embedding content formats | [canonical-embedding.ts](../apps/desktop/src/main/services/canonical-embedding.ts), KnowledgeService, [job supervisor](../apps/desktop/src/main/services/job-supervisor.ts) | Source/chunk/note/entity/type serialization, separating editable wording from typed formatting. |
| Shared output language | AiService and its imported task helpers | Register the actual language fragment inserted around generative requests. Never apply generation-language instructions to embeddings. |
| Model diagnostics | AiService `testLocalModel` and remaining actual diagnostic callers found in A0 | Generative smoke text, embedding smoke input, expected test output contract and synthetic instruction samples. |
| New wiki functions | Future curator, TOC, investigation and content-maintenance services | Must use the registry from their first implementation. |

Adapters own transport and model chat formatting, not an additional hidden copy
of application prompts. Record app-owned adapter instructions if discovered.
Provider-internal instructions and model-native chat templates are external
runtime behavior; expose their provenance/limits without pretending to edit them.
Deterministic Docling conversion, metadata lookup and file synchronization do not
gain fictional prompt editors just because they support an AI application.

## 4. Variable and composition contract

### 4.1 Syntax

- Tokens use `%variable_name%`, with stable lower-case ASCII snake_case keys.
  The UI translates their descriptions, not the persisted keys.
- Parse templates into literal/token segments. Use `%%` to escape a literal
  percent; ordinary percentage text such as `50%` remains literal. Validate
  malformed placeholder-like input and document these rules beside the editor.
- Unknown tokens, unresolved required data and type mismatches block execution
  before entering the model queue. Optional values use a declared empty/default
  representation, never a silent invented value.
- Interpolate once. Source text containing `%other_variable%` remains data and
  cannot invoke another substitution, instruction, file read or capability.
- Shared fragments are explicit registered dependencies, with a cycle-free
  composition graph and pinned revisions. No arbitrary includes, script
  expressions, shell expansion, SQL or environment-variable lookup.
- Structured lists/objects use the registry's typed serializer and stable aliases;
  prompt authors cannot turn a UUID-looking string into an authorized target.
- Keep context/output/tool limits in code. A prompt variable may display their
  effective values but changing prose never raises the backend allowance.

### 4.2 Variable registry

Each variable definition includes key, localized description, value type, scope,
required status, origin resolver, safe example, sensitivity classification,
serialization mode and applicable prompt IDs. Only the backend resolves real data.
Secrets and credentials are never variables.

Example editable page-synthesis body:

```text
Develop the page "%page_title%" in %content_language%.
Apply this editorial guidance: %editorial_guidance%

Current page:
%current_page%

Original evidence:
%original_evidence%

Related knowledge:
%related_knowledge%

Preserve attribution and disagreements. Propose at most %max_sections% section
changes, using %output_contract%.
```

The table directly below that field would contain:

| Token | Function | Type and origin |
| --- | --- | --- |
| `%page_title%` | Identifies the intended subject | Text from the admitted page/plan. |
| `%content_language%` | Controls the generated content language | Supported language from the pinned run. |
| `%editorial_guidance%` | Supplies effective global/function/domain guidance | Versioned instruction fragment. |
| `%current_page%` | Provides the exact existing page revision | Scoped, serialized editorial content; empty for a new page. |
| `%original_evidence%` | Supplies cited source passages and run-local handles | Bounded evidence manifest from the repository. |
| `%related_knowledge%` | Provides eligible notes, relations or pages | Scoped context with evidence lineage. |
| `%max_sections%` | States the permitted section-change ceiling | Integer from effective backend limits. |
| `%output_contract%` | Shows the required response structure | Versioned, read-only schema/contract fragment. |

Other families need variables such as `%source_title%`, `%source_type%`,
`%chunks%`, `%partial_summaries%`, `%ordered_subparts%`, `%candidate_notes%`,
`%entity_candidates%`, `%allowed_relations%`, `%question%`, `%validation_errors%`,
`%previous_output%`, `%maintenance_scope%` and `%changed_inputs%`.
The authoritative list is derived from the registered template and resolvers;
this example list is not an allowlist shared indiscriminately by every prompt.

### 4.3 Editable guidance and enforced contracts

All app-owned natural-language prompt text must be discoverable. Substantive
instructions are customizable. Show required output/tool contracts and their
purpose in the composition preview even when they are not editable prose.
Keep schemas, permission checks, identity resolution and evidence validation
enforced by application code. Removing a schema token cannot remove validation;
missing required structural fragments cause an explicit validation error.

Allow useful formatting and editorial customization without exposing raw
credential/provider internals. Editing a token's surrounding prose does not change
model temperature, token limits or matching thresholds; link to their owning
settings and show effective values when used by a prompt.

## 5. Storage, inheritance and runtime use

Use a central typed registry with immutable shipped defaults and PostgreSQL
overrides/revisions. Candidate implementation owners are domain schemas,
application `PromptService`, a prompt repository and a deterministic renderer.
These names are proposals; no new package or template-engine dependency is needed.

Each entry records stable ID, category path, purpose, caller/task, template parts,
declared variables, schema version, default version and fixture references.
Store user drafts, immutable activations and restoration history separately.

Resolve application default -> global guidance -> function override -> domain
guidance -> domain/function override deterministically. Guidance and full-template
replacement have distinct semantics; do not concatenate contradictory templates.
Only functions supporting a domain accept domain overrides. Show the effective
origin at the field and never blend instructions across domains implicitly.

Migrate current Organization settings into the same registry, keeping their
history and pinned legacy snapshots. Organization and Maintenance settings link
to their relevant Prompts branch; they do not maintain a second prompt editor or
configuration authority.

Every actual generative call, repair, reranking call and instruction-bearing
embedding request must resolve through the registry. Include prompt IDs, active
revisions and the composition hash in canonical AI audit metadata and derivation
fingerprints. Pin them with the job configuration; a queued/running job never
silently switches to a newly edited prompt.

Changing an embedding instruction or content serialization changes its effective
embedding-space/strategy identity. Never compare new query vectors against
incompatible stored vectors. Offer an explicit, bounded re-embedding plan; do not
regenerate the library just because a prompt was saved.

## 6. Migration and activation

1. Inventory callers and register default templates without changing rendered
   behavior. Golden fixtures verify text/structured-input equivalence.
2. Mechanically convert known `${...}` builder inputs and supported legacy
   `{{title}}`/`{{language}}` slots into declared `%...%` variables. Keep old syntax
   only inside versioned legacy readers; never guess replacements in arbitrary
   user prose. Ambiguous drafts remain recoverable for manual correction.
3. Migrate existing instruction overrides with their function/domain meanings.
   Preserve the effective active configuration until migration validates.
4. Ship the tree/editor, field-level variable lists, composition preview, default
   reset, history and safe synthetic tests.
5. Migrate existing runtime families in bounded batches and add caller-coverage
   tests. A catalog that only displays copies while execution uses inline strings
   does not satisfy the feature.
6. Activate changed templates only after deterministic template/schema checks and
   the applicable bounded proposal-only/sample validation. A missing model leaves
   a saved draft; it does not discard the user's text or activate an untested
   advanced contract. Reuse validation for identical effective compositions.
7. New activations affect future admissions. Existing artifacts retain their
   original prompt audit. An older instruction version is not stale evidence;
   reprocessing is an explicit action or a previously enabled policy operation.

Default previews use synthetic examples. A deliberate preview with selected real
content obeys source scope and displays it locally. It does not enable persistent
full-prompt capture. Stored full prompts/outputs continue to require the existing
monitoring capture settings; ordinary audit keeps IDs/hashes without source bodies.

## 7. Acceptance and implementation placement

A0 inventories/contracts the registry. A1 implements the catalog, editor,
variables, persistence and current-family migration. New A2–A7 wiki functions
register their templates as they are implemented. A8 verifies complete coverage.

Required checks:

- Every executable app-owned prompt family has a discoverable leaf, including
  repairs, shared fragments, model-specific instructions and diagnostics.
- Editing and activating a leaf changes the actual next eligible runtime call;
  restoring default restores behavior. History survives restart and migration.
- Every field lists exactly its used variables with functions; insertion,
  highlighting, unknown/missing tokens, escapes and safe literal source values work.
- Composition cycles, unsupported types, malformed variables and missing required
  contracts fail before inference. Data cannot mutate scope or permissions.
- Queued jobs preserve the original prompt/model snapshots. Shared fragment edits
  expose all impacted compositions and need appropriate sample coverage.
- Legacy prompts/settings retain behavior on upgrade; active pages and evidence
  are not rewritten. Prompt-aware fingerprints prevent incompatible artifact reuse.
- Embedding prefix changes cannot cross model spaces; text fallback stays usable.
- Full-prompt logging remains off unless deliberately enabled through Monitoring.
- Search, tree keyboard navigation, long localized labels, the variable table and
  preview work at the normal app window size in all supported locales.
