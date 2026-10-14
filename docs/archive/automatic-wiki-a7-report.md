# A7 — Temporal interpretation and reviewed note evolution

The coordinator independently accepted A7 after the implementation handoff,
review corrections, real-model and native checks, and the regular DEV migration.
The implementation agent used only
synthetic temporary databases and deterministic model adapters, with no actual
model calls, personal vault access or regular DEV writes.

## Delivered behavior

Versioned interpretation records preserve exact original evidence, authorship,
current/historical/uncertain context and explicit support, contradiction and
supersession relationships. Event and validity dates retain year, month, day or
instant precision; unknown dates remain unknown. Publication, author-recorded
note dates, recording/import timestamps and interpretation revision timestamps
remain separate. Historical preferences can remain true when a later preference
is current. Native and Obsidian human saves cannot erase or rewrite prior records.

Deliberately supplied personal and daily notes can support qualified procedures.
The stored interpretation distinguishes the user's statements from AI inference,
and retains steps, experience, worked-when context, assumptions, limits and
corrections. Exact canonical originals are classified by their provenance, not
by a title such as “My interpretation.” This grants no application authority,
new policy permissions, profiling or causal/general efficacy claims.

Reviewed merge, split and cross-source proposals retain old note identities,
revisions, original snapshots and explicit successor links. Accepted participants
and new outputs gain knowledge ownership independent of an arbitrary source or
chunk cascade. Rejected proposals remain unchanged; replay uses the existing
canonical receipt. Currentness, review, support, protection and supersession are
independent. Historical source navigation becomes unavailable after deletion,
while exact excerpts and surviving attribution remain readable.

The existing curator, policy, FIFO, parent occurrence/month allowance, locks,
receipts and projection outbox own execution. Explicit `interpret_memory` and
`evolve_notes` grants are absent from old generic policies. Public manual intents
are `temporal`, `procedure`, `merge`, `split` and `cross_source`; existing enabled
routine passes also admit personal temporal/procedure work and optional reviewed
consolidation. Quiet generation dedupe prevents unchanged retries. Waiting for
review starts no inference. Pause blocks apply; deliberate same-policy resume
allows explicit human apply with the original shared allowance, while scope,
revision and conflict checks remain enforced.

Human review and semantic support see every generated interpretation and new note
field, its complete exact originals, and the deterministic final membership
substitution. Existing repair pages, protected memberships/order and expected
revisions are disclosed and revalidated. Only concrete unsupported assertions
fail semantic support; neutral editorial organization and ordinary paraphrases
are distinguished from empirical claims. Model evidence handles in note bodies
become numbered citations in canonical persisted evidence order.

Scoped search, consultation and portable projections check the complete retained
source set, including earlier interpretation history after current citations
narrow and source identities after deletion. Whole-library historical note search
survives primary-source deletion. Missing originals never become current evidence
or new scope authorization. Native source lists and portable source wrappers
include each retained attribution while sharing one canonical note/file identity.
Existing version-1 paths, editorial behavior and portable typed-link inverse maps
remain compatible; old revision links preserve old note identity and successors.

Native views display dated interpretation and procedure details in five locales,
localized timestamps, independent note ownership/supersession labels, retained
historical evidence and unavailable originals. History can open a complete
revision without restoring it, and Back retains that viewed revision. Linked-note
reads refresh on source return, reopening and the existing visible-page refresh,
retaining expansion and selected exact evidence. Review counts use final merged
memberships; Resume/Pause retains the selected policy. Source-deletion copy now
distinguishes source-owned artifacts from retained evolved knowledge/history.

## Persistence and compatibility

Generated forward migrations `0040_mysterious_talon.sql` and
`0041_knowledge_note_ownership.sql` follow the immutable A6 migration 0039.
The baseline contains 42 migrations and 100 public tables. Additions are
`atomic_note_evidence`, `atomic_note_evolution` and explicit atomic-note ownership
columns. Historical primary IDs remain recorded; separate nullable owning FKs
preserve legacy source/chunk cascades for source-owned notes. Migration backfill
preserves every pre-existing note column and avoids spurious update-trigger
impacts. The ownership constraint/trigger validates live originals on creation,
clears knowledge-owner cascades and prevents demotion.

Populated schema40→42 and independent empty-baseline PostgreSQL paths verify the
schema, migration journal, columns/nullability, indexes, ownership constraint and
trigger, prior extensions and canonical row preservation. Source deletion retains
organization/maintenance-linked audit receipts when their last original source
is deleted. Ingestion/upserts cannot reclaim knowledge-owned identities. Note
fingerprints exclude ownership-only metadata to preserve legacy matching.

No new dependency, scheduler, graph/assertion owner or spending allowance was
introduced. The remote context default remains 128000 under the existing effective
context resolver and lower known provider limits. Optional vectors, graphs and
summaries are not generated by A7.

## Implementation verification

The following checks passed:

- Full unit suite: 811 tests in 128 files; type checking and full workspace build,
  including desktop, preload and Obsidian plugin.
- Sandboxed preload initialized with only Electron supplied; the plugin CommonJS
  artifact initialized with only the Obsidian host module supplied.
- Baseline verification: 42 migrations; formatting and `git diff --check`.
- `scripts/verify-automatic-wiki-a7.ts` against populated upgrade and empty seed.
  It covers precise/unknown dates, retained qualified procedures, immutable human
  history, narrowed-current-citation scope, reviewed merge/cross-source, rejected
  and accepted split, primary and separate secondary deletion, exact excerpts,
  shared files/source wrappers, historical links, receipt replay and stale edits.
  A default installed policy with all four routine bindings verifies idle/restart
  review waiting, pause/resume/manual acceptance and unchanged parent allowance.
  A fault after note/repair writes verifies transaction rollback and safe retry.
- Existing PostgreSQL verifiers: `verify-wiki`, `verify-organization`,
  `verify-second-brain-m3`, `verify-maintenance`, `verify-automatic-wiki`,
  `verify-automatic-wiki-a3`, `verify-automatic-wiki-a4`,
  `verify-automatic-wiki-a5`, `verify-obsidian-wiki`,
  `verify-obsidian-editing`, `verify-obsidian-layout`, `verify-prompts`, and
  `packages/db/src/scripts/verify-source-relations.ts`.

Initial sandbox loopback/tsx IPC restrictions were resolved with approved local
execution or Node's import loader. A test-only repository method typo was corrected
before the final successful PostgreSQL run. These are not application failures.
All implementation test clusters clean up in `finally` and no implementation
model or GUI process was started.

## Coordinator evidence at handoff

The coordinator independently retained 17 actual selected-Luna calls across six
synthetic runs, all with 128000 context and unknown provider cost. Procedure01
passed semantic review (2 calls, 4041 input/953 output tokens, 20909 ms). Temporal01
passed with year/month precision and no invented day/time (3 calls, 7481/1791 tokens,
36227 ms). Merge01,02 and03 failed safely without canonical apply (2, 4 and 3 calls).
Their preserved failures exposed forbidden interpretation output, support-view
classification/membership gaps and editorial-purpose overrejection. The general
prompt/schema fixes were prospective and did not erase or bypass those failures.
Merge04 passed semantic proposal review (3 calls, 9139/1415 tokens,29794 ms).

Coordinator native procedure reading verified AI/uncertain labels, qualified
experience, exact diary evidence and source-return/Back context. Native merge04
review verified paused rejection, deliberate resume and human acceptance without
extra calls or allowance. After actual synthetic primary-source deletion, the
coordinator's cold receipt retained 3 knowledge-owned notes, 4 original snapshots,
2 evolution edges,3 note revisions and the same 3 AI audits/parent 3 reserved calls
and 50333 tokens; the index had one merged membership. These are coordinator
observations, not implementation-agent native claims.

Receipts are under `.cache/automatic-wiki-20260912/`, including the procedure,
temporal and merge review JSON files, all failed model-step outputs,
`a7-ui-merge-after-native-delete-receipt.json` and
`a7-native-merge-preservation-review.json`. The final native and regular DEV acceptance is recorded below. Actual final
temporary-vault reading remains explicitly assigned to the A8 product matrix.

## Independent acceptance

The coordinator reran all 811 tests in 128 files, type checking, full workspace
build, preload initialization, plugin CommonJS initialization with only its
Obsidian host dependency, baseline42 verification, formatting and whitespace checks.
Independent real PostgreSQL runs passed for A7 populated40→42 and empty baseline,
A2–A5, wiki, organization, M3, maintenance, prompts, source relations and all three
Obsidian wiki/editing/layout verifiers. Final review additionally corrected the
legacy source writer: secondary attribution cannot claim a knowledge-owned note
or another source's note. Curator admission also rejects retained notes whose
original evidence is no longer current. Both boundaries have real PostgreSQL
regressions. Test-fixture root and queued-projection interference were corrected
before the final passing run; no application guard was relaxed.

Native DEV checks passed at1600×1200 and960×640 without fullscreen, in light/dark
and all five interface locales. Review resume/pause retained policy selection;
the final merge preview contained one membership. Source return refreshed missing
evidence without losing expanded notes. Revision1 opened read-only, retained both
old note identities and the successor, and survived source navigation/Back. The
surviving source listed its original and shared evolved note with independent
ownership/supersession labels. The revised deletion confirmation was inspected and
canceled. Procedure reading retained unknown dates, the distinct September1 author
date, localized import/revision timestamps, assumptions and single-experience
limits. Cold receipts confirm unchanged3 merge audits/3 note revisions and2
procedure audits; no extra inference or vectors arose from reading/review.

The regular DEV upgraded40→42 through the existing migration runner after another
successful restore of the pre-A7 backup. Exact old-column row digests for all98
prior public tables remained unchanged. Catalog checks verified13 new columns,
four indexes, ownership constraint/trigger, ten foreign keys and both vector/AGE
extensions. The regular DEV remains at0 wiki pages,13 sources,42 vectors and335
AI audits, with0 jobs executed or policies activated by migration. The cluster
was stopped cleanly. Receipts are `a7-dev-migration-result.json`,
`a7-dev-catalog-verification.json` and `a7-native-final-coordinator-review.json`.

A8 still owns the complete combined journey, final actual-editor Obsidian matrix
and package/rollout gates. A7's automated portable compatibility checks do not
claim a new native Obsidian walkthrough. The requested Obsidian quit/relaunch
succeeded; selecting the synthetic vault remains pending because further personal
vault inspection was rejected by automatic approval review. No personal vault was
edited. The user's DEV-only restriction still applies to executable package smoke.

## Durable specification changes

Updated `rules/second-brain.md`, `rules/database.md`,
`rules/ai-and-knowledge.md`, `rules/integrations.md`,
`rules/jobs-and-processing.md`, `rules/frontend-and-i18n.md` and
`rules/source-search.md` document the contracts above. `STACK.md` is unchanged.
