# M3 mixed-source organization and cited consultation

Implementation status: accepted by the coordinator after the deterministic and
real-model checks below. Luna is the semantic reference; contained local model
failures are best-effort limitations and do not block the milestone.

## Delivered boundaries

The existing organization executor accepts bounded grounded summary concepts,
optional notes with complete source-link fingerprints, scoped entity mentions
and qualified canonical source relationships. It still uses three application
tools, the existing FIFO/adapters and canonical organization checkpoint/receipt.
New topics use the explicit topic kind; protected revisions require review.

Explicit `organizeKnowledge` processing depends only on segmentation. A saved
plan supplies topic/profile/privacy/domain options. Reconciliation examines
selected derivation checkpoints and active parent/stage jobs, preserving both
matching barriers, catalog completion and failed/partial inputs. One batch
admits one separate organization run. Exact title/alias reuse requires complete
scope eligibility; conflicting existing topics produce a visible scope error.
Batch/source cancellation reaches linked organization work and pending review.
No matcher or new optional derivation is invoked to fill a gap.

`ConsultationService`, `consultationRepository`, typed domain contracts and
validated IPC form a separate read-only answer workflow. It retrieves originals
using independent text/title/concept/note/entity/wiki/canonical-relation signals
and optional compatible vectors. RRF ranks original chunks and reserves other
works without excluding chapters. Standalone/corroborated vector floors reuse
the existing provisional 0.48/0.40 retrieval policy. Full provider/model/runtime/
dimensions/space identity and content hashes filter vectors; privacy can remove
the embedding signal before provider exposure. No missing embeddings are generated.

At most 12 complete passages plus qualified optional context are packed within
the selected profile budget. Answers have strict paragraph/citation/context
manifests, one repair, 2,048 output tokens per call and a two-minute deadline.
Readiness is revalidated inside the existing FIFO and immediately before provider
execution. Changes during inference produce a stale result that cannot be saved.
Coverage is explicitly bounded; missing evidence is not a universal absence claim.

Explicit answer saving atomically creates a settled dispatch job and reviewable
proposal, with an idempotent request identity. It retains original evidence,
configuration/profile and existing canonical AI audit links. The durable proposal
checkpoint makes cancellation/retry return to review without inference. Apply
uses M2's guarded transaction and canonical receipt. Unsaved answers are bounded
session state (20 entries, 30 minutes), and are not a durable conversation store.

Consultation has separate editable function/domain instructions and sample
coverage. Legacy M2 advanced prompts remain limited to synthesis until deliberate
configuration upgrade and consultation sampling. Free guidance retains inherited
scope. Saving/activating settings does not start processing.

`wiki_dependencies` and `knowledge_impact_events` retain exact section consumers
and transactional change events. Triggers cover canonical writers and deletion
cascades, including note-link manifests, original relation occurrences, notes,
entities and consumed wiki sections. Unrelated section edits and source processing
progress do not invalidate unchanged knowledge. Current read/apply validation and
historical citation snapshots remain independent of event delivery. Events do not
authorize automatic AI work; recurring maintenance remains M3b.

The UI adds scoped questions, explicit current-page/whole-library and descendant
controls, visible selections across pagination, source citation inspectors,
partial/stale states, saved-answer review, organization plan options and separate
function previews. It uses the existing themed cards, Markdown components,
source relationship review and all five locales. Source navigation keeps the
answer mounted while its native dialog is hidden, restoring it on Back.

## Migration

Drizzle generated append-only migration `0025_clean_the_spike.sql`. It adds two
tables, their indexes, transactional input/section impact triggers, and backfills
M1/M2 historical direct and exact relationship dependencies. The backfill excludes
preserved human sections when an M2 operation appended a new section. Baseline
and manifest include all 26 migrations. No DEV reset or canonical corpus change
was performed by this implementation agent.

## Deterministic verification

- Domain/DB/desktop compilation passed during implementation.
- The final targeted run passed **11 suites / 81 tests**, including source
  relationship, safe reference rendering, FIFO, packing, scope, instruction and
  processing regressions. The coordinator owns the final full-suite aggregate.
- `scripts/verify-organization.ts` passed on isolated real PostgreSQL, retaining
  M2 recovery, cancellation, receipts, source scope and protection checks. Its
  instruction fixture now requires both synthesis and consultation samples for
  a shared advanced domain override.
- `scripts/verify-wiki.ts` passed on isolated real PostgreSQL, retaining historical
  editing, deleted/superseded evidence, revisions, scope and catalog behavior.
  Its original-table index assertion excludes the new dependency table.
- `scripts/verify-second-brain-m3.ts` passed on isolated real PostgreSQL. It covers
  populated M2-history upgrades and exact-section backfill, empty baseline and
  migration history, types/indexes/triggers, scoped lexical retrieval, full vector
  space identity, optional concept/note provenance, read-only answers, concurrent
  atomic save/audit links/cancel-retry, guarded apply, FIFO-time note-link changes,
  exact relation occurrence impacts with surviving evidence, unrelated human
  section preservation, source operational no-ops, historical edits, terminal
  matching/stage barriers, partial batches, cancellation and topic scope conflicts.
- The existing real PostgreSQL source-relationship verifier also passed, covering
  populated upgrade/empty baseline, all vector spaces, directed chapter owners,
  deduplication/review preservation, invalidation/rollback, decision caches,
  durable budgets and deletion.
- The baseline verifier confirmed 26 migrations. It was invoked through
  `node --import tsx` because the sandbox blocks the `tsx` CLI's auxiliary socket.
  PostgreSQL verifier escalation was required for local shared-memory setup;
  all instances were temporary and cleaned up. No real AI model was loaded.

## Coordinator acceptance

The migration was applied through normal DEV startup, using the 1600 × 1200
opening size and `MEMORA_DEV_BACKGROUND=1`. The synthetic corpus remains 82
sources, 82 documents, 82 chunks, 150 notes and 97 canonical source relationships.
No database reset, queue cleanup or second local generative model was needed.
The Qwen 4B and Luna profiles were exercised sequentially with equivalent
evidence, instructions and output bounds. A larger context was authorized if
necessary; the final trials succeeded with bounded context selection.

Final coordinator checks passed: **90 suites / 546 tests**, whole-workspace
build/typecheck, format/diff and the 26-migration baseline verifier. The isolated
real PostgreSQL M3 verifier passed with the new note-link insert/delete locking,
unknown-cost, retained-gap and no-new-inference assertions. Its mock return was
aligned with its audit record so both report unknown cost instead of mixing
unknown audit cost with a zero-cost response.

Real consultation trials used the question: “Em quais condições a recuperação
da memória ajuda a retenção e quais limites impedem generalizar esse benefício?”
The scope was the existing “Recuperação da memória e seus limites” page, its two
original sources, global instructions, text retrieval and no descendant expansion.

| Trial | Canonical AI audit | Input / output tokens | Model time | Outcome |
| --- | --- | --- | --- | --- |
| Initial Qwen 4B | `8f564a37-4ad4-4e8c-a93b-81961d54f4d5` | 4,807 / 759 | 10,477 ms | Valid cited answer, one call |
| Initial Luna | `480ac907-c7f0-43ef-8693-df72100f5688` | 3,699 / 262 | 6,708 ms | Valid cited answer, one call |
| Final Qwen 4B | `12774ca2-4a87-464d-b3b9-7299f544d2bc` | 4,807 / 694 | 9,854 ms | Valid cited answer, one call |
| Final Luna | `a7dee336-0a2b-4031-ad4c-de9c08741d3a` | 3,699 / 228 | 5,742 ms | Valid cited answer, saved and applied |

The initial saved proposal was rejected during acceptance after the coordinator
found the usage/gap defects. The final saved run
`1ff82131-cd0d-43fd-b952-7d9110fb0b24` retains the original Luna audit, known token
counts and unknown cost. Its sole application receipt is revision
`74e8c9c3-6740-48f5-9928-be98180b6e26`, page
`156738cc-d4e4-4657-8a4c-045c55cced78`. Saving creates a settled proposal dispatch,
not a new inference; explicit review creates the page. The gaps remain in saved
Markdown. Source navigation and Back preserved the answer and selected evidence.

The actual Library processing trial selected “Recordar antes de consultar” and
“Limites da recuperação sob pressão”, requested only `organizeKnowledge`, reused
valid artifacts and supplied the topic “Memória: condições e limites”. Both
original document/segmentation revisions were reused. The first local run
`802e7282-7527-4cb1-a293-ea7eedc7a57b` stopped before inference for context capacity.
After packing, both profiles received 2 of 28 optional context items; the UI
disclosed the omitted portion and the completed selected inputs.

| Processing run | Calls | Input / output tokens | Model time | Outcome |
| --- | --- | --- | --- | --- |
| Qwen `9fdc4b96-3d78-409e-b1a5-5c4987191598` | 3 | 4,547 / 1,348 | 13,506 ms | Invalid model output contained; no page mutation |
| Luna `9d05f4d3-fef7-4590-b420-cc5c1c6fa4a5` | 3 | 4,243 / 497 | 13,754 ms | Reviewed and applied |

The Luna batch `267157bd-357e-40ee-aeef-7bebd0d75daa` produced exactly one separate
organization run. Its topic page is `81d78539-0687-41a4-a425-94e208073335`, revision
`11436986-b6e6-48ed-aacf-cec19916607c`. The final wiki has five pages. Canonical
source relationship review remains independent; no matcher, note generation or
graph generation was invoked by these organization/query actions.

Luna preserved conditional benefit, the pressure/feedback confound and limits on
generalization. Local answers were useful but stated the proposed mechanism more
strongly. The synthetic nature is explicit in the originals but is not repeated
in every generated paragraph. These bounded trials do not establish universal
model reliability or injection immunity. Local reported cost was zero; all Luna
costs were unavailable, never treated as zero. Generic ingestion retry is also
blocked while its linked organization is active; its regression passed.

## Coordinator acceptance corrections

The coordinator's actual trials exposed three presentation/persistence issues:
source-count copy reused a navigation label, saved-answer checkpoints omitted
original token/cost availability, and saved Markdown omitted explicit answer
limitations. These are corrected in the renderer, query checkpoint aggregation
and bounded save-proposal builder. Existing saved proposals recover honest usage
from their authoritative linked audits on read; no data rewrite or migration is
needed. All five locales now use dedicated source-count copy.

The first processing trial also showed that internal dependency manifests plus
27 optional contexts exhausted the local profile before inference. Organizer
prompts now omit bookkeeping while retaining it in snapshots, and admission
packs optional context with room for search and two full original reads. Omitted
context counts are visible. A targeted regression traverses search, both reads
and proposal with two passages matching the trial's sizes and an 8,192-token
profile. The owning source card now reports the organization checkpoint stage
and localized failure cause instead of the completed parent stage.

A final concurrency review strengthened note provenance validation: note parent
UPDATE locks and existing-link SHARE locks precede a fresh manifest read. New
real PostgreSQL regression code exercises concurrent link insertion/deletion
around dependency persistence; the coordinator owns its final execution. No
applied migration was modified. The updated targeted seed/usage/gaps/packing/job
presentation suites passed 29 tests, and domain/i18n builds plus DB/desktop
typechecks passed. Real-model stats and final aggregate acceptance are recorded
by the coordinator.
