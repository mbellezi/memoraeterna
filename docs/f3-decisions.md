# F3 decisions: Relations v2 and AI runtime lanes (2026-10-17)

Binding design decisions for phase F3 (`docs/plan.md` decision 22). The plan holds the F3 task boxes (T42-T66),
waves and exit criteria; this file records how and why F3 is built that way, and the rules every measurement
follows. Values marked *(cal.)* are start values that a named measurement confirms or revises. "Q" marks an owner
question; every one was answered on 2026-10-17 with its default (Owner approval, below). The exit criteria X1-X7 and
S1, the datasets, the seeds and the budget are defined under Measurement; the gates 0, M, R, F, P and X under Gates.
Relation words: **applied**, **suggested**, **shown** and **withdrawn** are the visibility predicates of D9; the
**accept band** is applied plus suggested (D23). Evidence: `docs/kpi-f1a.md`, `docs/kpi-f1b.md`, `docs/kpi-f2.md`
and the spikes under `docs/spikes/` (Spike A, A2, `source-relations-plan.md`). The task cards (owned files, tests,
proofs) are the orchestrator's implementation spec; where it and this file differ, this file wins.

## Owner approval (2026-10-17)

- **As relayed by the orchestrator** (its words, not the owner's): the owner approved the F3 budget and every
  owner-question default Q1-Q20.
- **Covers:** the live Codex runs of the Budget (about 945 calls and 1.3M tokens, a 0.4M reserve, a 1.7M cap with
  its drop order); about 2,000 Decisions API requests on synthetic text under US$1 (D6); the Claude usage of the
  Budget, including the three-judge panel; work on every default below.
- **Does not cover** (the orchestrator stops and asks): work before M2 that would cross its subtotal plus reserve
  (595k tokens); a product OpenAI Decisions adapter; making a decider other than the MLX ranker the default (D16,
  outcome rule); changing the X1 bar when gate 0's held-out aggregates fall short with complete tuning recall; X2
  still above 5% after the escalation lever; changing the soak writer when only the local writer's graph repairs
  break X6; re-basing the X7 target (Q8); re-matching or re-typing the DEV library's relations (D47).

## Decisions

### Measurement and process

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D1 | **Measure first.** M0 (about day 4, $0) re-scores stored runs and cassettes and runs the benchmarks B1 (ms per directed pair through the helper's `pairs` input at 16, 32 and 48 pairs per call) and B4 (candidates per note after the lossless filters, the share already scored from the other endpoint, reverse-guard completions) before relation code changes. Gate 0 stops the line on candidate recall, the X1 forecast, the X7 projection and the throughput forecast. M1 measures the slice with provisional settings on the tuning partition; M2 measures the frozen configuration. | F1a-F2 showed that late measurement costs re-records and owner quota; M0 shows by day 4 whether X1 is reachable on the pinned notes at all. |
| D2 | **Exit metrics are pinned before any code** (Measurement). "Several samples" = four (three arrival orders and one batch-1 perturbation). "Today's reverse-only acceptances" = two sets, R_v6 and R_v9; loss = panel-related pairs of the set the frozen pipeline does not put in its accept band, over the panel-related pairs of the set; adjudicated loss gates, literal loss is reported (Q1). "200 notes end to end" = relation work only, from the first decide admission to the last relation, typing, veto or source-relation commit, normalized to 200 notes. "Past deadline" = settled more than 2 s after its deadline, or never settled. "Repair" per D35. "Reference chapter" = 30 chunks. "≤5 s per source" = AI-call seconds per source (wall reported). | Spike A left the reverse-only metric undefined; six exit metrics had no definition. |
| D3 | **Pre-registration and the freeze guard.** Every choice (instruction, text template, aggregation rule, k and any retrieval limit, isotonic maps, bands, escalation, discovery neighbours) is made by the rules of this file (Measurement, Pre-registered selection rule) on the panel fit labels and the fixture tuning partition. T58 writes `.cache/f3/freeze/frozen.json` (config hash, calibration identity, parity scores, input hashes, UTC time) before any held-out read; the evaluator and the bake-off scripts refuse to print a held-out result without it. M1 and gate R read tuning only. Before the freeze, held-out is read only through the evaluator's `--pre-freeze-feasibility` mode, which prints two aggregates and nothing per pair: the count of expected held-out root pairs some note pair of which reaches the decider at k = 20, and the MLX expected and forbidden held-out counts at Spike A's frozen rule (max of both directions, 3.3125 MLX / 3.16 GGUF log-odds). No design change may be justified by them; retrieval is diagnosed and changed on tuning pairs only. **The fixture held-out is recorded as pre-read**: it was read in every F1a-F2 run and its misses are named in `docs/kpi-f1a.md`, so the panel's eval split, on which nothing is chosen, is reported beside X1 as the clean check (Q20). A re-freeze after a failure gets a new hash and is reported beside the first. | Keeps held-out a validation set. Freezing by convention let earlier designs read held-out under provisional settings and then fix what they saw. |
| D4 | **Labels by the panel (decision 21).** About 300 note pairs: pool A 120 from the fixture tuning roots (synthetic), pool B 90 from golden-small (public), pool C 90 from the corpus (public, 30 of them same-leaf different-article hard negatives), stratified by MLX score band; 40 source pairs, plus the nearest and second-nearest pairs of every golden root and of 20 corpus roots; R_v6 (37) and R_v9 as evaluation-only sets, R_v9 labelled as every pair any evaluated configuration loses plus a seeded random sample of 50. Three independent blind Opus 5.5 judges on compact pages (20 pairs per prompt), majority per question, unanimity share and Fleiss κ reported. No fixture held-out root enters the fit labels; owner text is never used; the labels fit the calibration as well as evaluate it (Q10). Weighted precision, the isotonic fit (weighted PAV) and ECE all use the same population weights (stratum population over labelled count), recomputed on F3's own retrieval at M1; weighted precision carries a Wilson 95% lower bound. | Decision 21 is binding; stratification gives every band mass; an unweighted fit on a stratified sample is unbiased only for the score used to stratify, which a bake-off pick of another instruction, template, rule or decider changes. Replaces the plan's "~300 owner-labeled pairs (1.5-2.5 h)". |
| D5 | **Pinned measurement without a re-pin.** `MEMORA_GOLDEN_PIN=extraction` (golden-only knob, also honoured by the E6 runner `topics-e2e/run.ts`) keeps the recording-era path for extraction, entity identity and relation-type resolution: strict parse, whole-output repair, no salvage, no item-level repair, no tolerant recovery, and the 3,500-character graph batch, so every recorded repair replays. Quality samples run through the re-match harness on clones of ENV-F, whose 138 notes are the pinned notes, with no re-ingestion (identity and type-resolution prompts read canonical state that depends on ingestion order). Every sample starts from a fresh profile clone and its own cassette copy; golden and re-match runs use serial lanes and link pool 1 unless a timing run sets `MEMORA_AI_LANES=product`; throughput reruns use recorded-timing replay; every run reports its live tokens. | Decision 15; the owner's quota. A graph re-pin would cost about 650k tokens; with salvage on, a replay would skip recorded repairs and change every later prompt. |
| D6 | **The Decisions API only in the bake-off**, through the existing spike client (`scripts/spikes/decisions/client.ts`), on synthetic fixture text only (pool A, R_v6, fixture candidate lists). The script reads `OPENAPI_KEY` from `.env` at runtime and never prints, logs or stores it. No product adapter in F3 (Q6). | The owner's instruction for the test key; Spike A2's order and composition sensitivity; privacy. |
| D7 | **Run hygiene.** Every run is reported, never only the best. A result within 10% of its bar gets one same-day second run and both are reported; second runs are paid from the reserve of the Budget, and at the cap its drop order applies. | Noise between runs is the size of the margins. |

### Relation data

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D8 | **Canonical pair plus explicit direction.** `atomic_note_relations` keeps its column names and holds the UUID-sorted pair (CHECK `source_atomic_note_id < target_atomic_note_id`). A new `direction` (`lo_to_hi`, `hi_to_lo`, `symmetric`, `unknown`); `unknown` only on legacy rows (no band). Backfill from `metadata.semanticSource/TargetAtomicNoteId` when it names exactly the pair's two notes; `metadata` is never rewritten. New rows stop writing those metadata keys, and a static test bans reading them outside the migration and its verify script. | The upsert sorts the endpoints by UUID, so the direction of directed types is arbitrary today, and the dashboard, Library and evaluator read the column order. A column rename costs about 43 files on the critical path; the metadata keys hold note IDs, and a rewrite would change the old evidence fingerprint. |
| D9 | **Automation's outcome apart from human review, one visibility module.** `status` keeps its human meaning (`pending_review` = no human verdict). New `band` (`apply`, `suggest`), `vetoed_at` and `veto_source` (`explainer`, `typer`). `packages/db/src/repositories/note-relation-sql.ts` exports the predicates **applied** (human `accepted`, or `pending_review` not vetoed with band `apply` or a legacy null band), **suggested** (`pending_review`, not vetoed, band `suggest`), **shown** (applied ∪ suggested) and **withdrawn** (vetoed, `pending_review`). Each also requires both endpoints current (not rejected or archived, `supersession_status = current`) with current primary evidence (the note's evidence chunk belongs to a non-superseded document): this is the rule's "supported by evidence from both endpoints". A fifth, Note-page-only predicate, **earlier version**, keeps F1b's listing of applied relations whose other note is superseded, in their own group with the `superseded` flag, never shown, drawn, promoted or counted in X1. A static test forbids any other filter on `status`, `band` or `vetoed_at` in repositories and scripts. | Readers filter differently today; new states must be invisible by default everywhere at once; an enum change would hit the one-transaction migrator. Without the fifth predicate the Note page would silently drop its superseded group. |
| D10 | **One write vocabulary, legacy readable.** Writes use supports, contradicts, extends, depends_on, example_of, clarifies and same_as (directed: supports, extends, depends_on, example_of, clarifies; symmetric: contradicts, same_as). `none` is a veto and never stored. CHECKs accept the old values plus the new; readers map legacy values to stances as the UI does today; no row is rewritten, and `similar_to` never becomes `same_as` (it keeps the neutral stance). `relation_type` becomes nullable: null marks an untyped v2 row (D20). | Spike A2: old and new types agree on 41% of pairs, and 29 `similar_to` rows have no counterpart. |
| D11 | **Facts-only source-evidence note fingerprint:** `md5(relation id, lo, hi, direction, coalesce(type, ''), facts(lo), facts(hi))`, excluding status, band, probability, veto and `metadata`. The migration recomputes `snapshot.noteFingerprint` for every evidence row current under the old formula in the same transaction, and raises if current source-relation or evidence counts differ before and after. Note-origin evidence is current only while its note relation is applied: a vetoed note relation stops supporting its source relation. | The old fingerprint hashes the status and `metadata`, so any F3 write would silently make source relations non-current; a veto is not a status, so the old `status <> 'rejected'` check would let a promoted source relation outlive a withdrawn note relation. |
| D12 | **`relation_decisions` gets a score scale.** `score_scale` (`probability`, `log_odds`) with a scale-aware CHECK: the [0, 1] range and the type-score nullness hold only for `probability`; ranker rows store raw log-odds per direction and no per-direction type. `accepted` and the pair-level `relation_type` stop being written (the CHECK `relation_decisions_accepted` is dropped); the columns go in F4 with the legacy tables. | Log-odds would violate `relation_decisions_directions`; `accepted` is a calibrated outcome inside the raw table, and nothing reads it. |
| D13 | **Decision reuse and two decider identities.** A stored direction score is reused iff the **decider cache key** and both notes' rendered-input hashes match. The hash is the SHA-256 of the exact text the decider saw for that note (template `relation-pair-text-v1`: title, idea and the first 400 body characters; the bake-off chooses 400 or 600). Cache key v2 = contract, instruction-text hash, text-template version, model identity (provider, model, runtime, repository, revision, quantization, artifact SHA-256), runtime build and effective parameters, **including the helper batch size**, which the `pairs` rank request carries in `parameters` (the topic gate's `{query, documents}` request is unchanged); batch composition is not in the key. The **calibration identity** = contract, instruction-text hash, text-template version, aggregation rule, provider, model, runtime kind (`mlx`, `gguf`), repository, revision, quantization and artifact SHA-256, with **no runtime build and no batch size**; calibrations are keyed by it. On a runtime-build change (a rebuilt or packaged helper, a node-llama-cpp upgrade) `LocalModelService` re-runs the ranker validation smoke and a **score-parity check**: the 64 directed pairs of `packages/ai/src/ranker-parity-reference.json` (synthetic text) against the scores stored with the calibration; max \|Δ\| ≤ 0.125 log-odds reuses it, otherwise the decider is `uncalibrated` with a visible status and the topic gate takes its decision-19 path. While validation runs, decide is unavailable: placement takes the decision-19 path and matching waits as in D16. | A title-and-idea hash would reuse a stale verdict after a body edit; bf16 batch noise (mean 0.09, p99 0.31 log-odds) is absorbed by the cache. The MLX runtime build is the helper executable's SHA-256 and `rank()` refuses a validation with another build: a calibration keyed by it would leave every packaged or rebuilt helper uncalibrated for ever. |
| D14 | **Every automatic relation change is an event.** Append-only `relation_events(run_id, relation_kind, relation_id, pair_key, kind, before, after, at)` with kinds `applied`, `suggested`, `typed`, `untyped`, `vetoed`, `kept`, `removed`, `promoted`, `retired` and `reconciled`; `relation_match_runs` groups them. A tested helper reverts one run exactly (byte-equal rows) and names a later run that blocks it. Events keep IDs without foreign keys (F2 D32). No UI in F3: F4 builds undo and the Inbox on it. | Decision 2 (automatic with undo); a bad typer or recalibration would otherwise be irreversible in F3. |
| D15 | **A human review writer for note relations:** `relations.review {relationId, verdict: keep \| remove}` sets `status` `accepted` or `rejected`, final in both directions, clears any veto on keep, writes an event and re-promotes the pair's roots. It serves the suggested and withdrawn groups on the Note page until the F4 Inbox. | Without a writer, suggestions and vetoes accumulate with no resolution (F2 D29 precedent). |

### Deciding, typing, explaining

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D16 | **Deciders.** Default: the validated MLX Qwen3-Reranker-0.6B on `class:decide`, scoring both directions of every candidate in `AiService.rankPairs` calls of at most `rankPairsPerCall` pairs, helper batch 16. `rankPairsPerCall` is per runtime and capped so one bounded local call takes ≤1.0 s (the P0 budget): MLX 32 *(cal.)*, chosen at gate 0 from B1 between 16 and 32 (48 only if B1 measures 48 × t_pair ≤ 1.0 s); GGUF 16 *(cal.)*. Fallback: the GGUF Q8_0 ranker with its own calibration, fitted on product-adapter scores. `class:decide` holds validated rankers only. **Generative deciding** (the v9 decide-only contract) runs only through `op:` routes onto the legacy `reranking` task route, per the profile's note decider mode (`relations.deciderMode`): `ranker` (Local and Hybrid presets) skips note matching while no ranker is validated (the matching stages end `skipped` with `skip_reason = waiting_for_decider`, the run completes `succeeded` with the status "relations wait for the ranker", and a ranker validation re-runs those stages through the stage-level retry of D25; never a generative fallback in this mode); `ranker-else-generative` (Cloud) uses the generative decider while no ranker validates; `generative` only when the user chooses it in Settings › AI. A profile with no preset reads a **derived** mode at each matching admission: `ranker` when `class:decide` holds a validated ranker, else `ranker-else-generative` when its `reranking` route holds a generative model (its pre-F3 decider), else `ranker`. The generative decider, its repair and the source judge **state class `decide`** (decide deadline, pre-output bound, the lean Codex shape) and always resolve through seeded routes `op:note_matching_reranking`, `op:note_matching_reranking_repair`, `op:source_relation_matching` and `op:relation_escalation`, written by every preset and by `mapLegacyRoutesV1`; a static test fails when one is unrouted. bge-reranker-v2-m3 and OpenAI Decisions take part in the bake-off only (bge leaves decision 3's fallbacks, Q18). **Outcome rule:** the MLX ranker stays the default if its frozen configuration forecasts X1 and X2; if it fails and another local decider passes, it is an owner question, never a silent switch; a remote or generative decider is never the default. | Decisions 3, 12 and 19; Spike A: MLX on both directions 27-28/28 and 0/35, one direction misses the bar; F2 D17 defines `decide` as a validated ranker, and the topic gate's decision-19 fallback depends on `class:decide` never holding a generative model. Route keys go `op:` → stated class → task, and the stated class also sets the deadline and the decide shape, so a missing `op:` route would send the generative contract to the ranker. 48 pairs on MLX (about 1.4 s) and 32 on GGUF (about 1.8 s) break the P0 budget. A run held `running` while it waits would hang E6 (no ranker on purpose) and any library whose ranker never validates. |
| D17 | **Acceptance is the calibrated probability alone.** The legacy weighted score, its feasibility gate, `minRerankScore` and the metadata weight leave acceptance; v2 rows store `final_score = probability`. The "absent metadata" item is closed by removal (the Jaccard of always-empty entities, tags and concepts no longer scores anything; M0 reports the old blend with renormalized metadata for the record). Lossless filters only: pairs a human decided, pairs already related, and the decision cache (D13). Retrieval keeps k = 20 fused candidates with **no lossy cosine floor**, unless the gate-0 forecast fails at k = 20: then recall-lossless retrieval limits apply (the smallest K and highest floor whose fixture-tuning recall equals unlimited retrieval at K_max 30), with the matching rule edit in `rules/knowledge.md` ("retrieval limits are calibrated to lose no tuning recall"). | The blend rejected expected pairs the decider scored 0.65-0.90 (F3/F5, L2/L5, M3/M5, W2/W5, W3/W5); the old judge alone gave 28/28 against 27/28 blended. A floor is not lossless by construction, and the rule forbids lossy filters before a decider. Replaces plan 4.2 step 2's feasibility gate, "calibrated cosine floor" and "keep ~8". |
| D18 | **Isotonic calibration and bands per calibration identity.** Score s = max or mean of the two directions' log-odds (the selection rule picks). PAV on (s, panel label) with tied s grouped, adjacent blocks merged to ≥15 labels, per-block (k+1)/(n+2) smoothing on weighted counts, re-monotonized, flat outside the observed range. Bands: **apply** (P ≥ p_apply), **suggest** (P ≥ p_suggest), **reject**, with p_apply and p_suggest chosen by the pre-registered rule (Measurement). An uncalibrated decider only suggests, and the card says so. An uncertain-band escalation (generative decide-only through `op:relation_escalation`) is adopted only by the same rule (conditional T58e). Recalibration re-applies bands to stored raw scores with 0 calls (`relations:reconcile`, dry run by default; a relation leaves `apply` only below p_apply minus the hysteresis, 0.5 log-odds *(cal.)*), as one reversible `reconcile` run. | Plan 4.2 step 3; bf16 steps and a threshold that sat on a tie in Spike A. Replaces the `recommended-v2` note thresholds. |
| D19 | **Order independence by a reverse-neighbour guard.** After a note is decided, `note_match_state` stores the cosine of its k-th vector candidate (`kth_cosine`). A later note's candidates also include every earlier note x among its 2k nearest by vector with `cos(x, note) ≥ x.kth_cosine`. A property test on synthetic vectors counts batch-mode pairs missed over random arrival orders (0 expected within the top 2k); a 200-order offline replay over stored scores reports the judged-pair-set Jaccard against batch mode (median ≥0.99 expected) and the residual. | Without the batch barrier an early note never sees later ones. The text and entity signals are not refreshed in reverse; the replay reports what that costs. |
| D20 | **Typing per source.** After a source's notes are decided, its link job types the newly accepted pairs with one `relations.type` call (class write-fast) per ≤24 pairs: aliases in content order, the decider's note text, a strict-compatible schema `{"pairs":[{"p":"p1","t":"extends","d":"ab"}]}` (`t` in the write vocabulary or `none`; `d` = `ab`/`ba` for directed types, `both` for symmetric, `none` for `none`). Valid items are kept and missing ones re-asked once. `none` is a veto: no relation is persisted, a `relation_typings` row and a `vetoed` event (source `typer`) remain, so recalibration never re-asks. Cache by pair, both rendered-input hashes and typer key. The generative fallback keeps its own v9 type when it maps into the write vocabulary (contrasts → contradicts) and sends other pairs to the typer. **Untyped fallback:** with no writer route, at the daily cap (D26), with `MEMORA_GOLDEN_RELATIONS=local`, or after two failed typing attempts, accepted pairs are persisted untyped (`relation_type` null, neutral stance) and typed later by the root's next link job or a daily P3 sweep; a link job never fails for typing. An untyped relation is shown but never promoted; typing it, or any later change of its type or direction, enqueues re-promotion of both roots. **Small-source coalescing** (product only; off in golden and re-match drain mode): a link job with fewer than 6 pairs absorbs the pending pairs of other due link jobs up to 24. | Plan 4.2 step 4; Spike A2: predicate and type disagree on 143 of 2,298 rows, so typing is its own step; on small-source libraries typing calls dominate the remote lane. |
| D21 | **A decided relation becomes visible when its link job commits it**, typed or untyped (D20). | No veto flicker on screen; the latency is seconds. A hidden `pending_type` state and untyped-first display were rejected. |
| D22 | **Explanations stream and can veto.** `AiProgressEvent` gains text deltas from the Codex, OpenAI-compatible and Gemini streams, GGUF `onTextChunk` and MLX `delta` lines (D39). The service holds back the first 16 characters (the sentinel) and any partial alias token (`n1`, `n2`) until it resolves, pushes deltas on `relationExplanationDelta` coalesced every 50 ms, validates the final text before caching and replaces the streamed text with a repaired one when validation fails. Cache key `relation-explanation-input-v3` adds the prompt revision and the model identity. Class write-fast, P0. If the writer's whole answer is `NOT_RELATED`, the relation is withdrawn (`vetoed_at`, source `explainer`, an event): hidden from the list and the graph, listed under "Withdrawn connections" with Keep and Remove (D15). A hover after the 600 ms dwell counts as opening. No background backfill. | Plan 4.2 step 5; `rules/knowledge.md` forbids bulk or background explanations, so plan 4.2's "low-priority backfill" waits for F4 REFRESH and its rule edit. |
| D23 | **What the measurements count (Q15).** X1 and X2 count the **accept band**, i.e. shown relations (applied, suggested or kept); 0/35 forbidden applies to the accept band too; applied-only figures are reported. Source promotion uses **typed applied** relations (applied or kept, with a type); a suggestion is promoted when the owner keeps it. **This narrows decision 17's "accepted note relations become source relations" to applied ones**, and `rules/knowledge.md` Relations bullet 4 says "applied note relations (automatic or kept by the owner)". | Plan 4.2 step 3 defines suggestions as the part of the accept band not applied automatically, so the accept band is the decider's acceptance; promoting only applied relations keeps source relations at the apply precision. The narrowing is recorded here so it is visible, not implied. |

### Per-source matching and source relations

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D24 | **Per-source matching with no barrier.** Decide runs inline in each source's own heavy ingestion job right after its knowledge-graph stage (local lane, per-note checkpoint). It commits decisions and checkpoint, parks `sourceMatching` with reason `linking` and enqueues the deduplicated light job `relation-link:<rootId>` on a new third light worker, `relations` (pool from typed config, start 2 *(cal.)*; 1 in golden and re-match runs). The link job types, persists, records events, emits `relationsChanged`, promotes and discovers (D27); the run completes when its link job does. An in-process in-flight registry keyed by pair (typing) and by source-pair key (judging) stops two jobs from paying for the same call. The domain DAG gains `sourceMatching ← atomicNoteMatching`. | Plan F3 and decision 17: typing and discovery on the remote lane overlap deciding on the local lane. `rules/architecture.md`: light work never waits behind a model call it does not make, so link jobs do not sit on the topic `model` worker. Replaces the batch barrier in `job-supervisor.ts` and the collective source stage. |
| D25 | **A knowledge-graph stage failure no longer stops matching.** Matching runs with the graph signal absent; the KG stage stays failed and retryable; the run says "graph incomplete". **Representation, no enum migration:** the run ends `succeeded` (`ingestion_run_status` keeps its five values) with its KG stage row `failed`, and the localized status "graph incomplete" is derived from that row. `job-retry.ts` gains a **stage-level retry** that re-runs one failed or skipped stage of a finished run (the KG stage here; the matching stages skipped with `waiting_for_decider`, D16), putting the run back to `running` while the stage runs. | 10 of 18 E6 runs with a local writer failed at the graph stage and never matched. A new run state would need an enum migration that gate M does not cover. |
| D26 | **Daily cap on background remote relation calls** (`relations.ai.maxBackgroundCallsPerDay`, start 500 *(cal.)*) until F4's money cap. It counts P2 and P3 typing and discovery calls on remote lanes, not golden or re-match runs (`MEMORA_GOLDEN_MAX_TOKENS` bounds those); P1 link-job calls (an interactive import) are not capped but are counted in the same daily counter and shown in the status. At the cap, typing applies untyped, discovery waits, promotion of typed relations and local deciding continue, and the job status says why. **On a priced (API-key) route this call cap is the interim spending control until F4's money cap**; the spending sentence of `rules/security-privacy.md` is tagged *(target F4)* (T65). | `rules/security-privacy.md`: subscription routes are bounded by concurrency and call caps; the untagged "automatic background spending obeys the user's monthly remote cap" is not met by a call cap on a priced route, so the gap is recorded instead of implied. One fixture sample makes about 125 remote relation calls. F2 D34 precedent. |
| D27 | **Source relations by design E (decision 17).** (1) **Promote** every **typed** applied cross-root note relation with no call: one source relation per (root pair, type); type = the majority directed type (ties by summed probability, then content order); direction from the note directions (mixed directions on a directed type give one relation per direction with its own majority); `importance` and `confidence` null (unknown stays unknown), `support_count` = supporting note relations, `origin = promoted`. Re-promotion recomputes from the current typed applied set, is idempotent, and is enqueued for both roots whenever a note relation is typed or changes type or direction; an owner-rejected source relation is never promoted again. **Merge with judged rows:** one row per (root pair, type); a judged verdict on the same key upgrades a promoted row to `origin = judged` with its scores (keeping `support_count`); promotion never downgrades a judged row and only refreshes its `support_count`; a judged automatic rejection does not block promotion, an owner rejection does. **Readers:** `SourceRelationViewSchema` takes nullable importance and confidence, `origin`, `supportCount` and the read type enum (write ∪ legacy); every importance sort is `nulls last` with `support_count desc` next; the UI says "linked through N note connections" for a relation without scores. (2) **Discover** the nearest root among roots already matched, with current notes, in the same embedding space, never same-root and not already linked, plus every earlier root whose stored nearest cosine the new root beats (reverse neighbours), on the stored `source-composite-centroid-v2` vector (recomputed for a hierarchy root when a chapter embeds); `discovery.neighbours` 1 *(cal.)*, 2 if S1's labelled nearest-versus-second-nearest check asks for it. (3) **Judge each unordered pair once** with `sources.decide` v5 on `op:source_relation_matching` (floors `recommended-v2` carry over; `contrasts` is written as `contradicts`; stored v5 `similar_to` acceptances are counted on fixture tuning at $0 and dropped as weak unless tuning recall needs them, Q14). The pair key keeps only what changes the judge (contract, prompt identity, judge model and parameters, both root fingerprints, the pair's note-relation fingerprints); raw items are stored. Deleted: `candidates()` with its trigram self-join, `rankSourceCandidates`, the 6-pair cap, the shortlist settings and coverage. `pairChunks` evidence selection is unchanged unless S1's SQL bar fails, including a synthetic pair of 500-chunk roots; then the note-relation chunks plus bounded exact vector pairs replace its lexical and concept cross joins. | Decision 17 and its spike: simulated 3.8-3.9 s per source, 27-28/28, 0/35. Plan 4.2's "≥2 accepted note pairs" and "source-centroid ANN plus a decider call" were stale. Promoted rows with null scores and new types would otherwise fail the Zod view schema, sort first under PostgreSQL's `NULLS FIRST` for `desc`, and win merges; an untyped relation has no type to group by and `source_relations.relation_type` is NOT NULL. A fixture-sized SQL bar never sees a book pair. |
| D28 | **Retrieval SQL on indexes.** `atomic_notes.search_tsv` generated stored (`'simple'` config over `f_unaccent` of title A, idea A and the first 4,000 body characters B) with GIN; trigram GIN on `f_unaccent(title)`; a partial HNSW per dimension table `WHERE target_type = 'atomic_note'`; the ANN query orders by the raw `e.embedding <=> $q` with `hnsw.iterative_scan = relaxed_order` and `ef_search` 100 set locally, then an exact re-sort outside; superseded, archived and rejected notes excluded. Every query has an EXPLAIN gate. Levers held for S1 or M0: `source_items.root_source_id` (pulled from F5) if S1's SQL p95 fails; SQL-only shared-entity candidates from `atomic_note_entity_links` if M0 shows the graph signal empty. | The text query scans per row and the ANN orders by a computed alias, so no index serves either; `rules/data.md`: indexes must be usable by their queries. |

### AI runtime

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D29 | **AiScheduler lanes.** A service-owned pure core (no module singleton) replaces `ai-execution-queue.ts`, whose 19 tested behaviours move to scheduler and service tests. One `local` lane of concurrency 1 for MLX, node-llama-cpp and OpenAI-compatible loopback endpoints; one `remote:<providerConfigId>` lane per remote configuration, starting at 4 for API keys and 2 for Codex OAuth *(cal.)*. AIMD: a 429, `Retry-After` or `resets_in_seconds` halves the limit (minimum 1) and pauses the lane until the reset; 20 consecutive successes add 1 up to the configured maximum. `MEMORA_AI_LANES=serial` (DEV; the default in golden and re-match runs) sets every lane to 1. Scripts keep the machine-wide local-model slot. | Plan 4.4; today one singleton FIFO serializes every call, remote included. |
| D30 | **Priorities.** P0 interactive (Ask, query embeddings, explanations and overviews on open, settings and model tests) is strict and first. P1 an interactive single import (payload `interactive: true`) and its link job; P2 ingestion, note decide, link jobs, note vectors, the topic gate; P3 topic naming, Areas, labels, the untyped re-typing sweep, reconcile. Aging: a P3 entry competes as P2 after 60 s of waiting and as P1 after a further 120 s, a P2 entry as P1 after 120 s *(cal.)*; nothing ages into P0; FIFO by admission within an effective priority; nothing preempts a running call. Interactive import jobs get `jobs.priority` 1 for claim order. | Keeps "interactive is admitted before background" while bounding background starvation. |
| D31 | **Deadlines on every runtime, from execution start.** Remote phases unchanged (connect 10 s, first byte 30 s, stall 20 s, answer start 30 s, totals per class). Local totals per class = min(cap, 3 × measured p99), caps *(cal.)*: embed 30 s per batch, decide 10 s per rank call, write-fast 180 s, write-quality 900 s, answer 300 s, plus a 60 s token stall for streamed local generation. Enforcement: cooperative `cancel` (MLX helper, GGUF abort signal); the MLX helper is killed if not settled 2 s later; a GGUF call that ignores abort settles at its deadline plus 2 s and marks the runtime `wedged`, and the local lane stays held until the runtime is disposed and reloaded. Retry backoff releases the lane (`permit.releaseDuring`) and a retried attempt keeps its admission age; a `Retry-After` longer than 5 s goes to the job. The backoff sleep counts toward the total deadline, but the time a retried attempt then spends **re-waiting for the lane is excluded**: the attempt's `ActiveDeadline` pauses until the lane is re-acquired, and the retry-skip check uses the paused clock. A second consecutive local deadline on the same input does not retry. `ai_task_runs` records lane, class, priority, deadline, outcome, repair flag, schema mode, retry wait and lane re-wait (`requeue_ms`). | X6 needs a countable "past deadline". Today GGUF has no deadline, MLX one 10-minute bound for every class, and retry sleeps hold the slot; one total timer across attempts would make a retried decide call spend its deadline queueing, against `rules/ai.md` ("a caller's timeout excludes its wait for a slot"). |
| D32 | **Circuit breaker per remote lane:** it opens after 5 consecutive transient failures *(cal.)* for 30 s; new entries fail fast with `errors.ai.providerUnavailable` (job-transient); one probe half-opens it; running calls are untouched; other lanes are unaffected. | An outage must not consume every entry's deadline in turn. |
| D33 | **A P0 call never spills to a remote lane in F3** (Q9). Plan 4.4's "a P0 may use an allowed remote lane when the local lane is busy" moves to F4/F5. | Not in the F3 box; it needs alternate routes and a privacy gate, conflicts with "never fall back silently", and no exit needs it. |
| D34 | **Workload classes on every caller.** Every `runDefaultTask`, `runOrganizationTask`, `rank`, `rankPairs` and embed caller states its class and priority (static test); the generative decider, its repair and the source judge state `decide` (D16). Route order stays `op:` → class → task. `mapLegacyRoutesV1` (idempotent, setting `ai.routes.classMap.v1`) writes the class routes, always writes D16's generative-decide `op:` routes from the `reranking` task route when it holds a generative model (unset otherwise, so such a call fails visibly instead of reaching the ranker), and, for each legacy task whose model differs from its class route, `op:` overrides for that task's operations, so every effective model stays the same (a dump before and after on a DEV clone); a set class route is never overwritten. The presets (table below) seed the routes, including those `op:` routes, and test one call per class; a failed test leaves the class `untested`, with no fallback. Settings › AI lists the five classes plus a **"Generative judge" row** (the model behind the generative-decide routes, the note decider mode, its test, and the remote-provider disclosure of `rules/security-privacy.md` when a remote model is chosen) (Q11). The first-run path only calls `mapLegacyRoutesV1`; F4 owns onboarding. | Plan F3 item; today only topic naming, Areas, overview and `rank()` state a class. `decide` holds rankers only, so without its own row the judge every preset uses would have no visible control. |
| D35 | **Schema output in every runtime.** Requests carry `outputSchema` (Zod 4 → JSON Schema) only for contracts that pass a strict-compatibility check (a table test lists every catalog contract): Codex `text.format` strict, OpenAI-compatible `json_schema` strict with a remembered `json_object` fallback on a 400 naming it, Gemini `responseJsonSchema`, GGUF a grammar, MLX one repair. **The schema stays out of the cassette key** and is stored in the entry body for audit; a replayed answer goes through its consumer's validation and repair exactly like a live one. Every structured consumer keeps valid items and re-asks only the missing ones once; the graph parser drops relations with unknown keys, self-loops or invalid predicates and keeps valid entities, re-asking only when nothing valid is left; identity steps parse tolerantly with their own error codes (except under the pin, D5). **Repair accounting:** a repair is a second model call for the same items after a validation failure (`is_repair`); a strict-schema refusal and its remembered fallback is a schema fallback, counted apart; salvaged items (dropped with no call) are counted apart; injected faults and transient retries are not repairs. | 41 of 46 failing local graph responses are valid JSON with only bad relations. A schema in the key would invalidate 1,406 / 1,614 / 397 recorded generative entries; validating replays in the cassette would reject the recorded invalid first attempts the pin must replay. |
| D36 | **Knowledge-graph batches by writer locality** *(cal.)*: remote write-quality routes 7,000 characters with 24/24 entity and relation caps, local routes 3,500 with 12/12 (Q8); golden and fixture measurement runs pin 3,500 (D5). Extraction stays once per source over its chunks (the rule; the plan's "on notes with chunk evidence" is corrected); claims stay stopped (a static test allows no product writer of `claims` or `claim_entity_links`; the `claims` row count is unchanged across M2). Only extraction and its repairs scale with the batch: of F1a's 230 golden graph calls, 101 + 2 are extraction, 43 extraction repairs, 78 entity identity (12 entities per call) and 6 relation-type resolution. X7 is therefore measured on X7-REF, not projected. If X7-REF exceeds 40, the next lever is identity batches of 24 entities on remote writers, adopted only if the merged-entity count on the same extraction stays within ±5% of the 12-entity run (Q8). | The graph is 230 of about 495 golden generative calls (1.17 per chunk); without this X7 projects to about 49.5 per chapter, with it to about 35-39, too close to the bar for a projection. |
| D37 | **`embedMany`.** Remote adapters send arrays; GGUF reuses one embedding context and embeds texts one after another (bit-identical vectors, so the space key is unchanged); the cassette serves and records `embedMany` as per-text entries under the single-call key; chunks skip re-embedding when content hash and space are unchanged. | Plan 4.4; keeps 3,109 / 1,432 / 4,524 recorded embedding entries valid. |
| D38 | **Hot-path caches** for routes, provider configurations, decrypted credentials and adapters, invalidated by a generation counter that every configuration, credential, OAuth and local-model writer bumps (a test enumerates the writers); admission pinning and the `modelChanged` recheck stay; the adapter registry is keyed by provider configuration id; telemetry is written after the lane is released. | About 8 SQL statements and a keychain decrypt per call run inside the slot today; `providerId:modelId` keys would race under concurrency. |
| D39 | **Residency.** The embedder and the ranker stay resident; the generative model unloads after `generativeIdleMs` (300 s *(cal.)*) on a timer, through a new MLX helper `unload {slot}` (fallback: kill on an old helper). The helper also gains `cancel {requestId}` (generation checks per token, scoring per batch, read concurrently with a running request) and `generate {stream: true}` delta lines, announced in `health.capabilities`; the rebuilt helper changes the MLX runtime build, so its first start re-validates the ranker and runs D13's parity check before decide is served again. A pure `residencyPlan(totalMemory, catalog)` keeps the group resident and admits the writer only if the catalog minimum plus headroom (4 GiB *(cal.)*) fits, otherwise the ranker unloads while generation runs; before a generative load a memory guard requires free plus inactive memory ≥ the catalog minimum + 1 GiB, else the call is `blocked: memory`, never swapping. | Plan F3 item (minimal residency landed in F2, Q11 there); today an idle poll up to 500 ms later kills the helper and all three models. |
| D40 | **No MLX embedding adapter in F3 (Q5).** The MLX Qwen3-Embedding-0.6B adapter, its catalog entry and the switch of the default move together to the phase that records an MLX-space E6 and re-calibrates the F2 topic placement in that space. The downloaded weights stay unused under `.cache/models/qwen3-embedding-0.6b-mlx`. **`STACK.md`'s planned-additions note** for those weights ("F0 spike, F3 adapter") is corrected to name that phase (T65 edits it); the weights stay a planned addition. | Decision 12 is binding: an MLX embedder shipped beside a GGUF default would contradict it by default, and with no MLX embedder in the product it holds. A default switch re-embeds every library and rebuilds the tree, the placement calibration (`docs/topic-placement-calibration.md`) was fitted in the GGUF space, and there is no measured speed gain (GGUF 105 notes/s equals MLX at batch 16). |
| D41 | **Topic tree non-regression.** The `{query, documents}` RankRequest stays byte-identical (80 / 46 / 370 recorded gate calls keep their keys); the topic gate runs at P2 and naming, Areas and labels at P3 on the light `model` worker; every gate checks the non-regression list (Measurement), including the F2 re-placements caused by the composite-vector recompute. Once F3 matching merges (T51, T52), F2-era replays cannot hold "0 misses", because matching sends new requests: non-regression replays then strip the matching entries from their cassette copy, keep the extraction pin, let misses run live only on local runtimes (counted) and switch relation remote calls off; their bar is **0 extraction misses and 0 remote misses** plus E6's own assertions, until T55k re-records E6 under F3 (`e2e-plos-f3`, $0, local writer) and replays it twice with 0 misses of any kind. | The F2 tree owns structure (decision 18); the `e2e-plos` and `golden-small-f2` cassettes hold F2-era matching requests. |

**Presets** (`packages/domain/src/ai-presets.ts`, pure; D34):

| Route | Local (macOS arm64 only) | Hybrid | Cloud |
| --- | --- | --- | --- |
| `class:embed` | GGUF Qwen3-Embedding-0.6B (the F2 space) | same | the provider's embedding model, else local |
| `class:decide` (validated rankers only) | MLX Qwen3-Reranker-0.6B (GGUF without MLX) | same | the installed ranker when validated (decision 19), else none |
| Generative-decide `op:` routes (D16) → `reranking` task route, always written | the local writer | the remote writer | the remote writer |
| `class:write-fast`, `class:write-quality`, `class:answer` | one local writer for all three: MLX Qwen3.5-9B 4-bit at ≥24 GiB, else Qwen3-4B-Instruct 4-bit | the user's remote profile (Codex OAuth or API key) | same |
| Note decider mode (D16) | `ranker` | `ranker` | `ranker-else-generative` |

One local writer serves every write class: two local generative models would alternate loads on every class change
(`rules/ai.md`: never two local generative models at once).

### Note page, migrations, data

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D42 | **Evidence card v2.** Band words in the UI ("Strong" for apply, "Possible" for suggest, "Not calibrated" for an uncalibrated decider, nothing for legacy rows); the probability stays in the contract for F4 Diagnostics and is never shown as a percentage (Q12); state (applied, suggested, withdrawn, kept); decider, typer and writer shown apart; Keep and Remove on suggested and withdrawn rows; order by probability (nulls last), then legacy score, other title, id; the reducer card stays (no `radix-ui`). The Library relation tab and the dashboard tooltip stop showing `final_score` as a percentage for v2 rows. | The `rules/frontend.md` hover-card rules are already met; a per-pair percentage reads as a precision we do not have. |
| D43 | **Ego-graph v1** on the Note page, read through **`objects.neighborhood` restricted to notes** (`objectTypes: ["note"]`, the plan 4.5 name, so F5 widens it instead of replacing it): notes only, depth 1 (depth 2 on a toggle), ≤40 nodes ranked by probability and depth, applied relations drawn (arrows only for directed types; symmetric and unknown undirected), suggestions listed but not drawn; canvas pieces extracted from the dashboard and `SourceConnectionGraph` into `renderer/components/graph/`; colours from `--graph-*` tokens through a reader returning `#rrggbb`; the relation list is the text alternative; no WebGL falls back to the list; `relationsChanged` push, no polling. | Plan F3 item and plan section 6; `rules/frontend.md` (focus graphs, disposal, tokens). |
| D44 | **Migrations and gate M.** Three migrations, one owner at a time, each taking the next free number when it generates, in this order: relations v2 (T48, expected 0056), AI audit columns `ai_task_run_lanes` (T47, expected 0057), retrieval indexes (T49, expected 0058). Before any real profile (the owner's DEV, ENV-F, ENV-G, ENV-C) starts with them, **the orchestrator runs gate M itself**, as it ran F2's gate W (Gates). F3 adds no fourth migration: the run states of D16 and D25 use existing columns, and a later migration re-opens gate M. | `rules/data.md`; the migrator applies every pending migration in one transaction, so index builds run inside the startup transaction; the DEV profile holds the golden library; agents may not start the owner's live PostgreSQL cluster. T48 is on the critical path and T47 is not. |
| D45 | **Proof slots** (F2 D35): one DEV-app holder and one local-model holder at a time; the soak holds both for 25 h. A DEV-app proof that loads a local model (the app's own MLX helper or in-process GGUF) holds **both**, because the app never waits on the machine-wide slot. The script slot (`scripts/spikes/topic-tree/local-model-slot.ts`) also matches `scripts/relations/` scorers, since a script running GGUF in-process shows no `node-llama-cpp` on its command line. | One Memora instance and one local inference at a time; the slot is a process scan. |
| D46 | **Typed configuration.** New numbers live in `packages/domain/src/relations-config.ts` (retrieval, decide, calibration, bands, typing, link, cap, discovery, escalation) and `packages/ai/src/runtime-config.ts` (lanes, aging, local deadlines, breaker, residency), each with a Zod schema and tests; the dead note-matching preset fields leave the settings through a settings migration (T53b). | `RULES.md` section 1 and decision 5. |
| D47 | **Existing data stays.** The DEV profile's 111 v9 note relations read with a backfilled direction or `unknown`, no band, as applied; its one source relation becomes `origin = judged`; nothing is re-matched or re-typed in F3 (Q13). | No silent rewrite of history; F4 offers re-matching with undo. |
| D48 | **Automatic relations carry no direction (plan decision 31b; T53d, migration 0059).** The typer's direction stays in `direction` for audit, and `direction_source` (`typer`, `decider`, `owner`; null on legacy and symmetric relations) says where it came from. Only `owner` and `decider` directions are shown, drawn, stated, promoted or exported; `noteRelationDirectionSql` / `noteRelationSubjectSql` of the visibility module are the one reading, and a static test bans any other. **Owner:** Keep may carry a direction (this note, the other, or none): `owner`, with `symmetric` on a directed type meaning none, written with the `kept` event; default none; I-R2/I-R3 unchanged. **Decider:** the Decisions decider names the higher-scoring Document as the subject when its two directional scores differ by at least `decisions.directionMarginLogOdds` (1.0 log-odds, typed; 0.78 accurate on the fit panel); the local rankers name none. Source relations promote a direction only from directed note relations; a directed type none of whose notes has one is one relation that reads both ways (derived `directed` flag, never stored: the relation reads from its source only when a note relation's subject is its evidence's source note). The undirected notes of the winning type still count as support and confirm the relation; a relation that reads both ways turns in place (same row, status and page, one revertible `promoted` event) when a direction arrives against its stored order. Existing banded directed relations become `typer`; legacy rows are unchanged. | The typer reads direction from note position (0.57 against the 0.85 bar, `.cache/f3/freeze/direction-analysis.md`); the Decisions asymmetry carries a direction (0.78 at margin 1), the local rankers' does not. | A stored `unknown` on banded rows (D8 keeps it legacy-only); direction kept in `metadata`; a direction column on source relations; a second typing call per pair (40% coverage, 0.76). | 31b |

## Readings and corrections of the plan

- **Decision 3 (Q18):** bge-reranker-v2-m3 is retired as the second fallback decider (Spike A NO-GO for matching;
  out of the catalog since F2). F3 measures it only as a bake-off control and revisits it only if it passes where
  both Qwen3 runtimes fail.
- **Decision 12 (D40, Q5):** no MLX embedder ships in F3; `STACK.md`'s "F3 adapter" note is corrected by T65.
- **Decision 17 (D23, Q15):** source relations are promoted from typed applied note relations only.
- **Plan 4.2 step 2 and "Source relations by aggregation"** are corrected to D17 and D27; **4.4** "a P0 may use an
  allowed remote lane" is marked F4/F5 (D33) and "graph extraction once" is worded as the rule (D36); the F3 box's
  "~300 owner-labeled pairs (1.5-2.5 h)" is replaced by the panel (D4, Q10).
- **Spending (D26):** the daily call cap is the interim control on priced routes; `rules/security-privacy.md`'s
  monthly-cap sentence is tagged *(target F4)* by T65. `RULES.md`'s "(target F2-F4)" change-set tag stays: F3 writes
  the relation events, F4 builds the change-set undo on them.
- **Run states (D16, D25):** "relations wait for the ranker" and "graph incomplete" are `succeeded` runs with a
  skipped or failed stage row and a derived status, re-run by the stage-level retry; no enum migration.
- **Held-out (D3, Q20):** the fixture held-out stays X1's gate, recorded as pre-read; the eval split is the clean check.

**Not built in F3:** a P0 spill to a remote lane (F4/F5, Q9); OpenAI Decisions as a product adapter (Q6); explanation
backfill (plan 4.2 step 5, 4.3 REFRESH; the rule forbids background explanations, so F4 REFRESH edits it); undo UI,
Inbox, the MATCH job and re-matching on note edit or model change (F4, on D14's events); re-typing legacy rows and
re-matching the DEV library (F4 backlog with undo); `search_tsv` on chunks, per-row `ts_config`, `root_source_id` and
omni search (F5; `root_source_id` is a lever, D28); dashboard token colours and global graph scoping (F6); streaming
and veto for source-relation explanations (later); constrained decoding inside the MLX helper (plan 4.4: MLX keeps
one repair); the ranker as the source discovery judge (untested on inputs 5-7× longer; the bake-off reports its
offline AUC on the 40 source pairs only); the claims read-side remnants (F4 legacy drop); the MLX embedding adapter
(D40).

## Owner questions and defaults

All answered on 2026-10-17 with the default (Owner approval).

| # | Question | Default (answered) |
| --- | --- | --- |
| Q1 | X2 gates on the loss among the R_v6 and R_v9 pairs the panel rates related, with the literal loss over all of them reported beside it; for R_v9 every lost pair is labelled and the kept pairs' related share comes from a 50-pair sample (all pairs labelled when 5% falls inside the interval). | **Yes.** Spike A notes the old verdicts are agreement, not truth. |
| Q2 | X3 "local" means the local decider with the preset's writer: the Hybrid preset gates at 4 min (MLX) and 8 min (GGUF), and the all-local preset is reported against 8 min. | **Yes.** |
| Q3 | About 945 live Codex calls and 1.3M tokens for F3 measurement, plus a 0.4M reserve (0.15M before M2, 0.25M held for M2), recorded to cassettes, capped at 1.7M with the Budget's drop order. | **Yes**; the line stops and asks before M2 if earlier work crosses its share. |
| Q4 | Run the 24 h soak with the Local preset plus fault-injecting fake remote providers (no quota), with no live Codex leg. | **Yes.** |
| Q5 | Move the MLX embedding adapter out of F3, to the phase that records an MLX-space E6, re-calibrates topic placement in that space and switches the default in one change (D40). | **Yes**; saves 1 agent-day and a slot. |
| Q6 | OpenAI Decisions only in the bake-off, through the spike client, on synthetic fixture text; no product adapter in F3 (D6). | **Yes**; a product tiebreaker needs a product key, a budget and the disclosure, and only if the bake-off shows it alone closes X2. |
| Q7 | Accept that design E keeps about 2-5 of today's 16-29 held-out bridges. | **Accept** (decision 17). |
| Q8 | Remote writers extract the graph in 7,000-character batches when X7-REF keeps entity yield ≥90%; if X7 still exceeds 40, identity is batched 24 entities at a time on remote writers when the merged-entity count stays within ±5% (D36). | **Yes**; otherwise remote batches stay 3,500 and the *(cal.)* X7 target is re-based with the owner. |
| Q9 | Defer letting interactive work use a remote lane when the local lane is busy (D33). | **Yes**, to F4/F5. |
| Q10 | Labels only from public and synthetic text (fixture, golden-small, corpus) by the three-judge panel of decision 21, replacing the owner-labelled pairs; the same labels fit and evaluate the calibration; an optional spot-check of 20 pages is offered (D4). | **Yes**; no owner time. |
| Q11 | Settings › AI lists the five workload classes instead of the seven legacy tasks, plus the "Generative judge" row (D34). | **Yes.** |
| Q12 | Show a relation's confidence as band words ("Strong", "Possible") and keep the percentage out of normal UI (D42). | **Yes.** |
| Q13 | Leave the DEV library's 111 v9 note relations as they are in F3, with re-matching offered later by F4 with undo (D47). | **Yes.** |
| Q14 | Stored v5 `similar_to` source verdicts: counted on fixture tuning at $0 before T53, then dropped as weak unless tuning recall needs them. | **Drop as weak** unless tuning recall needs them. |
| Q15 | X1 and X2 count every relation the decider accepts (applied and suggested), with applied-only reported; source relations are promoted from applied relations only (D23). | **Yes.** |
| Q16 | Cap background remote relation calls at 500 per day until F4's money cap, with promotion of typed relations and local deciding continuing at the cap; P1 calls counted but not capped; on priced routes the cap is the interim control (D26). | **Yes**, start 500 *(cal.)*. |
| Q17 | With the Local or Hybrid preset and no validated ranker, note matching is skipped and the run completes; it runs once the ranker validates; Cloud uses the generative decider when no ranker exists; a profile with no preset keeps its pre-F3 generative decider until a ranker validates (D16). | **Yes.** |
| Q18 | Record that bge-reranker-v2-m3 is retired as decision 3's second fallback, kept only as a bake-off control. | **Yes.** |
| Q19 | Allow the Claude usage of the Budget, reported at every wave close, with a pause at the next wave boundary whenever the owner says credits are short. | **Yes.** |
| Q20 | Keep the fixture held-out as X1's gate although it is pre-read, with the panel's eval split reported beside X1 as the clean check (D3). | **Yes**; the plan's exit names the fixture. |

## Gates

| Gate | When | Passes if | If it fails |
| --- | --- | --- | --- |
| **0. Measure first** | End of wave 1 (T44, T46a, T43b), about day 5 | Through `--pre-freeze-feasibility` (aggregates only): the reachable count is ≥27 of the 28 expected held-out root pairs, and the MLX count at Spike A's rule is ≥27/28 and 0/35. Outside that mode: tuning candidate recall reaches every expected tuning root pair but at most one; the upper end of the X7 projection with D36 is ≤40; the throughput forecast is ≤3.2 min (MLX) and ≤6.4 min (GGUF) on all three shapes (Gate-0 throughput rule); the backup map is done or its fallback recorded. | Tuning recall short: T51 takes the retrieval change the **tuning** diagnosis names (k, guard, text terms, D28's entity lever) before M1. Held-out aggregates short with tuning recall complete: **no design change**; recorded as the bridge-note risk of the pinned extraction and asked as an owner question on the bar before more build cost. X7 short: T55 sizes the batches from the measured split and D36's identity lever is prepared. Throughput short: the levers in order, recorded under Gate 0 outcome before wave 3. |
| **M. Migration safety** | T48m, by the orchestrator, before any real profile starts with the F3 migrations (about day 5.25) | The DEV-clone rehearsal passes `npm run db:relations:verify` (equal source-relation counts); the pre-migration backup restores; the migration times on the DEV clone and on an ENV-C restore are recorded (ENV-C ≤120 s, or a follow-up is scheduled); no fourth migration exists. | Fix the migration; nothing has changed on a real profile. |
| **R. Slice works** (tuning only) | After T57 (M1), T53's proof and the T55/T56 replay proofs, about day 11.25 | Provisional settings: fixture tuning note layer ≥24/26 *(cal.)* and 0/25 forbidden at the accept band; tuning candidate recall ≥25/26; T53's tuning source layer ≥25/26 and 0/25, ≤6 s and ≤2.5 calls per source; the throughput forecast with measured K_eff, d and t_type ≤3.6 min on every shape; X4 and X5 cases a-c, e, f pass; T55's full replays had 0 misses, and the non-regression replays of `golden-small-f2` and `e2e-plos` (T56 and this gate) have 0 extraction misses, 0 remote misses and E6 PASSED; the non-regression list is green. | Fix inside wave 3 before the freeze, reading tuning only; nothing is frozen on a broken slice. |
| **F. Freeze** | T58, about day 12.75 | T61's parity check passed (or M1 was re-scored on its build); `frozen.json` was written before any held-out read; the offline X1 forecast on the fixture held-out lists is ≥27/28 at 0/35 (optimistic typing; the pessimistic bound reported); the X2 forecast is ≤5% on R_v6 and R_v9; typer direction accuracy ≥85% and swap consistency ≥90% *(cal.)*. | The escalation lever by the pre-registered rule (T58e); MLX fails and another local decider passes → owner question; otherwise iterate on the fit labels and tuning only and re-freeze with a new hash, reported beside the first. |
| **P. Pre-soak** | End of wave 3 (T62), after T61 and T55k, about day 13 | 4 h on `env-soak` with the final cancel, unload, local deadlines and graph handling: 0 past deadline (paused clock), repairs ≤2%, 0 stuck jobs, no swap growth; every injected fault kind ends with its expected `deadline_outcome` and error class, and Codex-wire calls ran through the Codex adapter; `e2e-plos-f3` replays with 0 misses. | Fix before T64; the soak never starts on a failing pre-soak. |
| **X. Exit** | After T63 (M2) and T64r | X1-X7 and S1 (Measurement), X1 with the calibration-identity assertion and X7 measured on X7-REF; every F3 box ticked; the non-regression list green. Closes F3. | Stop the line; any KPI regression stops it (plan section 8). |

**Gate M runbook (T48m, the orchestrator).** (1) Stop DEV. (2) Take a restore-verified backup of the owner's DEV
profile (`npm run db:restore` into a scratch cluster with matching key-table counts) and a cold copy of its
`database/` directory (the rollback). (3) APFS cold copies `env-{f,g,c}-pre-f3`. (4) Rehearse on an APFS clone of the
DEV profile: start it with the merged code, run `npm run db:relations:verify`, record the migration time, then restore
the pre-migration backup into a scratch cluster to prove the rollback. (5) Measure the migration time on an ENV-C
restore. (6) Confirm the schema adds no migration beyond D44's three. (7) Only then may a real profile start with the F3
migrations. Rollback: stop DEV and swap the cold copy back (F2 gate W). Before the migration, T43b exports ENV-F's
pre-F3 note relations (R_v9) to `.cache/f3/labels/r-v9/`; the record goes to `.cache/f3/gate-m.md`.

### Gate 0 outcome

Recorded at gate 0 (2026-10-17; T43b, T44 `docs/spikes/f3-m0.md`, T46a scores in `.cache/f3/scores/`).

| Check | Result | Bar | Verdict |
| --- | --- | --- | --- |
| Held-out reachable at k = 20 (`--pre-freeze-feasibility`) | 28/28 | ≥27/28 | pass |
| Held-out at Spike A's rule, MLX max ≥3.3125 (GGUF max ≥3.16) | 25/28, 0/35 (GGUF 24/28, 0/35) | ≥27/28, 0/35 | short |
| Tuning candidate recall | 26/26 | all but one | pass |
| X7 projection with D36 (upper end) | 37.1 per chapter (X7-REF 33.9) | ≤40 | pass |
| Throughput forecast, K = 20 / K = 10 (lever 4) | MLX 4.2-5.6 / 2.0-3.0 min; GGUF 7.9 / 4.5 min | ≤3.2 (MLX), ≤6.4 (GGUF) | short / pass |
| Backup map (T43b) | V9-A and V9-B restored, counts equal | done | pass |

- **B1:** MLX 27.4 ms per pair at 32 pairs per call with helper batch 16 (876 ms per call, inside the 1.0 s P0 cap);
  GGUF 44.5 ms at 16 pairs per call (712 ms). `rankPairsPerCall` = **32 (MLX) / 16 (GGUF)**, helper batch 16 (T50's
  `rankPairsLimits`).
- **B4 (arrival vs batch):** arrival mode needs the D19 guard (5.4-11.5 completions per note); the refreshed-kth idea
  is left to T51 as a design question.
- **Throughput levers applied, in order:** lever 1 (B1 above), then lever 4 (K = 10 candidates per note, D17's
  recall-lossless limits; tuning reach stays 26/26 down to K = 8). T51 implements K = 10 with the rules/knowledge.md
  edit.
- **Held-out short with tuning recall complete:** no design change (D3). The owner was asked about the bar against
  this extraction (2026-10-17) and answered: **keep X1 at ≥27/28** and use the levers — T58's per-decider calibration
  on the panel labels and, if still short, **T58e's uncertain-band escalation becomes planned** (no longer
  conditional). If gate F's forecast is still short, the orchestrator returns to the owner with the measured value.
- **Reverse-only, literal (X2 gates on the adjudicated loss):** R_v9 MLX 23/137, GGUF 27/137; R_v6 12/37.
- **E6 non-regression:** the `e2e-plos` replay now misses 5 generative note-matching requests after T48/T49 (retrieval
  changed); per R3 the F2 replays are held to 0 *extraction* misses and E6 is re-recorded under F3 by T55k.

### Calibration outcome (owner, 2026-10-18; plan decision 29)

T58 applied D18 to the panel fit labels and M1's tuning scores: no p_apply qualified (the top 18 fit labels were all
positive but Kish n_eff was 11.3; independently verified). The owner chose a pre-registered label top-up (80 pool B/C
pairs in the high strata, `.cache/f3/labels/topup-2026-10-18.md`; three blind Opus judges, kappa 0.895, consistency
10/10) with the rule unchanged. With 241 fit labels (R_v9 pairs removed from every pool, as 5.2 requires) D18 finds
neither an apply nor a suggest band: best cross-validated weighted precision 0.739 (pool A 0.94, B 0.83, C about 0.5).
The v9 generative decide on Codex is no better (0.68), nor a ranker filter plus v9, nor cross-root pairs only, nor a
suggest bar of 0.75 (0.70 keeps about 10% of the positives).

The owner decided (plan decision 29), amending D18 and D23:
- **No apply band in F3.** Every automatic relation is a suggestion; the owner's Keep and Remove make it final.
- **The decide threshold is chosen on the fixture tuning partition**: the edge that finds the most expected tuning root
  pairs at 0 forbidden (ties: the higher edge), on the rule, instruction, template and aggregation the panel selection
  picked; frozen with T61's parity like any calibration (D3); X1 and X2 stay as written (they count the accept band).
- **Panel precision, ECE and Brier are reported per decider, not gating.** F6 recalibrates from the owner's Keep and
  Remove on real use.
- **D23:** typed suggestions promote to *suggested* source relations (a promoted source relation is a suggestion until
  the owner keeps it); the graph and the ego-graph draw suggestions distinctly.
- **Typer experiment:** a `relations.type` revision carrying the panel's strict "related" criterion is measured on the
  labelled pairs of the band (live Codex, about 60-100k tokens); if typed suggestions reach weighted precision 0.80
  with 0 forbidden, they form a "confirmed" tier shown above plain suggestions.

### Gate outcomes decided by the owner (2026-10-18; plan decision 31)

- Gate F, local deciders (freeze 745469e5): X1 27/28 at 0/35 met; X2 R_v6 0.200 and R_v9 0.095 not met (recorded,
  revisited by F6); typer direction 0.567 / swap 0.417 not met: automatic relations carry no direction.
- Gate F, Decisions decider (frozen from the product's own requests, ae14630a): X1 28/28 at 0/35; X2 R_v9 0.022-0.029
  met, R_v6 0.114 not met (recorded); its apply band (CV precision 1.000, Wilson 0.890 at the pre-registered seed,
  present at 19 of 40 other seeds) applies automatically by the owner's choice.
- Gate P (pre-soak presoak4-20261018T0931, 2.7 h, every injected fault ran): deadlines, stuck jobs, swap, P0 wait,
  breaker, helper restarts and remote deadlines met; the repair bar sets aside the local writer's structured calls
  (8-19% invalid output; JSON-constrained decoding moves to F4).

### Gate P passed (2026-10-18, second pre-soak presoak4-20261018T1530, 4 h, with T53d, T62f and the Ask repair audit)

Every bar met: 0 calls past deadline (1,803 calls), repairs 0 of 15 counted (the local writer's 251 structured calls set
aside by decision 31a: 38 repairs, 15.1%, information), 0 jobs past twice their class deadline, 0 stuck over 1 h, 0
blocked, 0 MB swap growth, P0 wait within bound, breaker opened and closed on the outage, remote first-byte 7/7 and stall
8/8 deadlines, every injected fault kind on both fakes ended as expected (malformed Ask now audited as a repair). Two
REVIEW rows explained: 2 helper restarts for 3 injected kills (the last kill came near the end; the helper was not needed
again), and 9 non-injected failed knowledge-graph jobs, all invalid structured output of the local writer (entity
identity 7, relation types 2, nothing valid 1): decision 31a's known limitation; matching continued (T55k). The app quit
by itself after the run (bounded shutdown). `e2e-plos-f3` replayed with 0 misses, E6 PASSED.

### M2 budget (owner, 2026-10-18)

The Codex cap for F3 rises from 1.7M to 2.5M tokens (decision 29's wide suggest band multiplies typing: M2's gating
runs alone need about 1.29M against 1.25M left); the Decisions API may spend up to US$ 2.00 in M2 on synthetic fixture
text (F3 total about US$ 2.80). X1 has zero margin on the local decider (27/28 in all 200 simulated orders): one typer
veto on a single-support pair fails it; reported as a known risk before M2.

On 2026-10-19 the owner raised the Codex cap to 2.9M tokens: DS0 ran while the OpenAI account had no credit (the
decider fell back to the MLX ranker, so the sample measured MLX and its Codex tokens were spent), and DS0 and DS1 are
run again once the account has credit. Later the same night S1's fallback (two discovery neighbours) required S1 and X3
to be measured again (about 600k tokens), so the owner dropped DS0, DS1 and TPCG to stay within 2.9M: the Decisions
decider keeps gate F's validation and the GGUF throughput keeps its offline forecast (5.2 min for 200 notes, bar 8.0).

### X7 at M2 (owner, 2026-10-18)

X7-REF at D36's remote batches (7,000 characters, 24/24 caps): 30.5 generative calls per chapter (bar 40; the dedicated
ranker's `relation_decide` calls excluded) but 2.197 distinct entities per chunk against F1a's 2.576, 85.3% (bar 90%; the
loss is mostly "The Tell-Tale Heart", 29 to 13). By Q8 remote writers keep F1a's 3,500 characters with 12/12 caps, and
X7-REF is measured again at that batch; the owner chose that path over a second 7,000 run or a lower yield bar.
At 3,500 with 12/12 caps X7-REF kept 105% of F1a's yield (2.712 per chunk) at 45.0 generative calls per chapter
(extraction 33, identity 26). D36's identity lever (24 entities per call) cannot help there: each identity call
already covers one extraction batch of at most 12 entities. By Q8 the owner re-based X7 for F3 to ≤45 per chapter,
quality first, and moved the call reduction to F4 (identity grouped across a source's batches, bar back to ≤40).

### S1 second library at M2 (2026-10-19)

Over the 27 panel-positive pairs of the second library's labelled nearest and second-nearest pairs (GOLD and CORP
roots, v5 verdicts from SPG and SPC), one-neighbour discovery accepts 6 (recall 0.222) and two-neighbour discovery 13
(0.481): 6 is below 13 - 1, so by the pre-registered rule `discovery.neighbours` becomes 2 and S1 is measured again
(time, quality and the order replay on fresh S0 and S1 samples).

## Measurement

### Exit criteria

- **X1. Note layer ≥27/28 on pinned notes (mean of several samples), 0/35 forbidden** (T63).
  - Runs: re-match on ENV-F clones with the frozen configuration, Hybrid (local embedding, MLX ranker, Codex typer
    and judge), serial lanes, link pool 1. S0: manifest order within partitions, tuning first, on a fresh stripped
    copy of `matching-fixture-f2` (typing and judge live). S1: order 20261031, its own fresh stripped copy. S2: order
    20261032, a copy of S0's cassette with every `relations.type` entry removed (typing live and independent). B1:
    S0's order with helper batch size 1, from a copy of S0's cassette with every rank entry stripped (typing and
    judge served where identical).
  - Metric: held-out root pairs linked by ≥1 shown relation (D23), same-root relations ignored, endpoints per D9.
  - Pass: the mean over S0, S1, S2 and B1 ≥27.0 of 28; no sample below 26; 0 of 35 forbidden held-out root pairs
    linked in every sample; the runtime calibration identity equals `frozen.json`'s and the parity check passed on
    the M2 build (otherwise the run is void, not failed: M2 stops and the orchestrator reports).
  - Reported: per-sample values and the minimum; applied-only counts; tuning per sample (0/25 forbidden expected);
    candidate recall; the offline 200-order distribution with optimistic and pessimistic typing bounds (pairs with
    no live typing verdict counted not vetoed and vetoed); one GGUF sample on `env-f-gguf`; the generative fallback's
    note layer from M0's re-scores, labelled a lower bound (stored v9 scores exist only for feasible candidates);
    the clean check on the panel's eval split (weighted precision at p_apply and p_suggest, weighted recall of
    panel-positive pairs in the accept band); the frozen config hash; live tokens.
- **X2. ≤5% loss of today's reverse-only acceptances** (T58 forecast after the freeze; T63 confirms).
  - R_v6: the 37 pairs scored in product shape (frozen instruction, template, rule and bands; product-adapter parity
    with the spike scorer ≤1e-3 log-odds at equal batches); lost = not in the accept band.
  - R_v9: read from X1 S0; a v9-accepted pair is kept when S0's accept band contains it; a pair that never reached the
    F3 decider counts as lost.
  - Loss = lost ∩ panel-related / panel-related, per set; same-root pairs included and reported apart. For R_v9 the
    numerator is exact (every lost pair is labelled) and the denominator is lost-related + kept × the related share
    of the 50-pair sample, with its 95% Wilson interval; when 5% lies inside the interval, the remaining kept pairs
    are labelled (at most about 87 pages) and the exact figure gates.
  - Pass (Q1): ≤5% on R_v6 and on R_v9, literal loss reported beside each. If it fails at the freeze, the escalation
    lever is evaluated by the selection rule; if still above 5%, owner question.
- **X3. 200 notes end to end ≤4 min (MLX) / ≤8 min (GGUF)** (T63, Q2).
  - Clock: T0 = admission of the first released root's first `rankPairs` call; T1 = commit of the run's last
    relation, typing, veto or source relation (all link jobs drained); W = (T1 − T0) × 200 / notes released, raw value
    reported too. Notes are already extracted and embedded; nothing else runs on the owner's Mac.
  - Runs (re-match, back-to-back release, Hybrid, `MEMORA_AI_LANES=product`, link pool 2, coalescing on): **TP-G**
    (ENV-G clone, manifest order, 160 notes; recorded timing from the GOLD M2 run, typing misses live once) ≤4.0 min
    in two runs; **TP-F** (ENV-F clone, S0 order, 138 notes; recorded timing from X1 S0) ≤4.0 min in two runs;
    **TP-C200** (ENV-C clone, whole articles drawn by seed 20261050 until ≥200 notes, released one at a time against
    the 17.7k-note library, the other roots carrying `source_match_state`) run 1 live and run 2 in recorded timing
    within 10% of run 1, both ≤4.0 min; **TP-C200-GGUF** (`env-c-gguf`) ≤8.0 min; **TP-Local** (TP-G with the Local
    preset) reported against 8.0 min.
  - P0 probe during TP-C200 and TP-C200-GGUF: one query embedding every 10 s; queue wait p95 ≤1.0 s on each runtime.
  - Reported: decide and link time apart; candidates per note; measured d; calls per source; the per-source lag from
    a source's notes embedded to its relations committed, p50 and p95.
- **X4. 0 prose tokens for rejected candidates** (every M1 and M2 run): the ranker result, the `relations.type` schema
  and the v9 decide schema hold no free-text field (contract test); `relations.explain` calls equal explicit opens (0
  in headless runs); every typed pair was in the accept band at call time. All three in every run.
- **X5. A failing source does not delay its siblings** (T52 cases a-c, e, f; T55k case d; T63 confirms).
  `phase4:e2e` on scratch PostgreSQL with fakes, 5 sources in one batch, faults on source 2: (a) a deterministic
  ranker error; (b) a helper kill during its rank call; (c) a remote 500 storm on its typing and discovery; (d) a
  graph-stage failure (its matching still runs); (e) a transient failure re-queued (siblings finish linking before
  its retry); (f) a link-job failure. Pass: each sibling's link completion ≤ control + one bounded call (local ≤1.1
  s, remote ≤ the class p95); the failing source ends `failed` or `quarantined` with the right error class and stays
  retryable; in (d) matching ran. In-app, the X1 S0 timeline shows each root's link job committing while later roots
  decide.
- **X6. 24 h soak, 0 calls past deadline, repairs ≤2%** (T62 harness, T64 run by the orchestrator, T64r report).
  - Profile `env-soak` (`cp -cR` of ENV-G after gate M) with the Local preset: one local writer (MLX Qwen3.5-9B
    4-bit), the MLX ranker and the GGUF embedder. Remote side (Q4): two DEV fake providers on loopback
    (`MEMORA_FAKE_REMOTE=<scenario.json>`, refused when packaged or with another DEV knob) whose configurations carry
    `treatAsRemote: true`, honoured only under that knob in an unpackaged build and read by both lane classification
    and the adapters' deadline mode, so the fakes run under remote deadlines: an OpenAI-compatible fake for Ask and a
    Codex-wire fake (Responses SSE behind a DEV OAuth stub with a fixed dummy token) for explanations, with templated
    valid answers (`NOT_RELATED` at a seeded 2%) and latencies fitted from recorded Codex durations.
  - Driver (`MEMORA_SOAK=<plan.json>`, seed 20261021): an article import every 20 min; an Ask question every 10 min;
    an explanation open every 5 min plus a burst of 10 every hour; a human note edit every 2 h; a source deletion and
    re-import every 6 h; a source whose typing fails deterministically every 4 h. Seeded faults: 429 with
    `Retry-After` 1-10 s (5%), 503 (2%), a 25 s mid-stream stall (1%), first byte at 35 s (1%), a malformed answer
    (0.5%, marked injected), a 15 min outage of the Codex-wire fake at hour 6, ×10 latency on the OpenAI-compatible
    fake for 5 min at hour 12; an MLX helper SIGKILL every 3 h ± 30 min; a forced GGUF abort during an embedding batch
    every 6 h.
  - Pass: 0 calls past deadline (`duration_ms − requeue_ms > deadline_ms + 2,000`, or the watchdog on its paused
    clock); repairs (D35) ≤2% of non-injected structured generative calls, per class reported and the local writer's
    graph apart; 0 jobs running past twice their class deadline and 0 stuck over 1 h; 0 jobs blocked by an unrelated
    job; pageouts ≤50 MB over 24 h after warm-up; P0 wait ≤ one in-flight bounded call; the breaker opens during the
    outage and closes within 1 min after it; helper restarts equal the injected kills; every non-injected failure
    classified correctly (audited sample of 50) and every `wedged` event explained; the injected 35 s first byte ends
    `aborted` at the 30 s bound, the 25 s stall at the 20 s bound, Codex-wire calls ran through the Codex adapter
    (count > 0), and totals are the remote ones.
  - If only the local writer's graph repairs exceed 2%, the orchestrator reports the split and asks the owner before
    changing the soak writer; the line stops until answered. Answered by plan decision 31a: the report sets aside
    every structured call of the local MLX writer (lane local, runtime `mlx`, no enforced schema mode), reported
    apart as information; F4's constrained decoding ends the set-aside.
- **X7. ≤40 generative calls per reference chapter *(cal.)*** (T63; measured, not projected).
  - Run: X7-REF (below) imported through the real ingestion path on a fresh `env-x7` profile with the Hybrid preset at
    product settings: no pin (7,000-character remote graph batches with 24/24 caps, salvage and item-level repair on,
    identity batches of 12), every generative stage live into the fresh cassette `golden-x7-f3`, matching and source
    relations live (ranker local; typing and judge on Codex), `MEMORA_GOLDEN_TOPICS=deterministic`, serial lanes,
    link pool 1. About 75 calls and 150k tokens.
  - Count = generative calls × 30 / 66 (X7-REF's chunks), by operation from `ai_task_runs`: summaries, atomic notes,
    graph extraction, extraction repairs, entity identity, relation-type resolution, typing, the source judge, any
    escalation. Embedding and dedicated-ranker calls are excluded; topic calls are reported apart.
  - Yield: entities per chunk on X7-REF ≥90% of F1a's on the same sources (from F1a's recorded entries, $0).
  - Pass: ≤40 per chapter on X7-REF with the yield bar met. Reported beside it: the whole-library figure composed from
    X7-REF's per-operation rates and the GOLD M2 run's typing and discovery counts. A result of 36 or more takes D7's
    same-day second run. Above 40, D36's identity lever is applied and X7-REF is re-run once; still above 40, or the
    yield fails, the target is re-based with the owner (Q8), and remote batches stay 3,500 if the yield failed.
- **S1. Source matching by design E: ≤5 s per source** (T53 proof on tuning; T63 gates).

| Check | Data | Pass |
| --- | --- | --- |
| Time | X1 S0 and S1 (live judge), GOLD M2; a synthetic pair of 500-chunk roots (SQL only) | ≤5.0 AI-call seconds and ≤2 calls per source on each; 0 replayed source calls in S0 and S1; SQL p95 ≤300 ms per source, including `pairChunks` on the book pair (else D27's fallback); wall per source reported |
| Quality | S0 and S1 | source layer held-out ≥27/28 and 0/35; tuning 25-26/26 and 0/25; either layer ≥27/28; held-out bridges reported (soft ceiling 8) |
| Golden pairs | GOLD M2 | the 3 note-linked pairs linked |
| Spike pairs | `scripts/golden/source-pairs/spike-f3-*.json` | 0 of the spike's never-judged forbidden pairs accepted |
| Order replay | `source-order-replay.ts`, 2,000 seeded orders over recorded verdicts (pairs no sample judged are judged once live, about 60-80 calls) | 0 forbidden in every order; ≥27/28 in ≥95% of orders |
| Second library | the labelled nearest and second-nearest pairs of the 10 GOLD roots and 20 CORP roots, with v5 verdicts for both | over the union U of their panel-positive pairs, the pairs one-neighbour discovery accepts number at least those two-neighbour discovery accepts minus 1; otherwise `discovery.neighbours = 2` and S1 is re-measured; both counts and their recall over U reported |
| Isolation | X5 | a root's link job starts without waiting for siblings |

### Datasets and profiles

The profiles live under `.cache/profiles/` with the MLX Qwen3-Reranker-0.6B installed and validated for `decide`;
the GGUF ranker is installed into `env-c-gguf` and `env-f-gguf` clones.

| Name | Content | Where | Used for |
| --- | --- | --- | --- |
| FIX | Matching fixture: 60 roots, 82 records, 138 pinned notes; 40 tuning and 20 held-out roots; 54 expected (26 tuning, 28 held-out) and 60 forbidden (25, 35) root pairs | `.cache/golden/matching-fixture/manifest.json`; `env-f`; cassette `matching-fixture-f2` | X1, X2 (R_v9), X4, X5, S1, M0, TP-F, pool A |
| GOLD | golden-small: 10 roots, 197 chunks, 160 notes | `scripts/golden/manifest.json`; `env-g`; `golden-small-f2` | X7, S1, TP-G, explanations, pool B, soak base |
| CORP | 17,735 notes from 760 Wikipedia pt/en articles, GGUF space | `env-c`; `corpus-f2` | pool C, TP-C200, EXPLAIN and retrieval at scale, second labelled library |
| SEED30K | seeded 30,000-note library, 187,274 relations, hubs of 400 | `scripts/objects/synthetic-library.ts` | EXPLAIN, `notes.page`, `objects.neighborhood`, migration timing |
| LBL | about 300 note pairs and the source pairs (D4) | `scripts/fixtures/f3-relation-labels.json`, `.cache/f3/labels/` | calibration, bake-off |
| R_v6 | Spike A's 37 tuning pairs accepted in one direction while the reverse was judged and rejected (synthetic text) | `.cache/spikes/reranker/`, `scripts/fixtures/matching-benchmark.json` | X2 |
| R_v9 | the note pairs v9 accepted on the pinned fixture notes (ENV-F's pre-F3 relations, 137), cross-checked with V9-A | `.cache/f3/labels/r-v9/` | X2 |
| V9-A, V9-B | the v9 sample A and B end states: backups `memora-backup-2026-10-15T04-26-44-745Z` and `memora-backup-2026-10-15T11-51-15-809Z`, verified by counts (138 notes; the stored reports' relation counts) | `.cache/f0/backups/`, map `.cache/f3/m0/backup-map.json` | M0 generative baseline (fallback: M0's replay) |
| SOAK | clone of ENV-G plus public corpus articles arriving | `env-soak` | X6 |
| X7-REF | the five golden sources below, 66 chunks | fresh `env-x7`, fresh cassette `golden-x7-f3` (record) | X7 |

**X7-REF, fixed before any F3 run.** Rule: golden sources in manifest order, starting at a seeded index and taken
greedily (wrapping) until the set holds ≥60 chunks with at least one pt-BR and one en source. The start index is
`floor(createRng(20261060).next() × 10)` with `packages/domain/src/topic-tree/rng.ts` (first draw 0.4623, index 4,
0-based). Chunk counts per source are those of every completed golden run (chunking makes no AI call), e.g.
`.cache/golden/runs/2026-10-17T00-48-25-703Z/summary.json`. The set:

| Manifest key | Language | Chunks | Notes (F2 runs) |
| --- | --- | --- | --- |
| `wikibooks-en-memory-and-language` | en | 17 | 10 |
| `machado-o-alienista` (book, 3 chapters) | pt-BR | 17 | 21 |
| `machado-a-cartomante` | pt-BR | 14 | 11 |
| `poe-the-tell-tale-heart` | en | 10 | 9 |
| `o-henry-the-gift-of-the-magi` | en | 8 | 7 |
| **Total** | 2 pt-BR, 3 en | **66** (2.2 chapters) | 58 |

### Cassette rules

Every sample starts from its own fresh copy; a base is never modified. Copies for relation runs are stripped of the
generative decide and judge entries (`reranking` on Codex: v9 note decide, v5 source judge) so those calls are live;
extraction, embeddings, topic calls and gate rank calls stay. Every report shows 0 extraction misses (golden ingestion
runs), the replayed and live counts per task, and the live tokens (input, output, reasoning). Golden ingestion runs use
`MEMORA_GOLDEN_TOPICS=deterministic`, `MEMORA_GOLDEN_PIN=extraction`, serial lanes and link pool 1; the **GOLD M2 run**
is one such run of golden-small through the real ingestion path with the frozen configuration (typing and discovery
live). Re-match runs need no extraction; they check the pinned note digest (138 fixture notes on ENV-F, 160 golden
notes on ENV-G, the digest M0 records for ENV-C). **Non-regression replays** strip every matching entry
(generative `reranking`, the v5 judge, `relations.type`), keep the pin, let local misses run live and counted (`MEMORA_AI_CASSETTE_LOCAL_MISSES=live`) and
switch relation remote calls off (`MEMORA_GOLDEN_RELATIONS=local`: untyped path, discovery deferred), so they cost $0
and their bar is 0 extraction misses (summaries, notes, graph with identity and type resolution) and 0 remote misses.
Throughput reruns use recorded timing (`MEMORA_AI_CASSETTE_TIMING=recorded`: a served entry waits its recorded
`durationMs` inside its lane).

### Panel and label set

- **Population:** candidate pairs that reach the decider under the current retrieval at k = 20 (M0's exports: every
  fixture and golden note, and 200 corpus notes drawn by seed 20261018), both directions scored by MLX. Strata by MLX
  s: <0, [0, 1.5), [1.5, 3.3), [3.3, 5), ≥5, sampled 15/20/30/20/15%. Source pairs: 15 fixture tuning, 10 GOLD, 15
  CORP, half nearest-neighbour and half random cross-root, plus the nearest and second-nearest root by composite
  cosine of the 10 GOLD roots and 20 CORP roots (seed 20261018), deduplicated (about 45 more pages). Strata are
  defined at the provisional instruction, template and rule; the weights are recomputed on F3's own retrieval (M1's
  fixture-tuning candidates for pool A; F3-retrieval exports of ENV-G and the ENV-C 200-note sample for pools B and C).
- **Page per pair:** both notes in random A/B order per judge (title, idea, first 600 body characters, source title,
  language); no scores, model names, dataset names or other judges' answers; pairs in seeded random order; 20 pairs
  per judge prompt with one shared instruction block and one JSON line per answer.
- **Questions:** (1) does one note make a claim about the same mechanism, rule or phenomenon as the other, supported
  by both texts, so that a careful reader would link them (shared names, topics or dates alone are not enough)? yes or
  no; (2) if yes, the type from the write vocabulary; (3) if directed, which note is the subject (A→B, B→A). Source
  pairs: the same questions over two source summaries and two evidence excerpts each.
- **Judges:** three independent Opus 5.5 agents with the same page file and no access to each other; majority per
  question; a type with three different answers is unresolved and left out of type accuracy; at most 600 pages each.
- **Splits:** fit 60% / eval 40% by unordered root-pair group (no group crosses splits), stratified by pool and
  stratum (seed 20261018). R_v9's lost-pair passes at the freeze and at M2 mix in 20 already-labelled pairs as a
  consistency check.

### Seeds

| Seed | Use |
| --- | --- |
| 20261018 | label sampling, page order, splits, the corpus 200-note draw |
| 20261022 | cross-validation folds |
| S0 = manifest order within partitions, tuning first; S1 = 20261031; S2 = 20261032 | X1 arrival orders, all with the fixture's "held-out arrives after the library" protocol: S0 releases the 40 tuning roots in manifest order, then the 20 held-out roots in manifest order (the raw manifest interleaves 14 held-out roots among tuning ones); S1 and S2 release the tuning roots in a seeded shuffle, then the held-out roots in a seeded shuffle |
| 20261040 + 1..200 | offline note-order replays (D19) |
| 1..2,000 | source-order replay (existing script convention) |
| 20261050 | TP-C200 article draw |
| 20261060 | X7-REF source selection |
| 20261021 | soak driver and fault plan |

The F2 evaluation seeds (20261014, 1-5) and calibration seeds (7-12) are untouched.

### Pre-registered selection rule

T58 applies it, with T57's population weights, before any held-out read; the outputs go to `relations-config.ts`
(defaults only) and `frozen.json`.

- **Instruction:** the highest AUC on the fit labels (pools A-C) among Spike A's four instructions plus one
  relation-agnostic text; ties by fixture-tuning expected root pairs found at zero forbidden.
- **Text template:** 400 or 600 body characters, by the same criterion.
- **Aggregation:** max or mean of the two directions' log-odds, by the lower 5-fold cross-validated log-loss on the fit
  labels (folds seed 20261022); max on a tie.
- **p_apply:** the smallest P with population-weighted precision ≥0.95 (5-fold cross-validated over the fit labels)
  and a Wilson 95% lower bound ≥0.85, and 0 forbidden fixture-tuning root pairs at or above it.
- **p_suggest:** the smallest P with weighted precision ≥0.80 and 0 forbidden fixture-tuning root pairs at or above it.
- **Escalation:** adopted only if it raises cross-validated recall at fixed precision and adds no forbidden
  fixture-tuning root pair.
- **Reported per decider:** population-weighted ECE (10 bins), Brier score and the reliability table on the eval
  split; AUC per pool; weighted precision at p_apply and recall at p_suggest; ms per pair p50/p95 through the product
  adapter. A decider with no calibration entry, or whose last parity check failed, is `uncalibrated` (suggest only).
- **Bake-off deciders:** MLX Qwen3-Reranker (each instruction and template, max and mean) and GGUF Qwen3-Reranker
  (its own calibration), both scored through the product adapters; bge-reranker-v2-m3 (control); generative
  decide-only v9 on Codex (recorded verdicts where they exist); OpenAI Decisions (D6); the escalation cascade.

### Gate-0 throughput rule

With per-source pipelining the local and remote lanes overlap, so for 200 notes `W ≈ max(L, R / c) + T_fill + T_tail`,
with `L = 2 · U · t_pair + n_calls · t_call + T_sql` (deciding), `U = Σ K_eff · (1 − d)` (unordered pairs scored once)
and `R = n_type · t_type + n_disc · t_disc (+ n_esc · t_esc)` (typing, discovery, escalation on the remote lane at
concurrency c). Start values: t_pair 30 ms MLX and 56 ms GGUF (B1 measures), t_call ≤7 ms after D38 (B6), K_eff 20 and
d 0.35 (B4), t_type 2.2 s per 24 pairs and t_disc 2.8-3.8 s on Codex (M1), c = 2 for Codex (B5, T47b). Start forecasts
for the Hybrid preset: TP-G ≈2.9 min, TP-C200 ≈2.9 min, TP-F ≈3.0 min coalesced (3.7 per source), TP-C200 with GGUF
≈5.0 min.

- **Rule:** with B1 and B4 measured (and c = 2 until B5 lands), the model must forecast ≤3.2 min (80% of the bar) for
  every shape with MLX and ≤6.4 min with GGUF.
- **Otherwise the levers apply in this order** and are recorded under Gate 0 outcome before wave 3: (1)
  `rankPairsPerCall` and the helper batch from B1, within D16's P0 cap (MLX 16 or 32, GGUF 16); (2) small-source
  typing coalescing (D20, on in product); (3) Codex lane maximum 3 when B5 shows no 429 at 3; (4) D17's
  recall-lossless retrieval limits with their rule edit.
- **Not levers:** dropping a direction, cutting K below its tuning-lossless value, and batching several discovery
  pairs in one call (quality unmeasured).
- The forecast is re-run with measured K_eff, d, t_type and t_disc at gate R (bar ≤3.6 min).
- **Interactive budget:** a P0 query embedding waits for at most one bounded local call, ≤1.0 s per runtime (32 pairs
  on MLX ≈1.0 s, 16 on GGUF ≈0.9 s); an explanation's first text ≤1.5 s p50 on Codex (reported).

### Non-regression at every gate and wave close (D41)

| Check | Bar |
| --- | --- |
| `topics:e2e` replay (E6) | Until F3 matching merges (gates 0 and M): `e2e-plos` replay PASSED, 0 misses. From T51/T52 until T55k's re-record (gate R): the non-regression replay of `e2e-plos` (E6 matches on its local writer through the derived `ranker-else-generative` mode) PASSED with 0 extraction misses and every `assertions.ts` check green. From T55k on (gates F, P, X): `e2e-plos-f3` replay PASSED, 0 misses of any kind |
| `db:topics:verify` | pass |
| `topics:audit` on ENV-F and ENV-G after the runs (ENV-C at gate X) | E1 100%, 0 orphans, 0 hard violations |
| Topic gate under relation load (TP-C200) | rank execution p95 ≤0.3 s, 0 ranker reloads; queue wait reported |
| PLACE on the compute worker under relation load | p95 ≤100 ms |
| Embedding space key on every profile | unchanged |
| Composite recompute against the F2 tree | re-placements of root sources on ENV-G and ENV-F reported (0 expected); weekly churn of those runs reported |
| `golden-small-f2` replay (G1 deterministic, serial lanes, pin on) | Before T51/T52 merge: full replay, 0 misses. After: the non-regression replay, 0 extraction and 0 remote misses; 197 chunks, 160 notes and the pinned graph digest unchanged; $0 |
| Ask during an import | 0 timeouts; waits for at most one bounded call |
| A 200-link page | ≤2 IPC calls per cycle |
| `notes.page` / `objects.locate` p95 on SEED30K | ≤5 ms / ≤50 ms |
| Explanation second open | 0 calls |
| Ranker validation after any helper or runtime rebuild | current on every measurement profile; parity check passed (D13) |

At every wave close the orchestrator runs the full `npm run check`, `phase4:e2e`, `topics:e2e --synthetic`,
`db:seed:verify`, the stage verifiers and this list.

### Reported, not gating

P0 wait p95 (soak, TP-C200); explanation first-delta and total p50/p95 over 10 remote and 5 local-writer opens;
`objects.neighborhood` p95 (≤20 ms at depth 1 and ≤50 ms at depth 2 on SEED30K expected); retrieval p95 per note on
ENV-C against the old queries; in-slot non-model time p50 before and after D38; AIMD events; breaker transitions;
typing accuracy and swap consistency against the panel; population-weighted ECE and Brier per decider; Fleiss κ; the
light-lane gate latency; days the relation cap was reached and P1 relation calls per day; `wedged` events; lane
re-waits (`requeue_ms`) p50/p95; parity checks run and their max \|Δ\|; schema fallbacks; salvaged graph items; the
ranker's offline AUC on the 40 source pairs.

### Budget (owner quota)

- **Codex (gpt-5.6-luna, the owner's subscription):** about 340 calls and 445k tokens before M2 (bake-off v9
  verdicts, the B5 lane probe, the strict-schema probe, the typer position-bias check, the re-match dry run, M1, T53's
  tuning proof and second-nearest verdicts, the explanation proof) and about 605 calls and 870k tokens in M2 (X1
  samples, the GGUF sample, the GOLD run, TP misses, TP-C200, the S1 order-replay closure, X7-REF): about 945 calls and
  1.3M tokens planned (range 1.1-1.5M). Reserve 0.4M: 0.15M before M2 (gate R's fix loop), 0.25M held for M2 and the
  exit (D7's second runs; X7-REF's is likely). **Cap 1.7M** (Q3).
- **Rules:** work before M2 may spend its subtotal plus its reserve (≤595k); crossing that stops the line and the
  orchestrator asks the owner before M2 starts. At the cap, or when the M2 reserve would be breached, runs are dropped
  in this order: (1) the S1 order-replay closure (unjudged pairs counted unknown); (2) the GGUF X1 sample (an offline
  rescore of S0's candidates with GGUF scores replaces it); (3) the second TP-G and TP-F runs (the first run's recorded
  timing replays instead); (4) D7 second runs of reported, non-gating values. Never dropped: X1 S0, S1, S2 and B1; the
  first X7-REF run; the GOLD M2 run; TP-C200 run 1; S1 time and quality on S0 and S1.
- **Decisions API:** about 2,000 requests on synthetic text, under US$1 (Spike A2 spent US$0.69 on 2,702).
- **Claude (the owner's plan, Q19):** task work of about 26.25 Opus, 31.75 Sonnet and 0.25 Haiku agent-days plus about
  4.5 Opus days of reviews and merges; the panel about 1.2M input and 0.4M output Opus tokens on compact pages, at most
  600 pages per judge. The orchestrator reports Codex and Claude usage at every wave close; if the owner says credits
  are short, the line pauses at the next wave boundary.
- Local ranker, embedding and soak calls cost no quota. Every run reports its live tokens.
