# Memora Eterna 2.0 refactoring plan

**Current phase: F4 (authorized by the owner on 2026-10-23; F3 closed on 2026-10-20); F5 started 2026-11-11
beside F4's close (`docs/f5-decisions.md` D3). Sequence: F4 → F5 → F6 →
F7; the owner tests only in F7, the complete app after legacy removal (decision 34).** Branch: `refactoring`
(from tag `pre-strangler`). This document holds the target architecture and the roadmap. Durable invariants live
in `RULES.md` and `rules/`; numbers here are starting points unless marked measured.

## 1. Goal and owner complaints

Goal: a real second brain with a self-balancing topic tree that always leads to every source and note,
relations found in seconds, maintenance that works without configuration, and one modern workspace where
generating and using knowledge happen on the same objects. Confirmed complaints: (1) generation (summaries,
notes, jobs, automation) is isolated from browsing the wiki; (2) relation reranking is extremely slow (11.9
s per note measured, prose for every candidate); (3) the wiki tree is not built properly, never rebalances,
and maintenance routines are confusing and do not work out of the box. Common root: structure, relations and
maintenance were side effects of slow, serial, prose-writing LLM calls, and the old rules forbade balancing,
concurrency and automatic correction.

## 2. Owner decisions (binding)

1. All work is done by Claude Code agents on branch `refactoring`.
2. AI-managed structure and relations are **automatic with undo**. Only human-created, human-edited, pinned
   or protected content needs approval before automation changes it.
3. Relation decider: **local reranker by default**: Qwen3-Reranker on MLX (MLXLLM, yes/no logit score);
   fallbacks are GGUF Qwen3-Reranker via node-llama-cpp `createRankingContext`, then bge-reranker-v2-m3.
   The OpenAI Decisions API is an option to measure (owner provides a Platform key). Jev is not planned.
4. **The existing wiki is wiped and ignored.** No adoption, no migration of wiki pages, no backward-compatible
   readers. Legacy wiki/curator/maintenance code is frozen (no features, minimal fixes only) until replaced.
5. All rules, UX, backend and API may be rewritten. Rules hold only durable invariants; numbers live in
   typed config with tests; no versioned compatibility contracts; no implementation diaries.
6. Agent model tiers: `RULES.md` section 4. Always set the model explicitly.
7. Git workflow: `RULES.md` section 6 (atomic verified commits; no push, merge or history rewrite unasked).
8. Approved downloads under `.cache/` with pinned SHA-256: Qwen3-Reranker-0.6B Q8_0 GGUF (ggml-org,
   639,153,184 bytes, sha256 `22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48`),
   bge-reranker-v2-m3 Q8_0 GGUF (gpustack, 635,676,416 bytes, sha256
   `a43c7c9b11a4c1517e5bf95151960e1621d1b72f7a493364b01e386cf1aaa1d3`), and a varied public calibration
   corpus (pt-BR + EN).
9. Agents may start the local PostgreSQL sidecar, read the owner's library (read-only in F0), add public corpus.
10. Golden-library cassettes are recorded via the current AI route (ChatGPT/Codex OAuth, gpt-5.6-luna).
11. About 26 weeks for F0-F6; F0 = weeks 1-2.
12. **Local models are MLX-first:** prefer the MLX implementation in `native/mlx-helper` (MLX Swift 0.31.6,
    MLX Swift LM 3.31.4 with MLXLLM and MLXEmbedders) whenever one exists; GGUF via node-llama-cpp is the
    fallback when there is no MLX build or no Apple Silicon. Approved extra downloads under `.cache/`: MLX
    weights of Qwen/Qwen3-Reranker-0.6B and Qwen3-Embedding-0.6B (safetensors or mlx-community conversions,
    Apache-2.0), with pinned revisions and SHA-256.
13. **Generated atomic notes are active at birth** with an AI-provenance badge; review is optional and never
    a gate (replaces `pending_review` as the default). Human-edited notes stay protected.
14. **Claims are no longer extracted** (2026-10-14): knowledge-graph extraction returns only entities and
    relations. Claims cost ~25% of graph output and were never shown; the `claims` table stays read-only.
    "What sources say about X" is served by atomic notes linked to entities.
15. **F1a exit re-based** (2026-10-15): matching quality is measured on pinned notes (extraction served from
    the cassette) because two extraction samples differ more than two matchers do; the old 27/28 held-out was
    at the 95th percentile of its own decider noise (~17% of samples reach it). F1a closes on ≤1/3 of the v6
    time per note, 0/35 forbidden and ≥27/28 expected on notes or sources; note-layer coverage becomes an
    F3 target (`docs/kpi-f1a.md`).
16. **The decider writes no prose; explanations are written on demand** (2026-10-15): on the golden library
    note matching was 4.29 s/note (41% of v6) and explanations, half of them on verdicts that can never be
    accepted, were the largest removable cost. The decide call returns compact `[alias, score 0-100, type]`
    items only (`atomic-note-matching-v9`); a relation's explanation is written when the owner opens it and
    is cached on the relation (the F3 `relation.explain` task, pulled into F1b with the Note page). Analysis:
    `docs/kpi-f1a.md`.
17. **Source matching decides without prose too** (2026-10-15): it cost ~20 s per source on the fixture (6.2
    calls, 72% fixed cost and reasoning) and wrote prose in the background, against decision 16. F1b: each source
    pair is judged once and `sources.match` becomes a compact score-only verdict (`source-relations-v5`) with
    explanations written on open (~-26% predicted, same quality). F3: accepted note relations become source
    relations without a call and discovery judges only each source's nearest source, per source, with no batch
    barrier (~-81% simulated, quality 27-28/28, 0/35), after a spike on unjudged pairs. Analysis:
    `docs/spikes/source-relations-plan.md`.
18. **F2 decisions** (2026-10-15): the Topic Tree Engine decisions D1-D40, the owner-question defaults Q1-Q13,
    the gates and the measurement rules are recorded in `docs/f2-decisions.md` and bind F2; where section 4
    differs, they win. Work proceeds on each question's default until the owner answers. Two defaults pull
    later-phase work into F2: minimal model residency (Q11, from F3) and the removal of maintenance v1, the
    calendar routines and the Automation screen (Q12, from F4). The owner authorized wiping the legacy wiki
    early (D37-D40): it is wiped at gate W, before its replacement exists, and there is no switch.
19. **The local ranker is installed at first run, with a fallback** (2026-10-16): the first-run path installs the
    Qwen3-Reranker-0.6B (MLX first, GGUF fallback) next to the embedding model, so the placement gate has a
    decider from the start. Without a decider (not installed, removed or invalid), an ambiguous note is treated
    as the gate's "none" (a new-topic candidate REBALANCE may group) and is decided again once a ranker is
    validated; nothing waits at the root for ever. This replaces D10's "gated notes wait".
20. **Topic renames: growth drift 0.5 now, theme drift later** (2026-10-16): growth renaming keeps
    `renameDrift` 0.5 (7.4% of topics per week in the accelerated corpus replay); the ≤2%/week target is
    reported, not gating, in F2. Merged topics are renamed after a rebuild (drift 0.3). A drift measured on the
    theme (the name's label vector against the topic centroid) moves to the F4 gardener.
21. **Objective ratings by a panel of Opus 5.5 judges** (2026-10-16): objective evaluations such as E4's blind
    topic rating are done by three independent, blind Claude Opus 5.5 judges (each sees only what the rating page
    shows), with the majority per question; the pass rule is unchanged (D20, at least 24/30 rated both coherent
    and well named). The owner may still rate (optional, in F7); the panel replaces the owner's 45 minutes as
    the gate.
22. **F3 decisions** (2026-10-17): the Relations v2 and AI runtime decisions D1-D47, the owner-question defaults
    Q1-Q20 (all approved by the owner with the F3 budget on 2026-10-17), the gates, the measurement rules and seeds
    are recorded in `docs/f3-decisions.md` and bind F3; where section 4 differs, they win. Three readings narrow
    earlier decisions: bge-reranker-v2-m3 leaves decision 3's fallbacks (Spike A NO-GO; a bake-off control only,
    Q18); source relations are promoted from applied note relations only, which narrows decision 17's "accepted"
    (D23); and the MLX embedding adapter leaves F3 for the phase that re-calibrates topic placement in an MLX space,
    so no MLX embedder ships beside a GGUF default and decision 12 holds (D40, Q5). Relation labels come from the
    decision-21 panel instead of owner-labeled pairs (Q10), and a P0 call never spills to a remote lane in F3 (Q9).

23. **Long waits overlap the next work** (2026-10-17): while a soak, a run of nightly KPIs or a stability window
    runs (F3's 24 h soak, F4's 7-day soak, F6's 7 nightly runs), work continues on the next phase or on the parts
    of the same phase that do not depend on it. If the test fails, work stops, the fix lands and the test restarts
    before anything advances further. A phase is closed only when its test passes. F6's runs use scratch profiles
    with no owner use; F7 starts only after they pass and legacy code is removed (decision 34; the 2 stable weeks
    before removal were dropped by the owner on 2026-11-11, since the legacy code was never used on refactoring).
24. **Settings v2** (2026-10-17): Settings is redesigned as one streamlined, consistent surface that carries
    every setting the F3-F5 redesign adds. F4 inventories every setting (where code reads it, its default, and
    its fate: keep, merge, move to Advanced or drop) beside its automation cut (37+ to ≤6); F5 builds Settings v2
    on the design system from mockups the owner approves first, and the old screens go.
25. **Hardware detection and recommended setups** (2026-10-18): the app detects the platform (CPU and
    architecture, memory, Apple unified memory and its GPU working-set limit, GPU and VRAM, NPU, free disk) on
    macOS and Windows (the app will be ported) and suggests one predefined setup per hardware tier — local
    models where they work well (MLX on Apple Silicon, GGUF on Windows), efficient, very cheap cloud models where they do not (with price and an estimated monthly cost) — with
    alternatives, never blocking. Research and an on-device benchmark on the owner's 64 GB Mac come first (any
    model download is approved by the owner); the first run uses it in F4 and Settings v2 shows it in F5.
26. **No new model variable until the program ends** (2026-10-18): every phase keeps today's models (writer
    gpt-5.6-luna on the Codex route, Qwen3-Embedding-0.6B and Qwen3-Reranker-0.6B), quantizations and runtimes.
    The local-model benchmark of decision 25 and any runtime-upgrade spike are measured and recorded only (a
    document, no catalog, default or preset change, no merge); the owner decides on them after F7, with the
    trial's findings (decision 34; the trial runs on today's models and runtimes). Hardware detection may ship,
    but its model suggestions stay informative or off until then.
27. **A book's catalog header always carries its summary** (2026-10-18): a hierarchy root's catalog header
    chunk includes the root's AI summary whatever the order its jobs ran in. When the summary is written or
    changes after the header was built, the header chunk is rebuilt, re-embedded and its knowledge graph
    re-extracted (the old chunk's mentions replaced), and the root composite follows; existing libraries are
    brought up to date once. Built in F3 after T53f (it moves no F3 baseline: a one-batch import already does it).
28. **Summaries of large sources are batched by the writer's capacity** (2026-10-18): a book's summary is built
    from its chapters' summaries and a long chapter's from its partial summaries; when that input exceeds a
    budget derived from the active writer model's context window (minus the prompt and the output reserve), the
    summaries are combined in consecutive batches, recursively, until one call fits. The budget depends on the
    model in use (large for Codex, smaller for a local writer); no model changes (decision 26). Built with
    decision 27's task; sources that fit in one call keep today's requests.
29. **Automatic relations are suggestions** (2026-10-18): with today's models no decider reaches F3's
    panel precision bars on real-library text (best about 0.7; the fixture is matched well), so F3 applies no
    relation automatically. The decide threshold is chosen on the fixture tuning partition (most expected root
    pairs found at 0 forbidden), every automatic relation is shown as a suggestion, typed suggestions promote to
    suggested source relations, the graph draws suggestions distinctly, and the owner's Keep and Remove make a
    relation final. Panel precision and calibration are reported, not gating; F6 builds the recalibration
    pipeline and runs it on the decision-21 panel labels plus synthetic labels (reported, not gating), and
    recalibration from the owner's real Keep and Remove happens in F7 (decision 34). A typer prompt with the
    panel's strict criterion is tested on live Codex (about 60-100k tokens); if typed suggestions reach precision
    0.80 they form a "confirmed" tier. (Until 2026-11-11: F6 recalibrated from real Keep and Remove.)
30. **The Decisions API as an opt-in decider** (2026-10-18): on F3's panel labels the OpenAI Decisions API
    (gpt-6-luna, remote, paid) is the only decider that clears decision 18's apply bar (cross-validated precision
    1.000, Wilson 0.89; fixture tuning 26/26 at 0 forbidden); the local Qwen3-Reranker-4B ranks better than the
    0.6B but reaches no apply band and is 5-8x too slow, so it is not adopted and was deleted. After a validation
    with product-shaped (dense) requests on the public golden and corpus texts, F3 adds the Decisions API as an
    opt-in decider in the Hybrid and Cloud presets: its own frozen calibration, automatic apply in its apply band,
    suggestions below, the local ranker as candidate filter and fallback, a Platform key and a privacy notice in
    Settings. The Local preset keeps decision 29. This is decision 26's owner-approved exception.
31. **F3 gate outcomes decided** (2026-10-18): (a) the gate P repair bar sets aside every structured call of the
    local writer (the MLX 9B writer returns invalid structured output in 8-19% of calls, schema mode none); F4
    builds JSON-constrained decoding in the MLX helper (our code; no model or library change) with its own
    measurement; (b) automatic relations carry no direction (no arrow; the typer reads direction from note
    position, 0.57 against 0.85): direction comes from the owner when keeping a relation, or from the Decisions
    decider when its two directional scores differ clearly (about 0.78); (c) the Decisions decider applies
    automatically in its frozen apply band (frozen from the product's own requests, fragile across fold seeds:
    the owner accepted it); (d) X2 (reverse-only losses, mostly `extends`) is recorded as not met in F3 and
    carried as not met through F6 (it may be re-measured on the panel-labelled R_v9 set after any decider change,
    reported only) and revisited in F7 with real verdicts (decision 34; until 2026-11-11 the revisit was F6's).
32. **Local models first; a remote run as the last check** (2026-10-23): every phase does all it can for the
    local models to meet their bars as planned (tuning, constrained decoding, batching, prompts, within decision 26).
    If a local model then comes close to a bar but still misses it, the same test runs with the Codex writer and the
    Decisions API decider (gpt-6-luna); if that run passes, the bar is met for the phase. The local result is
    recorded as reported, with its gap and the Local preset's limit. Each phase's decision record fixes "close" and
    the remote spend for such runs before any run; above that spend the owner decides.
33. **F4 decisions** (2026-10-23): the Gardener, Inbox, Activity and first-run decisions D1-D38, the owner's answers
    to Q1-Q13 (every default accepted except Q4, the matching controls go to Advanced › Matching, and Q12, the
    Decisions ledger probe runs), the gates M, S and X, the exit and carried bars with their data and methods, decision
    32's "close" and remote spend, the 7-day soak plan and the budget are recorded in `docs/f4-decisions.md` and bind
    F4; where section 4 differs, they win. Its readings narrow earlier text: 4.3's states are derived from `jobs`
    columns (D5), a P0 call still never spills to a remote lane (F5), C4's Local 24 h re-run is decision 31a's soak,
    and the Ask box's GIN index is built only with a prefilter (D22).
34. **The owner tests only the complete app, in F7** (2026-11-11; translated from Portuguese: "I will do the real
    tests only after F6, including after the removal of the legacy code ... test on the complete version and then
    review or fix any problem that comes up"). No owner use, test or rating on refactoring code before F7 entry
    (gate T); F4, F5 and F6 exits are automated only. Before F7 the owner only answers questions and approves
    designs (static mockups with synthetic data). F7 (section 7) follows F6: the owner tests the final build (the
    commit gate T tests) and agents triage and fix the findings; the work that needs real use moves there
    (recalibration from real Keep and Remove, the X2 revisit, the real undo rate, decision 26's adoptions). Agent
    proofs run on scratch or cloned profiles (`rules/architecture.md`). Owner answers (2026-11-11): (a) the trial
    starts on a new empty profile where the owner adds their own sources; the owner's DEV profile (only the
    golden library) is not upgraded for the trial and its library is not re-matched (`docs/f4-decisions.md` Q8,
    Q11; any later upgrade only on a new owner request); (b) legacy code is removed with no stability window,
    since it was never used, behind a restore-verified backup and the rollback tag; (c) the tag
    `f6-pre-legacy-removal` is approved, created just before removal and kept until F7 closes, and the stage is
    named "F7 Owner trial and fixes". Still open, with no spend unless the owner approves: an optional final
    Hybrid soak on the F6 build (about 1.4M Codex tokens for 72 h).

## 3. The five swaps

| Today | Target |
| --- | --- |
| LLM curator picks the tree from groups of ≤6 chunks seeing ≤3 pages | **Topic Tree Engine**: deterministic placement on embeddings, invariants, rebalancing; LLM only names topics and writes prose on demand |
| One rerank call per note writes prose for ~20 candidates, ~94% rejected | **Relations v2**: retrieve → filter → decide → type → explain later |
| 4 calendar routines, 37+ knobs, 21 internal states, global latches | **Gardener**: event-driven tasks, per-item failure isolation, undo, Inbox, 3 controls |
| One global AI FIFO and one job at a time | **AI runtime lanes**: one local slot, bounded remote concurrency, interactive priority |
| 10 silo screens and 3-4 search systems | **One workspace**: tree, stacked object pages, context panel, Cmd-K, Home, Inbox, Activity |

## 4. Engines

### 4.1 Topic Tree Engine

The navigation tree becomes a first-class structure maintained by deterministic code over the existing
pgvector embeddings. Code: pure domain in `packages/domain/src/topic-tree/` (Float32Array, seeded tests),
repository in `packages/db`, service in desktop main, clustering in a `worker_thread`. F2 design decisions:
`docs/f2-decisions.md`.

- **Statistics (BIRCH-style, derived and exact):** per topic, count `N` and sum of unit vectors `LS`;
  centroid `LS/|LS|`, coherence `|LS|/N`. `N`/`LS` count notes; a root source counts only while it has no
  current placed note. A note uses its embedding; a root source uses the centrality-weighted mean of its
  current notes (fallback: its stored composite vector; with neither it waits in Unsorted, flagged
  `needs_vector`). After any placement change the touched path is **recomputed** bottom-up in content-key
  order, never subtracted (an edit deletes the old vector); a member with a stale vector keeps its place and
  leaves the stats until re-embedded. Deleted notes and sources leave by cascade, which marks their paths
  dirty for a sweep.
- **PLACE:** beam descent from the root scoring children by centroid and label similarity, with
  node-relative admission thresholds. Clear winner → automatic (0 calls). Ambiguous → applied at once at the
  deepest admitted common ancestor and refined later by a decision gate: a validated dedicated reranker over
  ≤5 topic descriptors (no generative gate); placement never waits for a model. No reranker → the item waits
  there until one validates; no acceptance → flagged for a split check. Up to 2 secondary "also in"
  placements. A lone item never creates a topic.
- **Invariants:** I1 every current note and root source is reachable from Topics (hard; an item may wait in
  Unsorted, the root's direct items, or flagged at an ancestor). I2 one primary parent, ≤2 secondaries, no
  cycles (hard). I3 internal fan-out 2-12, target 4-9 (soft; hard above 16); the root follows the Areas band
  instead. I4 leaf holds 3-30 direct items, target ~15 (soft; hard above 45). I5 target depth ≤5, cap 7
  (hard at cap; sideways split). I6 no single-child chains (soft). I7 unique sibling titles, case- and
  accent-insensitive (hard). I8 coherence above a calibrated floor, else split candidate (soft). I9 IDs are
  never reused; retired topics become redirects (hard). Unsorted share ≤2% and item age in Unsorted are soft
  targets that raise an Inbox suggestion, not hard violations. The Broad/Balanced/Deep preference shifts
  I3/I4.
- **Operations:** leaf split (balanced spherical k-means or Louvain), push-down on fan-out overflow (node
  keeps its ID), sideways split, merge, dissolve, collapse, re-parent, rename. Each is accepted only if it
  fixes a hard violation or `ΔQuality − λ·Churn > 0` (churn weighted up for recently opened items).
- **Stability:** hysteresis, per-node cooldown, freeze on nodes the user recently viewed or edited, daily
  operation and move budgets, "moved from X" hint. Pinned and human-created nodes never move automatically.
- **Naming:** one write-fast call per operation for all new nodes (title, one-line description, aliases, in
  the content language, Zod-validated, sibling duplicates rejected). Names are ALWAYS in the content
  language, even when a cluster's notes are mostly in another language (owner feedback on Spike B: mixed
  pt/en TF-IDF names). Without an LLM: provisional "Parent › TF-IDF terms" built only from content-language
  items with that language's stopwords; with no such items the topic stays unnamed (no title is stored; the
  UI shows a localized "Unnamed topic") and flagged for naming. Names change only on create, split or merge,
  or after enough membership drift *(cal.)*; human names never change. Clustering itself stays
  language-agnostic (pt and en notes on one subject belong together).
- **Bootstrap and cold start:** below ~12 items everything is a direct child of Topics and shown as
  Unsorted; at ~12 items a bottom-up bootstrap builds the first named tree (chapter centroids seed k-means
  for a single hierarchical source).
- **Areas (the top two levels):** an LLM Clio-style grouping of the level-2 topics into 7-16 Areas (target
  10 *(cal.)*; re-based from ~10-16 on Spike B's 7-12), validated by code and accepted only if level-2
  quality does not drop; applied automatically at bootstrap, later Area-level changes are `pending_review`.
  The user may pin Areas, and pinned Areas stay fixed. The root's fan-out band is the Areas band, not I3.
- **Shadow rebuild:** periodic or on quality drop; old→new topics mapped by Hungarian matching on member
  Jaccard so IDs survive; emitted as ordinary operations.
- **Embedding-space change:** re-embed in batches (automatically on local routes, through an explicit action
  on remote ones), recompute `N/LS` and label vectors, recalibrate thresholds, map topics by Hungarian
  matching, reset Atlas positions. Vectors of two spaces are never compared.
- **Events and undo:** every operation writes a structure event inside a change-set; undo applies the
  inverse and, when later change-sets depend on it, blocks and names them (no cascade in v1).
- **Topic page:** deterministic map of content (subtopics with counts, notes by centrality, contributing
  sources, related topics; zero LLM calls) plus a lazy prose overview written when opened or by REFRESH,
  with citations and a support check.
- **Ownership:** topic identity lives in a new `topics` table whose `parent_id` is the only parent pointer;
  the engine is the single writer of AI-managed topics and placements (enforced by a database guard and a
  static test), and human operations go through it. `wiki_pages` stays legacy: emptied by the legacy
  wipe, dropped in F4.
- **Data:** new tables for trees, topics (management ai|human|pinned, redirects), stats (dirty flags),
  placements, change-sets and structure events, gate decisions, daily metrics, calibrations and overviews;
  topic label vectors (and later centroids) reuse the per-dimension embedding tables.

### 4.2 Relations v2

Runs per note as soon as it has an embedding (MATCH task). No batch barrier; a failed source never blocks
its siblings. No prose is generated for rejected candidates.

1. **Retrieve (SQL only):** ANN on a partial HNSW index of current notes (ordered by raw distance), FTS on
   an indexed generated `search_tsv`, shared entities; RRF into ~20 candidates, excluding superseded,
   rejected and already-related pairs.
2. **Filter (0 calls, lossless only):** pairs a human already decided, pairs already related, and a decision
   cache keyed by the exact decider input of both notes and the decider. Acceptance is the calibrated
   probability alone (the legacy weighted score and its feasibility gate leave it), and all ~20 fused candidates
   reach the decider with no lossy cosine floor, unless gate 0 needs recall-lossless retrieval limits
   (`docs/f3-decisions.md` D17).
3. **Decide P(related):** local reranker by default, MLX first (Qwen3-Reranker on MLXLLM), then GGUF
   Qwen3-Reranker (bge-reranker-v2-m3 retired as a fallback, a bake-off control only: F3 Q18); generative
   decision-only route as the universal fallback; OpenAI
   Decisions as an optional measured accelerator (use `predicate` for acceptance; shuffle options if `choice`
   is used for type). Raw scores for both directions are stored separately from calibration, so recalibration
   never re-decides. Isotonic calibration gives accept / uncertain / reject bands; in Auto mode high-precision
   accepts are applied, the rest of the accept band becomes suggestions.
4. **Type and direction:** only for accepted pairs, one enum JSON call **batched per source** (supports,
   contradicts, extends, depends_on, example_of, clarifies, same_as or none; none is a veto).
5. **Explain later:** a fast model writes a short explanation when the relation is opened (or prefetched
   after a hover delay), cached per pair, hashes, type, prompt and model; low-priority backfill for recently
   viewed pages. The writer may answer NOT_RELATED, which sends the relation to the Inbox.

**Source relations by design E** (decision 17, `docs/f3-decisions.md` D27): every typed applied cross-root
note relation is promoted with no call (one source relation per root pair and type; importance and confidence
unknown). Discovery judges, once per unordered pair, each new source's nearest already-matched root plus the
earlier roots whose nearest it becomes, on the stored composite vector, with F1b's compact score-only verdict;
per source, with no batch barrier (two neighbours only if the labelled check asks for it). This replaces
per-pair proposal calls, the four-signal shortlist and the Cartesian trigram join.

**Reranker caveats (GGUF fallback):** verify the GGUF header (classification head, rank
pooling; for MLX, the config and architecture) and a relevant-vs-irrelevant smoke test before exposing
`decide`; do not use the custom `template` option for bge; do not quantize the KV cache for ranking;
`rankAll` is serial and llama.cpp issue #30422 is present, so latency is budgeted only after measurement.

### 4.3 Gardener (event-driven maintenance)

Built on the existing `jobs` table (priority, `run_after`, attempts, SKIP LOCKED) plus `dedupe_key` and
`lane` (heavy: ingestion; light: Gardener and Obsidian, with a `compute` worker for work without model calls
and a `model` worker, so placement never waits for a model), with per-scope exclusion (a root, a topic, a tree's
structure or names: one running task per scope, `docs/f4-decisions.md` D6) instead of global "any job / any AI
call" blocks.

| Task | Trigger | Work |
| --- | --- | --- |
| PLACE | note created/edited/accepted, source chunked (debounced) | place in tree, update stats |
| MATCH | per source, as soon as its notes exist; a note again after a human edit or an accept | Relations v2 (suggestions) |
| REBALANCE | hard violation (fast) or soft violation after subtree quiet | split, merge, push-down, collapse, re-parent, naming |
| REFRESH | dirty pages, priority = dirtiness × views × recency; P0 when opened | additive overview patches with citations, "Divergences" side by side, explanation backfill for recently opened notes |
| AUDIT | after enough time and changes | deterministic lint: reachability, invariants, duplicates, broken links/redirects, stale embeddings, rolling re-placement, theme-drift renames |

- **States:** queued → running → done | no_change | failed (retryable with backoff; quarantined after a few
  attempts, shown in the Inbox with an action) | blocked (no model, cap, paused, offline, downloading) |
  skipped (same input fingerprint). No policy-wide latch; a pending review never blocks unrelated work.
  F4 derives these states from `jobs` columns without an enum change (`docs/f4-decisions.md` D5): blocked
  sets a task aside without burning an attempt; quarantine follows the second failed job on one subject and
  fingerprint.
- **Freshness by content only:** fingerprints use chunk, note and member hashes. Model, prompt and settings
  are provenance; changing a model offers an optional backlog. Saving settings never invalidates coverage.
- **Change-sets:** every applied task yields a localized, deterministic title, affected objects, risk level
  and an undo handle kept for the retention window (90 days; pending reviews are never pruned). One read model
  unions the topic change-sets, relation runs and overview versions; each store undoes its own (F4 D10).
- **Inbox:** a read model over pending-review change-sets, quarantined tasks, contradictions, NOT_RELATED
  vetoes, duplicates, Obsidian conflicts, budget items and backlog offers, worked from the keyboard; each verb
  goes through its store's writer and each decision becomes a calibration label. Real labels start in F7; F6
  never waits on a count of real labels (decision 34).
- **Controls (three):** autonomy (Off: no generative or remote background work, deterministic placement
  still runs; Suggest; Auto with undo, the default), monthly remote spend cap, pause. Plus the tree-shape
  preference and "only idle" / "only on AC power" options. Always reviewed regardless of autonomy: changes
  touching human, pinned or protected structure or text; large merges; Area-level changes; rebuilds moving a
  large share of items; contradictions that would rewrite prose. F4 puts these six controls in Settings ›
  Knowledge and the matching controls in Advanced › Matching (`docs/f4-decisions.md` D13, D33, Q4).
- **Money cap semantics:** remote background spend = recorded tokens × versioned price table; unknown price uses a
  conservative estimate, never zero; every background attempt reserves before it is sent, so a cap is passed by at
  most one attempt's estimation error. At 80% remote background work pauses until the user continues it from
  Activity (P0 continues); at 100% background continues local-only. Subscription routes without per-token price
  (Codex OAuth) are outside the money cap and bounded by lane concurrency and a daily background call cap.
  User-started imports show their estimate in the plan chip and do not consume the background cap. In Hybrid
  without a local writer, generative background work waits at the cap while placement and deciding continue
  locally; Activity says so. Local work has no money cap, only a duty cycle (lower while the user is active). The
  duty cycle, "only idle" and "only on AC" key on the budget class, never on priority (P2 also carries user
  imports).
- **Status:** one sentence with ETA and an action ("why isn't it running?"); blocker precedence paused > no
  model > cap > download > waiting > offline; shows coverage and ETA, never call counts.

### 4.4 AI runtime lanes

- **AiScheduler** replaces the global FIFO: one local lane with concurrency 1 shared by embedding, reranking
  and local generation (hardware ceiling); one lane per remote provider configuration with bounded
  concurrency (start: 4 for API-key providers, 2 for Codex OAuth; tuned from 429s and rate-limit headers);
  OpenAI-compatible localhost/Ollama counts as local.
- **Priorities:** P0 interactive (Ask, query embedding, explanation on open, user action), P1 focused
  source, P2 ingestion and linking, P3 maintenance; strict with aging; never preempts a running call.
  Background local work is split into bounded calls so P0 waits at most one of them. *(F5)* A P0 may use an
  allowed remote lane when the local lane is busy; through F4 a P0 call never spills (`docs/f3-decisions.md`
  D33): it needs alternate routes and a privacy gate (`docs/f4-decisions.md`).
- **Deadlines** count from execution start (connect, first byte, stalled stream, total per workload class).
  **Retries** in adapters: backoff with jitter for 408, 425, 429, 5xx, network and stalls, honoring
  `Retry-After`; never for 400/401/403/404/413, context overflow or schema failure after repair.
- **Schema output** via Zod JSON Schema: OpenAI `json_schema` strict, Gemini `responseJsonSchema`, Codex
  `text.format`, node-llama-cpp grammar. Each catalog caller states its output contract and the service derives
  what the runtime is sent (F4 D23); MLX gets JSON-constrained decoding over a schema subset in the helper
  (decision 31a, F4 D24, T99) and keeps one repair. Valid items are kept; only missing ones are re-requested once.
- **Workload classes:** `embed`, `decide`, `write-fast`, `write-quality`, `answer`, seeded from a Local /
  Hybrid / Cloud preset at first run and tested with one call each. `decide` accepts only validated
  rerankers or explicitly chosen deciders. Local mode needs MLX for generation, so it is macOS arm64 only;
  elsewhere the default is Hybrid or Cloud.
- **Efficiency:** `embedMany` (remote arrays; one reused local context), skip re-embedding when hash and
  space are unchanged, cached config/credentials/adapters, telemetry written outside the slot, residency of
  a small group (embedding + reranker) plus one generative model unloaded after idle (minimal residency
  lands in F2, Q11).
- **Lean ingestion:** graph extraction runs once per source over its chunks, for entities and relations; no
  claims extraction; duplicate notes on write become Inbox suggestions; windowed ingestion only after an A/B in F6.

### 4.5 Objects and events layer

- **Addresses:** five visible object kinds, each with a page and a stable address `memora://<kind>/<uuid>`
  (Source, Note, Topic, Question, Entity), plus anchors `#passage=<chunkId>`, `#span=<sourceSpanId>`,
  `#section=<sectionId>`. One address serves the router, links, Cmd-K, Obsidian deep links and Back.
- **Read model:** read-only views `knowledge_objects` and `knowledge_links`, plus `current_notes` /
  `current_relations` for currentness predicates. Canonical tables stay authoritative; materialize only if
  EXPLAIN gates fail.
- **Indexes:** immutable `f_unaccent` wrapper; stored generated text vectors for Ask on chunks (`search_tsv`)
  and notes (`ask_tsv`), `simple` config, a GIN only beside a prefilter (F4 D22); per-row `ts_config`,
  `search_tsv` on wiki sections and a materialized `root_source_id` in F5; trigram on titles; partial HNSW per
  target type; drop unused indexes.
- **IPC (Zod-validated):** `objects.get`, `objects.resolveMany`, `objects.locate` (primary path, "also in",
  citing pages), `objects.backlinks`, `objects.neighborhood` (DOI-ranked, bounded), and `search.omni` (FTS +
  trigram + ANN per kind, RRF across kinds) replacing the 3-4 current searches.
- **Push events:** a typed in-process event bus (`AppEventBus`) emitted after commit, coalesced and sent on one
  Zod-validated preload channel (`appEvents`): `job.progress`, `inbox.changed`, `gardener.status`,
  `model.download`, `budget.changed`, `changes.changed`, `overview.changed` and `consultation.status` since F4;
  `tree.changed` and `relation.created` bridged from their old channels until F5; `object.changed` in F5. It
  replaces the renderer's pollers (the ~17 are 9 `setInterval`s, 8 of them polling: F4 removed 3, F5 the rest).
- **State stores:** persisted Ask answers and Questions; a local, non-telemetry view history (recents, pins,
  resurfacing schedule) that feeds REFRESH priority, the freeze and churn weighting; optional opt-in usage
  telemetry stays separate.

## 5. Target UX

- **Five destinations:** Home, Explore, Library (a table of Sources), Inbox, Map; Settings in the rail
  footer. Jobs, Automation and Monitoring become the Activity pill and an advanced Diagnostics page. Opens
  on the last panel stack; Home on first run and the first open of the day.
- **Three-zone workspace:** navigator (tree with counts, health, notes and sources as leaves, pins, recents,
  Unsorted) | stacked object panels (click stacks, older panels collapse to spines, per-panel history; no
  click switches the top-level view) | context panel (Connections, Mentions, Evidence, Graph, Activity,
  Ask).
- **Object pages:** Topic (MOC + lazy overview), Source (live generation strip replaces the Jobs screen),
  Note (evidence, path in the tree, relations with who decided and who wrote), Question, Entity. Hover
  previews and citation chips (hover shows the passage, click opens it) everywhere.
- **Cmd-K:** jump, act and ask with prefixes (`>` actions, `?` ask, `#` topics, `@` entities) over the
  single retriever. Ask streams and saves answers.
- **Inbox:** the one place for human judgment, by risk, keyboard-driven, structural diffs shown as icicles
  (never raw UUIDs). Single-key shortcuts never fire in inputs.
- **Activity:** pill + drawer: now, waiting (with reason), needs you, done, budget.
- **First run:** three steps (languages; AI mode Local / Cloud / Hybrid that seeds and tests all routes;
  drop the first source). Default import is "Second brain" when a writer route is ready, otherwise
  "Searchable + organized"; non-interactive integrations stay searchable-only; "Just store" remains an
  explicit choice.
- **Shortcuts:** ⌘W closes a panel (app menu); no ⌘./⌘E/⌘I clashes; undo toasts keyboard-reachable.
- **Visual language, "quiet academic instrument":** graphite/paper chrome; colour only for object type,
  relation stance (always with a glyph) and state. Light accent `#07707f` (AA 5.4:1), dark accent `#65d6e8`;
  all text colours ≥4.5:1, glyphs ≥3:1 in both themes. Inter for UI and Source Serif 4 for reading, both
  bundled offline (OFL); fixed type scale, no arbitrary sizes; 4 px grid; short functional motion honoring
  `prefers-reduced-motion`; System theme by default; the graph reads tokens.

## 6. Visualization lenses

| Lens | Shows | Technique / library | Where |
| --- | --- | --- | --- |
| Tree navigator | topics with counts and health; notes and sources as leaves | virtualized ARIA outline, hoist, sticky breadcrumb (no new dep) | Explore, always visible |
| Local neighbourhood | focal object with typed directed relations, depth 1-2 | DOI ego-graph, sigma 3 + d3-force worker | context panel Graph tab |
| Shape | tree size, depth, violations, growth; before/after diffs | zoomable icicle, d3-hierarchy | Map › Shape, Home, Inbox |
| Atlas | all notes by meaning with tree territories and labels | UMAP + Procrustes; positions are presentation state | Map › Atlas (F6, spike-gated) |
| Evidence card | type, direction, confidence, both passages, decider and writer | progressive provenance, shadcn HoverCard | relation rows and edges |
| Relations (advanced) | current force graph scoped to a branch, coloured by topic | force + Louvain, topic super-nodes when zoomed out | Map › Relations (F5) |

Canvas/WebGL lenses always have a text or table alternative. Stay on sigma 3.0.3; the sigma 4 migration is
decided by a spike in F6. Avoid `@cosmograph/*` while it is licensed CC-BY-NC-4.0; use
`@cosmos.gl/graph` (MIT) instead if a GPU force layout is ever needed.

## 7. Phases

Phases are sequential (strangler: each engine runs in shadow mode first, new components are hosted in old
screens, legacy code goes only after its replacement passes; exception, F2: the owner had the legacy wiki
wiped before its replacement passed, 2026-10-15); each durable change ships with its rule update. Exit
numbers marked *(cal.)* are calibration targets from literature or estimates, to be confirmed or revised on
measured data, not facts.

### F0 Foundation and go/no-go bets (weeks 1-2)

- [x] Branch from tag `pre-strangler`; wiki/curator placement and Obsidian reverse editing of wiki pages frozen.
- [x] Specification diet: `RULES.md`, `rules/` ≤700 lines, reports in `docs/archive/`.
- [x] Prettier and ESLint (typescript-eslint, react-hooks) with a baseline suppression file; `npm run check`
      = typecheck + vitest + prettier --check + eslint + ratchet, building on `scripts/check-format.mjs` and
      the `lint` alias.
- [x] `scripts/quality-ratchet.mjs` (raw palette classes, arbitrary text sizes, window dialogs, renderer
      setInterval, product lines over 200 characters: numbers only go down; rule lines: fixed 800-line budget,
      raised to 900 until F7 closes by the owner on 2026-11-11).
- [x] Wall-clock instrumentation (migration 0043: stage attempts/attempt start/end, AI `queue_ms`/`attempt`)
      and `npm run kpi`; baseline in `docs/kpi-baseline.md` (owner library: 13 sources, 0 notes).
- [x] First measurement of the v6 matching contract: 10.4 s/note, ~1,044 output tokens/call (`docs/kpi-golden.md`).
- [x] Reference libraries: golden-small public manifest (licenses + SHA-256 only in the repo) with AI
      cassettes recorded on a small subset via the current route; read-only golden-private snapshot (never
      versioned); a large public corpus of 5-20k notes with real embeddings for tree calibration
      (done: 18,632 Wikipedia pt/en pseudo-notes, MLX embeddings; golden-small recorded with cassettes:
      10 roots, 2,477 calls, 79.8 min; replay exact on the 2-source dry run, full replay diverges on retry
      timing until F1a — `docs/kpi-golden.md`).
- [x] Backup restore path into a scratch sidecar, with a verification script (`npm run db:restore`).
- [x] e2e harness reusing the existing `phase4:e2e` (repaired; now also covers captures, atomic import,
      batch release and empty-content refusal).
- [x] Spike A: Qwen3-Reranker-0.6B on the MLX helper (yes/no logits), then GGUF `createRankingContext`, then
      bge: artifact check, smoke, AUC on human labels, ms per 250-300-token pair on the owner's Mac.
      Result `docs/spikes/spike-a-reranker.md`: conditional GO for MLX scoring both directions (held-out
      27-28/28, 0/35; 36 ms/pair; 3.6 min for 200 notes x 20 both ways); GGUF Qwen3 fallback; bge rejected.
      Open for F3: 32% loss of reverse-only acceptances vs the ≤5% target.
- [x] Spike A2: OpenAI Decisions API on the same protocol (`docs/spikes/spike-a2-decisions.md`): ties at root
      level, best direction stability, ~0.2 s/request, ~US$ 0.03-0.04 per 1k pairs, order/composition
      sensitive; candidate optional tiebreaker for the MLX uncertain band (F3 bake-off decides).
- [x] Spike B: offline k-means tree over real embeddings; shape metrics, ambiguity rate, HTML page with 30
      sampled topics for the owner. Result `docs/spikes/spike-b-topic-tree.md`: conditional GO for the
      Louvain-kNN builder (100% reachability; owner 25/30 coherent, 23/30 well named); top two levels weak
      and seed-dependent; ambiguity ≤30% only for known topics (new topics 28-48%), so the bar is re-based in F2.

Exit: `npm run check` green with the baseline; `docs/kpi-baseline.md` recorded; cassette replay
deterministic at $0; Spike A GO at p50 ≤75 ms/pair (4-minute target for 200 notes) or ≤150 ms/pair (8-minute
target), otherwise the fallback is recorded; Spike B GO at 100% reachability, ≥70% of 30 topics rated
coherent by the owner and ambiguity ≤30% *(cal.)*, otherwise retune (Louvain over kNN) before F2.

### F1a Stop the bleeding (weeks 3-4)

- [x] Lossless feasibility filter before rerank; skip the call when nothing remains.
- [x] Decision-only matching contract: explanation only for accepted pairs, partial acceptance with one
      repair, reasoning off on the decide route.
- [x] `relation_decisions` (raw scores per direction, hashes, decider) as a lossless cache, with a per-note
      checkpoint.
- [x] Remote fetch deadlines and stream watchdog; classified retry with backoff; priority classes in the
      current queue; Ask timeout counted from admission.
- [x] A failed or canceled sibling no longer blocks batch matching.
- [x] Import defaults ("Second brain" when a writer route is ready, else searchable), open the source after
      import; seed all routes from the first profile; stop tagging generative models as rerankers.
- [x] Re-embed notes after human edits; batch wiki link resolution; keep Library mounted; stabilize graph
      callbacks; graph pass on notes and claims off by default.
- [x] Legacy wiki stopgaps only if needed before F2 (decision 4 freeze, ≤0.5 day each): weekly/monthly
      routines and the OS idle gate off by default, never persist a null parent. The old F1 maintenance exit
      criteria (0 coverage changes on settings save; other routines run after an injected failure) are
      dropped by decision 4: routines are replaced in F4.

Exit (re-based by decision 15): matching per note ≤1/3 of the v6 baseline, fixture 0/35 forbidden and
≥27/28 expected on notes or sources (measured: 2.96 s/note, 0/35, 27/28; note layer 22-24/28); injected
sibling failure does not delay others; 0 new orphan roots; 100% of new interactive imports produce chunks
and notes; a 200-link page makes ≤2 IPC calls per cycle; Ask during import has 0 timeouts and waits for at
most one in-flight call.

### F1b The bridge (weeks 5-6)

- [x] `objects.locate` (stable contract) and a "Where is this" panel on sources and notes.
- [x] Note page v1 as the definitive object-page component, hosted in the Library.
- [x] Decide-only compact matching contract v9 and on-demand, cached relation explanations (decision 16);
      decide calls without the reasoning summary if the backend accepts it.
- [x] Source matching per decision 17: each source pair judged once; compact score-only `source-relations-v5`
      with raw scores stored and explanations written on open; spike of the F3 discovery design on unjudged pairs.
- [x] Citations open the exact chunk and SourceSpan.
- [x] `tokens.css` (light, dark, system), Inter + Source Serif 4 bundled offline, AA accents; application
      menu (⌘W closes a panel); local view-history store.
- [x] Static HTML mockups of 8 key screens (Home, Topic, Source, Note, Cmd-K, Inbox, Activity, Map) approved
      by the owner.

Measured: `objects.locate` p95 0.75 ms on the restored fixture library and 0.90 ms on a seeded 30,000-note
library; 326 token pairs pass AA in both themes; mockups approved on 2026-10-15
(https://claude.ai/artifact/SDrknF4YwtDLdzGF4iwmKG).
`notes.page` p95 3.15 ms on the seeded 30,000-note library (187,274 relations, hubs of 400) and 2.28 ms
on the restored F1a fixture (`scripts/objects/note-page-benchmark.ts`, no sequential scan of a large
table); a note shows its location with 0 clicks on its page and 1 click from a card, search, the graph,
recents or the wiki. Relation explanations are written on open and cached per inputs
(`relations.explain`, migration 0049). Matching v9 without the reasoning summary: golden library 2.75 s/note
(26% of v6); fixture samples 24/28 and 23/28 on the note layer, 27/28 on notes or sources, 0/35 forbidden,
2.08-2.34 s/note (`docs/kpi-f1b.md`). Source matching v5 with `recommended-v2` floors (0.75/0.85, re-tuned on
tuning): golden 10.85 s per source (−29%), fixture 16.21-16.51 (−20%, the bar was 16.2), source layer
held-out 26 and 27 of 28, tuning 26/26, 0 forbidden; accepted by the owner on 2026-10-15 with no margin left;
the F3 spike rejected all 13 untested forbidden pairs and recovered Q3/Q5.

Exit: `objects.locate` p95 ≤50 ms; a source or note shows its location in 0-1 click; token contrast check
passes AA in both themes; mockups approved; golden note matching ≤3.47 s/note with fixture quality within the
v8 range (0/35 forbidden, ≥27/28 on notes or sources); source matching ≤16.2 s per source on the fixture and
≤13.8 on the golden library with 0 prose tokens and the source layer at ≥27/28 held-out, 0/35 forbidden.

### F2 Topic Tree Engine (weeks 7-11)

Decisions D1-D40, the owner-question defaults Q1-Q13, the gates and the measurement rules:
`docs/f2-decisions.md` (decision 18). The legacy wiki is wiped early, at gate W, under the owner's
authorization of 2026-10-15 (D37). Tasks run in waves: the tasks of a wave run in parallel in separate
worktrees, a shared file has one owner at a time in task order, removal tasks yield to engine tasks on shared
files, and a proof that starts the DEV app or a local model takes that slot (one holder at a time). Gates stop
the line: W wipe safety (end of wave 1b), A engine parity (end of wave 3), B persistence parity (wave 5), P
owner preview (non-blocking, after wave 5), C quality (end of wave 7; closes F2).

Wave 0:
- [x] T00 Decision record: D1-D36 and Q1-Q12 (`docs/f2-decisions.md`), the re-based ambiguity bar and rating
      rule, these task boxes.
- [x] T00b Early legacy wipe recorded (owner, 2026-10-15): D37-D40, Q13, gate W and these task boxes.

Wave 1:
- [x] T01 MLX helper `embed` and `score` protocol in one shared helper process, with memory limits.
- [x] T02 Job lanes (migration 0051): `jobs.lane` and `jobs.dedupe_key`, one heavy loop and two light workers
      (`compute`, `model`), with the Background jobs section of `rules/architecture.md` in the same change.
- [x] T03 Pure engine core in `packages/domain/src/topic-tree/` (complete config, state and event vocabulary;
      exact stats, invariants, k-means, kNN, Louvain build, metrics) with property tests.
- [x] T04 Legacy wiki state is never created on a library without legacy content (D3).
- [x] T05 Restore-verified backups with snapshot-consistent counts.

Wave 1b (the legacy wipe; gate W at the end):
- [x] T10 Ask answers from notes and chunks only, without the legacy wiki or organization domains; its save
      and investigation writes are fenced (D13).
- [x] T35b Legacy automation unwired (startup and reset defaults, ticks, legacy job executors, the golden
      pause) and its IPC writers fenced (D3).
- [x] T35a Legacy detach (migration 0052): impact triggers dropped (D5), the legacy insert fence (D40),
      `organizeKnowledge` leaves ingestion (D14).
- [x] T36w Verified, recount-guarded legacy wipe service and its one-shot DEV knob (D4), with
      `rules/data.md`.
- [x] T21w Wiki empty state hosting Ask; the Automation and Organization entry points hidden (D38).
- [x] T34a Old wiki projection files retired through the managed recovery flow.
- [x] T37w Wipe rehearsal on a clone of the DEV profile, then the DEV wipe (D37): verified `pg_dump` backup
      and a cold copy of the database, then the wipe of the wiki, organization, curator and maintenance data
      (decision 4).

Wave 2:
- [x] T06 Dedicated MLX and GGUF ranker adapters with artifact validation; generative models lose the
      `reranking` tag (D17).
- [x] T07 Deterministic PLACE, gate rule, secondaries, root vector, human operations and exact undo (pure).
- [x] T08 REBALANCE, stability controls, audit and Hungarian rebuild mapping (pure).
- [x] T09 Offline replay (chronological, shuffled, by domain), Louvain detector and calibration harness.
- [x] T38r Remove the legacy wiki, Automation and Organization screens (Q12); the Wiki screen becomes the
      shell that hosts the empty state.

Wave 3 (gate A at the end):
- [x] T11 Qwen3-Reranker catalog entries, MLX and GGUF (revision, size, license, SHA-256), validated for
      `decide` on install.
- [x] T12 Topic tables (migration 0053) and the engine write repository: guarded single writer, minimal
      change-sets, exact undo, deletion by cascade (D9, D32).
- [x] T12b Paged topic skeleton and vector loading.
- [x] T13 Clustering worker with transferred vectors.
- [x] T39r Remove curator placement and its "Index of X" pages, route continuation, the organization and
      maintenance services, legacy IPC and job types, and T35b's IPC fences.

Wave 4:
- [x] T14 AiService ranker execution, explicit workload-class routes (`decide`, `write-fast`), minimal model
      residency (Q11) and the embedding-space key, with `rules/ai.md`.
- [x] T15 Topic service: ensures an active tree (D39), PLACE and sweep on the light lane, `topicsChanged`
      push.
- [x] T16 Topic read repository, IPC contracts and push channel.
- [x] T17 KPI and audit scripts on topics (`topics:audit`).
- [x] T22a Measurement profiles, `topics:export`, G1 and the topic barrier for golden runs (D23).

Wave 5 (gate B after T15b and T19; owner preview P at the end):
- [x] T15b Place, unplace and repair on every note and source change.
- [x] T18 Naming in the content language (LLM; content-language TF-IDF fallback) and topic label vectors.
- [x] T19 Bootstrap of any library with the Louvain-kNN builder (Spike B winner), rebalance and audit jobs,
      structural rebuilds (D39).
- [x] T20 Navigator v2 (counts, notes and sources as leaves, pins, recents, Unsorted, status line) in the
      Wiki screen, replacing its empty state and keeping the Ask entry.
- [x] T21 Topic page with a deterministic map of content.
- [x] T22b Corpus environment and developer comparison report (`topics:report`, D21).

Wave 6:
- [x] T23 Reranker decision gate for ambiguous placements (D10).
- [x] T24 Area grouping into 7-16 pinnable Areas (D12) and mis-parent re-parenting.
- [x] T25 Shape icicle with a table alternative; warnings with Apply and Dismiss (D29).
- [x] T26 Human structure operations (rename, move, create, pin) with undo and review.
- [x] T27 `objects.locate` on the topic tree (D24).
- [x] T33 Obsidian topic projection replacing the wiki page branch: folder-note MOCs, aliases from redirects,
      paged delivery on the light lane replacing the fixed caps, with `rules/integrations.md`.

Wave 7 (gate C at the end):
- [x] T28 Ask about a topic.
- [x] T29a Calibrate placement and the gate per decider: admission, margin, gate temperature and threshold.
- [x] T29b Calibrate stability, growth and structure; adopt the config defaults.
- [x] T29c Gate C measurement (E1-E3 on the evaluation seeds, E6).
- [x] T30 Owner blind rating (D20).
- [x] T31 Lazy topic overview (migration 0054) written on open, with verified citations.
- [x] T32 Zero-config end-to-end test (`topics:e2e`).
- [x] T19b Embedding-space change with re-embedding and an ID-preserving rebuild (D26).
- [x] T34b `memora://topic/<id>` deep links that resolve topic redirects.
- [x] T40r Remove legacy repositories, schemas, prompts and scripts; update `rules/knowledge.md`.

Wave 8 (exit):
- [x] T41 Exit measurement (`docs/kpi-f2.md`) and phase close.

Exit (E1-E6, on the pre-registered evaluation seeds with the calibrated configuration): reachability 100%, 0
orphans and 0 hard violations after REBALANCE; mean depth ≤4.5 and ≥80% of internal nodes with 4-9 children
*(cal.)*, also on the corpus after Areas grouping (the root is reported apart); primary-path churn ≤3% per
week in replay *(cal.)*; owner blind rating: ≥24 of 30 topics rated both coherent and well named in the
content language (D20; both marginals reported); undo restores exact placements; empty database + 1 model + 1
PDF yields notes in named topics without opening Settings (e2e; one AI profile from the first-run path plus
the default local embedding model, Q4). Reported, not gating: the ambiguity bar, re-based from F0's ≤30%
(D19) *(cal.)*: auto-placement precision ≥90% on known topics, ≤50% of new-topic notes gated, gate p95
≤0.3 s per gated note (target 0.2 s), with gate precision on new topics against margin-only placement.

### F3 Relations v2 and AI runtime lanes (weeks 12-15)

Decisions D1-D47, the owner-question defaults Q1-Q20, the gates, the measurement rules and seeds:
`docs/f3-decisions.md` (decision 22). Tasks run in waves as in F2: the tasks of a wave run in parallel in separate
worktrees, a shared file has one owner at a time in a fixed order, and a proof that starts the DEV app or a local
model takes that slot (a DEV-app proof that loads a local model takes both). Measurement comes first and the
configuration freezes late: M0 offline at $0 (wave 1), M1 with provisional settings on the tuning partition (wave
2), M2 on the frozen configuration (wave 4). Gates stop the line: 0 measure first (end of wave 1), M migration
safety (wave 1, run by the orchestrator before any real profile starts with the F3 migrations), R slice works (end
of wave 2, tuning only), F freeze (wave 3), P pre-soak (end of wave 3), X exit (wave 4; closes F3).

Wave 0:
- [x] T42 Decision record: D1-D47 and Q1-Q20 (`docs/f3-decisions.md`), the gates, the measurement rules and seeds,
      the pre-registered selection and gate-0 rules, X7-REF, these task boxes.
- [x] T43 Measurement harness: the `--gate f3` evaluator with the freeze guard and the pre-freeze feasibility mode,
      offline re-scoring, reverse-only loss, calls per chapter and tuning candidate recall.
- [x] T43b v9 end-state backups mapped and the R_v9 capture (ENV-F's pre-F3 note relations).

Wave 1 (gate 0 and gate M at the end):
- [x] T44 M0: offline re-score of the pinned matching runs, tuning candidate recall, the graph call split, B4 and
      the throughput forecast (`docs/spikes/f3-m0.md`).
- [x] T45 Label set and the blind three-judge panel (decision 21) replacing the owner-labeled pairs: about 300 note
      pairs from public and synthetic text, the source pairs, R_v6 and the R_v9 sample.
- [x] T46 Pair scoring harness: bake-off scores through the product adapters, verdict-only v9 note-pair scoring
      and B1.
- [x] T47 AiScheduler (migration `ai_task_run_lanes`): one local lane and adaptive remote lanes, priorities with
      aging, deadlines on every runtime, retries off the lane; remove `ai-execution-queue.ts`; `rules/ai.md`.
- [x] T48 Relations schema v2 (migration `relations_v2`): canonical note pairs with an explicit direction, bands
      apart from review, the veto, the typing cache, the score scale and one visibility module; `rules/knowledge.md`.
- [x] T48b Append-only relation events and match runs with exact revert.
- [x] T48m Gate M (the orchestrator): verified DEV backup, cold copies, a rehearsal on a DEV clone and the
      migration startup cost.
- [x] T49 Indexed retrieval SQL (migration `relation_retrieval_indexes`): `search_tsv`, raw-distance partial HNSW,
      EXPLAIN gates.
- [x] T50 Ranker `pairs` input for both-direction scoring, product parity, and re-validation with a score-parity
      check on every runtime-build change.

Wave 2 (M1 and gate R at the end):
- [x] T47b Circuit breaker per remote lane and the lane probe (B5).
- [x] T51 Relations v2 matcher: the local ranker decides both directions with calibrated bands; the note decider
      mode and the wait for a validated ranker.
- [x] T51t Typing batched per source, with `none` as a veto.
- [x] T52 Per-source matching with no batch barrier and the `relation-link` job on a light `relations` worker;
      the untyped fallback, the daily relation cap and the stage-level retry; `rules/architecture.md`.
- [x] T52b Re-match harness with an arrival fence and recorded-timing replay.
- [x] T53 Source relations by design E (decision 17): promotion of typed applied note relations, nearest-source
      discovery judged once with F1b's compact verdict; the shortlist and the Cartesian trigram join deleted.
- [x] T54 Workload classes on every caller, legacy route mapping, Local / Hybrid / Cloud presets and Settings › AI
      by class with a "Generative judge" row.
- [x] T55 Schema output in every runtime, item-level repair, graph salvage, graph batches by writer locality and
      the extraction pin; claims stay stopped.
- [x] T56 `embedMany` and hot-path caches.
- [x] T57 Campaign M1 (tuning partition only).

Wave 3 (gate F after T58; gate P at the end):
- [x] T53b Note-matching settings cleanup (settings migration).
- [x] T53f Backfill of missing hierarchy-root composites for existing libraries (found by T53's proof).
- [x] T53h A book's header follows its summary; large summaries batched by the writer's window (decisions 27, 28).
- [x] T53p Typed suggestions promote to suggested source relations (decision 29).
- [x] T53d Automatic relations carry no direction until the owner or a clear decider gives one (decision 31b).
- [x] T55k A failed graph stage no longer stops matching; E6 re-recorded under F3.
- [x] T58 Bake-off analysis and frozen calibration (gate F): decision-only generative, Qwen3-Reranker-0.6B on MLX
      and GGUF, bge-reranker-v2-m3 as a control, OpenAI Decisions on synthetic text (`docs/spikes/f3-bakeoff.md`).
- [ ] T58e (superseded by decision 29: the rule rejected it; revisited only if a decider test changes decision 29) Uncertain-band escalation, planned since gate 0 (the owner kept X1 at ≥27/28; f3-decisions "Gate 0 outcome").
- [x] T59 Streamed `relation.explain` with cache and the NOT_RELATED veto.
- [x] T60 Evidence card v2 on the Note page, the `relations.review` writer and the relations push.
- [x] T60g Ego-graph v1 on the Note page (graph canvas extracted from the dashboard, colours from tokens).
- [x] T61 Residency group sizing, idle unload of the generative model, MLX helper `unload`, `cancel` and streaming,
      local deadlines from measured p99.
- [x] T62 Soak harness with fault-injecting fake remote providers, and the 4 h pre-soak (gate P).

Wave 4 (gate X at the end):
- [x] T63 Campaign M2: X1-X5, X7 on X7-REF and S1 on the frozen configuration.
- [x] T64 24 h soak (X6), run by the orchestrator.
- [x] T64r Soak report and failure audit.
- [x] T65 Rule, stack and runbook sync (`rules/`, `STACK.md`, `docs/golden-library.md`).

Wave 5 (exit):
- [x] T66 Exit measurement (`docs/kpi-f3.md`) and phase close.

Exit (X1-X7 and S1 as defined in `docs/f3-decisions.md`, on the frozen configuration): fixture ≥27/28 expected on
the note layer over pinned notes (mean of four samples), 0/35 forbidden; ≤5% loss of today's reverse-only
acceptances (R_v6 and R_v9); 200 notes end to end in ≤4 min with the MLX ranker and ≤8 min with GGUF (Hybrid;
today ~40 min); 0 prose tokens for rejected candidates; a failing source does not delay siblings; 24 h soak with 0
calls past deadline and repairs ≤2%; ≤40 generative calls per reference chapter *(cal.)*, measured on X7-REF;
source matching ≤5 AI-call seconds per source with design E's quality bar (S1).

### F4 Gardener, Inbox, Activity and first run (weeks 16-18)

Decisions D1-D38, the owner's answers to Q1-Q13 (2026-10-23), the gates M, S and X, the exit and carried bars
(E1-E7, C1-C4) with their data and methods, decision 32's "close" and remote spend, the 7-day soak plan and the
budget: `docs/f4-decisions.md`; it binds F4 (decision 33) and, where section 4 differs, it wins. Tasks run in waves
as in F3 (separate worktrees, one owner per shared file in a fixed merge order, a proof that starts the DEV app or a
local model takes that slot). The 7-day Hybrid soak is the calendar spine: everything it tests merges before gate S,
wave 3 too (owner, 2026-10-24; T99 joins if its proofs pass first), and the proofs that need the slots follow it
(D1, D2).

Wave 0 (folded into wave 1's start when F4 began on 2026-10-23):
- [x] T67 Decision record (`docs/f4-decisions.md`): D1-D38, Q1-Q13 with the owner's answers, gates, bars, soak plan,
      budget, decision 32's pre-registration, these task boxes.
- [x] T72 F3 follow-ups: catalog callers state their output contract (strict for remote typing and overview), a bare
      AbortError with a live job is transient, the MLX helper's protocol shutdown.

Wave 1 (W0 spill, foundations, the five migrations; T87, T88 and T99 start; gate M at the end):
- [x] T68 Settings inventory (decision 24, `docs/settings-inventory.md`): reader, default, fate; the dead ones marked.
- [ ] T69 Prompt-replay harness and the record-only local-writer benchmark (decisions 25, 26).
- [ ] T70 Runtime-upgrade spike (mlx-swift-lm 3.32.3, node-llama-cpp 3.22.2), record only.
- [x] T71 $0 pre-checks: the two-neighbour replay and the merged-entity statistic (C1's baseline).
- [ ] T73 Delete the test models and the benchmark transients.
- [x] T74 Gardener task state, scope exclusion, outcome cache and quarantine (migration 0060).
- [x] T75 Background policy: controls, gates, blockers, duty cycle, power signals.
- [ ] T76 RemoteBudget and the price table (migration 0061); the Decisions ledger probe (Q12).
- [x] T77 Change-set read model, risk, retention and the changes IPC (migration 0062).
- [x] T78 Drop the legacy tables, their fence and guards (migration 0063, after T82's backups).
- [x] T79 Ask stored text vectors and the candidates measurement (migration 0064; C3).
- [x] T80 Cancel a running Ask statement; the Retry-After wait (Q2).
- [x] T81 Event bus with job and download events (three polls removed).
- [x] T82 Gate M (the orchestrator): heads, backups, rehearsal, migration times.

Wave 2 (tasks, status, harnesses; C1 and C2; gate S at the end):
- [ ] T83 MATCH on note edits and accepts.
- [ ] T84 REFRESH: additive overview patches with Divergences and versions; explanation backfill.
- [ ] T85 AUDIT extensions: duplicates, broken links, stale embeddings, rolling re-placement, theme drift.
- [x] T86 Status service and sentence.
- [ ] T87 Entity identity grouped per source and raw-batch checkpoints (C1, X7 ≤40).
- [ ] T88 Batched source judge and two neighbours (C2): C2 missed its microbenchmark (LIB2 10 of 27 accepted, bar
      ≥12), so D21's registered fallback applies (one neighbour), and the source judge returns to `perPair`
      (orchestrator, 10-24); S1 and X3 at two neighbours not run.
- [x] T89 The 7-day soak harness (real Codex writer knob, token cap, zero-token faults, ground truth).
- [ ] T90 First-run Hybrid e2e harness and the live clean-install record (E6).
- [ ] T91 Gate S, 5 h pre-soak with calibration (the orchestrator).

The soak (from 2026-10-28):
- [ ] T92 The 7-day Hybrid soak with the real Codex writer under a token cap (the orchestrator).

Wave 3 (merges before gate S, owner 2026-10-24; T99 before the soak only if its proofs pass first):
- [x] T93 Activity pill and drawer.
- [x] T94 Inbox with the keyboard flow.
- [x] T95 Icicle diff.
- [x] T96 Three-step onboarding.
- [x] T97 Hardware probe and tier table (decision 25).
- [x] T98 Settings › Knowledge and the cut; matching to Advanced › Matching (Q4).
- [ ] T99 JSON-constrained decoding in the MLX helper (decision 31a).
- [x] T100 Rules, stack and docs sync.

Wave 4 (after the soak; C4 and E6):
- [ ] T101 Soak report and failure audit (E1-E5).
- [ ] T102 Decoder model proof and the Local 24 h re-run (C4; decision 32's remote check if close).
- [ ] T103 First-run e2e gate on final code (E6).
- [ ] T104 DEV proofs, screenshots and the settings count (E7), with the DEV app on a scratch clone (data root
      overridden, autonomy Off; decision 34).

Wave 5 (exit):
- [ ] T105 Exit measurement (`docs/kpi-f4.md`) and phase close.

Exit (E1-E7, and the carried bars C1-C4, as defined in `docs/f4-decisions.md`): 7-day soak (start by week 17)
with injected writer rejections, timeouts and a mid-run cap: 0 tasks blocked by another, quarantine ≤1%, ≥95%
completed within 24 h; remote cap respected within one call; the status sentence explains 100% of non-running
states; clean Hybrid install places and connects the first note in ≤10 min (e2e); ≤6 visible automation settings
(from 37+).

### F5 Unified workspace (weeks 19-22)

Decisions D1-D32, the owner's answers of 2026-11-11 and the defaults Q4-Q21, the gates D, M, U, J and X, the exit bars
X1-X12 with their data and methods, the slot plan, remote spend and the budget: `docs/f5-decisions.md`; it binds F5
and, where sections 4-6 differ, it wins. Tasks run in waves as in F4 (separate worktrees; IPC by area with one wiring
card per wave and a fixed chain for every other shared file; a proof that starts a Memora Electron or a local model
takes that slot). F4's close runs beside F5 from its own branch and worktree (D3). Every UI box is ticked only with its
gate U records: fixture screenshots before merge and live screenshots on a scratch profile (D1).

Wave 0 (decisions and design, 2026-11-11):
- [x] T106 Decision record (`docs/f5-decisions.md`) and these task boxes.
- [ ] T107 Settings v2 mockups, published as a private artifact (synthetic data, both themes, two widths).
- [ ] T108 Design record (`docs/design/f5-workspace.md`) from the four seeded candidates, three judges and the
      synthesis (gate D).

Wave 1 (foundations, model-free, no new dependency; gate M at the end):
- [ ] T109 Held-out settings queries, written blind before the registry's keywords (X9, X10).
- [ ] T110 Whole-catalog i18n parity test with the identical-to-English allowlist (X6).
- [ ] T111 Startup guard: no pending migrations on the default userData without the owner knob; blank or relative
      `MEMORA_USER_DATA_DIR` refused (decision 34).
- [ ] T112 Scratch-profile mode of the matching pilot and benchmark runners and their scripts; the matching docs
      unfrozen.
- [ ] T113 Event bus v2: per-type windows, sticky replay, `appEventPort`, the new event types.
- [ ] T114 `object.changed` publishers.
- [ ] T115 The other publishers (view, settings, database status, Obsidian, monitoring, explanation deltas).
- [ ] T116 Questions: migration 0066, repository and citation hashes.
- [ ] T117 Search indexes: migration 0067.
- [ ] T118 Objects read layer: `get`, `resolveMany`, `backlinks`.
- [ ] T119 `objects.locate` for topics and entities.
- [ ] T120 Workspace state and the `memora://` router (pure), with the legacy deep-link forms.
- [ ] T121 Ask streaming and persistence in main.
- [ ] T122 Parallel calls inside one import (`mapInOrder`, lane concurrency, fixed 12/12 caps).
- [ ] T123 Remove the cumulative graph-cap settings.
- [ ] T138 Screens tool and the four-state check (X5).
- [ ] T169 SEED30K as a persistent scratch cluster; the benchmarks' profile server.
- [ ] T170 Wave 1 IPC wiring.

Wave 2 (services, journey harness and shell; the four new dependencies at its start):
- [ ] T124 Design-system primitives on the tokens (Radix and cmdk wrappers).
- [ ] T125 Event consumers; the six side channels retired.
- [ ] T126 Pollers replaced by events; the ratchet at 0 and 0 (X4).
- [ ] T127 `search.omni`.
- [ ] T128 Cmd-K service benchmark and EXPLAIN gate (X3a).
- [ ] T129 Question reads and `locate(question)`.
- [ ] T130 `home.digest`.
- [ ] T131 `library.rows`.
- [ ] T132 `entities.page`.
- [ ] T133 `relations.branch`.
- [ ] T134 `topics.history` and Shape depth 7.
- [ ] T135 Shell chrome: title bar, five-destination rail, navigator host, menu.
- [ ] T136 Panel stack with per-panel history and the path ribbon.
- [ ] T137 Playwright-Electron journey harness, gesture counter, IPC trace, contrast scan.
- [ ] T171 Wave 2 IPC wiring.

Wave 3 (surfaces):
- [ ] T139 Source page extraction.
- [ ] T140 Source panel, live.
- [ ] T141 Note and Topic panels, Explore, Obsidian deep links.
- [ ] T142 Inbox and Map hosting; Map › Shape with growth.
- [ ] T143 Context panel: Connections, Mentions, Evidence, Graph.
- [ ] T144 Hover previews, citation passages, quick-look and Markdown links.
- [ ] T145 Cmd-K and the search results panel (X3b).
- [ ] T146 Ask panel and the Question page.
- [ ] T147 Entity panel.
- [ ] T148 Home, with the Shape strip.
- [ ] T149 Library table (Sources and Questions).
- [ ] T150 Add flow, window drop and the advanced import panel.
- [ ] T151 Map › Relations canvas and topic colour tokens.
- [ ] T152 Map › Relations table, super-nodes and the lens.
- [ ] T153 Atlas spike, record only (`docs/spikes/atlas-f5.md`).
- [ ] T173 Context panel: Activity and Ask.

Wave 4 (journeys, removals, settings data; gate J before the removals):
- [ ] T154 Journeys J1-J3 and the idle proof (X1, X2, X4, X7).
- [ ] T155 Journeys J4-J6 and J8, with Inbox triage asserting Keep, Remove and Dismiss in their stores.
- [ ] T156 Remove the Review queue, Search, `search.query` and the dead wiki browsers.
- [ ] T157 Remove the old Knowledge Graph screen.
- [ ] T158 Remove the old Library view, Wiki root, RecentObjects and the Ask dialog.
- [ ] T159 Settings registry v2 and its reader test (X8, X11).
- [ ] T160 `settings.describe` and `settings.reset`.
- [ ] T172 Stop the writes to the dead AI profile columns.
- [ ] T175 Settings registry copy (labels, help, keywords in 5 locales).

Wave 5 (Settings v2 build):
- [ ] T161 Settings shell, search and "changed from default" markers (X9).
- [ ] T162 General, Library and Privacy sections.
- [ ] T163 AI section with This Mac (decision 25).
- [ ] T164 Knowledge and Integrations sections.
- [ ] T165 Advanced and Diagnostics.
- [ ] T174 Journey J7, Settings (X10, X12).
- [ ] T166 Remove the old settings screens, Jobs, Monitoring and the Debug list.
- [ ] T167 Rules, stack and docs sync.

Wave 6 (exit):
- [ ] T168 Exit measurement (`docs/kpi-f5.md`) and phase close.

Exit: import to seeing notes and their path in ≤2 clicks (today ~10-12); any object shows its path with 0
clicks; Cmd-K p95 ≤100 ms; 0 pollers; every screen covers loading, empty, error and success; i18n parity in
all 5 locales; 5 destinations; Settings v2 with ≤7 sections, every setting found by its search and reached in
≤2 clicks from the rail, 0 settings that no code reads, AA in both themes. F5 exit is automated only
(decision 34).

### F6 Lenses, lean ingestion, consolidation (weeks 23-26)

- [ ] Atlas only if F5's spike shows contiguous branches; branch mind map (the scoped Relations lens and Shape
      moved to F5, owner 2026-10-19).
- [ ] Windowed ingestion under A/B on a golden-small clone.
- [ ] Finish the design system (primitives, raw-class codemod, pt-BR accents); sigma 4 migration spike with
      go/no-go.
- [ ] Nightly KPI runner (today only `scripts/kpi/kpi.ts` exists) on scratch profiles only, never the owner's
      profiles: the reference profiles are the golden-small clone, the ENV-C corpus clone, a soak-style
      synthetic profile and an ENV-G clone. Before the first counted night (D3), `docs/kpi-f6.md` pre-registers
      the profile list, which section-8 KPIs run nightly and their bars, the per-night procedure (a fresh APFS
      clone per base, cassette replay with remote misses failing the run, spend 0 unless the owner approves),
      what counts as inconclusive, and that any change under `apps/desktop/src/main` or `packages/` after
      night 1 restarts the count.
- [ ] Keep/Remove label export from the D29 stores and `relation_decisions`, extending F5's Inbox triage
      journey to read its stored verdicts back through the export; a dry-run recalibration of bands, thresholds
      and the typer on the decision-21 panel labels plus synthetic labels on scratch data (reported, not gating;
      decision 29), so real labels meet tested code in F7.
- [ ] Remove remaining legacy code; move remaining numeric defaults into typed config with tests. No stability
      window, since the legacy code was never used (owner, 2026-11-11; until then "after 2 weeks of stable
      KPIs"). `docs/kpi-f6.md` lists the removal scope before removal, checked statically (no imports of the
      listed legacy modules; any legacy table dropped with the row verification of `rules/data.md`). Removal
      needs a restore-verified backup (dump plus APFS cold copy of every reference profile) and the rollback
      tag `f6-pre-legacy-removal`, created just before removal and kept until F7 closes (owner request,
      2026-11-11, per `RULES.md`).
- [ ] Full `npm run check` and e2e on the post-removal code.
- [ ] Clean-install first-run e2e on the final build (the commit gate T tests, which is also the trial
      worktree's commit), with F4 E6's bar: `npm run firstrun:e2e`, each of two replays plus D ≤ 10:00.
- [ ] Optional final Hybrid soak on the F6 build (about 1.4M Codex tokens for 72 h): an open owner spend
      decision with no default spend; it runs only on the owner's yes and gates F7 only if it runs; green means
      F4's soak bars (the X6 stop lines and E1-E5, with D3's no-second-run rule).
- [ ] A one-page trial guide in Portuguese (pt-BR): the exact start command (below, F7), what to try, and how to
      report a finding with its severity. The owner never runs a bare `npm run dev` on the default profile.

Exit: ≤15 generative calls per reference chapter with note quality within 5% in the A/B *(cal.)*; raw
palette classes ≤200 (from 1,854, measured); AA in both themes; legacy code removed; KPIs green on 7
consecutive nightly runs on the post-removal build, on scratch profiles; full check and e2e green; the
clean-install first run green. F6 exit is automated only (decision 34).

### F7 Owner trial and fixes (after F6)

The owner tests the complete app after legacy removal and agents triage and fix what comes up (decision 34;
stage name approved by the owner, 2026-11-11).

Entry (gate T, automated, run by the orchestrator): F6 exit met and legacy code removed; KPIs green on 7
consecutive nightly runs on the post-removal build; full check and e2e green; the clean-install first run
green on the final build; a restore-verified backup of the reference profiles; the trial guide ready, with
its exact start command proven on a scratch path (it opens an empty userData); the optional final soak green
only if the owner approved it. The final build is the commit gate T tests.

- [ ] Gate T, recorded in `docs/kpi-f7.md`.
- [ ] The trial: the owner runs the final build from a separate worktree pinned at that commit (as F4 D1's soak
      worktree was), started with `MEMORA_USER_DATA_DIR` set to an absolute folder outside the repository and
      `.cache` (the F7 trial profile), and adds their own sources after onboarding (F4 D31). Trial defaults,
      carried from Q11's safeguards: autonomy Suggest (Settings › Knowledge) and a cap of 200 background Codex
      calls a day for the first week; the owner may choose otherwise at the start. The owner's DEV profile
      (only the golden library) stays as it is: not upgraded, not re-matched; any later upgrade only on a new
      owner request (`docs/f4-decisions.md` Q8, Q11). If DEV is opened by mistake, Q9's `dev-database-pre-f4`
      cold copy is the rollback.
- [ ] Fixed builds reach the trial profile only at explicit update points: the app stopped, a restore-verified
      backup of the trial profile, and, if the build carries a migration, gate M's rehearsal on a clone of it
      with remote routes blocked (F3 D44); then the trial worktree moves to the fixed commit. Rollback is by
      restore. Agents' fixes never reach the running trial through the watcher.
- [ ] What the owner tries (the trial guide): importing their own sources, reading topics and following
      relations, Ask and jumping to a citation, Inbox triage with real Keep, Remove and Dismiss, Settings v2
      and the Map lenses; optional: rating tree quality and a felt-disturbance question.
- [ ] Triage: each finding becomes a card with a severity (1: data loss, crash or a blocked journey; 2: a main
      journey wrong with no workaround; 3: a workaround exists; 4: cosmetic). An agent reproduces it on a
      scratch profile or a clone (a clone of the owner's profiles is made only from a stopped profile or a
      restore of its dump, with remote routes blocked, and deleted when the card closes), fixes it with a test
      on synthetic fixtures, never owner text, and proves it with `check:changed` on scratch profiles; the
      owner re-checks only what they flagged. A regression stops the line (decision 23). A severity-1 or
      severity-2 finding whose fix needs a model, quantization or runtime change goes to the owner as a
      decision-26 exception or is re-scoped.
- [ ] The nightly KPI runner keeps running through F7, on each fixed build.
- [ ] Recalibration of bands, thresholds and the typer from the real Keep and Remove export (decision 29),
      recorded.
- [ ] X2 revisited with real verdicts (decision 31d).
- [ ] The real undo rate on automatic structure (≤5%) and the owner-library KPIs (section 8), reported.
- [ ] Decision 26's model, quantization and runtime adoptions put to the owner with the trial's findings.

Exit: the owner accepts the app; no open severity-1 or severity-2 finding; full check and e2e green on the
fixed build; the nightly KPIs green on 3 consecutive runs on the fixed build and the clean-install first run
green on it; recalibration results recorded. Then the owner decides on the rollback tag
`f6-pre-legacy-removal`, the F3/F4 cold copies (`docs/f4-decisions.md` Q9) and the model adoptions, and the
rule-line budget returns to 800 (`scripts/quality-ratchet.mjs`; 900 during the phases, owner 2026-11-11).

## 8. KPIs and risks

KPIs (reference libraries, measured automatically: the golden-small, ENV-C corpus and ENV-G clones and a
soak-style synthetic profile, as in F6's runner; the owner's library
is measured in F7 only, reported; *(cal.)* where not yet measured): zero-config install + model + PDF to
connected notes in named topics ≤10 min Hybrid; reachability 100%, Unsorted ≤2% from 50 items; mean depth
≤4.5 with ≥80% of internal nodes at 4-9 children and 0 single-child chains; weekly path churn ≤3% (replays);
undo rate on automatic structure ≤5% (measured in F7 from real use; before F7 the proxies are exact-undo
drills, the undo flows in the soak and e2e, and the undo rate in replays); 200 notes related in ≤4-8 min
local with fixture 27/28 and 0/35; 0 tasks blocked by another; import to notes and path ≤2 clicks; raw
palette classes ≤200, pollers 0.

Risks and mitigations:
- Tree quality on short bilingual notes is unproven → Spike B, the three-judge panel (decision 21), pinning;
  owner review in F7.
- Local reranker latency is unknown (serial `rankAll`, #30422) → Spike A gate, GGUF Qwen3, generative decide (bge retired, F3 Q18).
- Automatic restructuring can break spatial memory → hysteresis, freeze, churn budget, undo, Suggest. Before
  F7 the proxies are churn, the move budget and freeze in replays and the soak; felt disturbance is a question
  in the F7 trial guide.
- Lazy prose can make topics look unfinished → complete MOC, Ask falls back to notes and chunks.
- The wiki wipe discards existing prose → verified backup first; accepted by the owner (decision 4); done
  early at gate W (D37), with a cold copy of the database as the rollback.
- Rules lagging code make agents undo work → rule in the same change, line ratchet on `rules/`.
- New concurrency races in checkpoints → per-source exclusion, stepwise concurrency, soaks.
- Schedule: one checkout is the bottleneck (before F7 the owner only answers questions and approves designs);
  any KPI regression stops the line.
- Real use starts only after legacy removal, so the owner's first findings arrive late → 7 nightly runs, the
  Playwright journeys and the clean-install first run on the post-removal build; a restore-verified backup
  and the rollback tag `f6-pre-legacy-removal`; each F7 finding is fixed with a test.
- No real Keep and Remove exist before F7, so calibration may be off on real text (decision 29) → panel and
  synthetic labels written through the real writers, the export and dry run tested in F6, recalibration
  planned in F7.
- The F5/F6 main-process code (windowed ingestion, legacy removal) has no long soak (F4 D1 kept F4's close
  free of a Hybrid re-soak; F5/F6 main-process code has none) → nightly runs; an optional final Hybrid soak
  (about 1.4M Codex tokens for 72 h) on the owner's yes.
- View history, freeze and churn weighting are tuned without real viewing → a seeded synthetic view-history
  fixture in unit tests and soak driver opens; tuning with real use in F7.
- Agents or the owner could start the owner's DEV profile by default (a bare dev start, the matching runners,
  `MEMORA_GOLDEN_RESET`) → the rule in `rules/architecture.md` and `RULES.md`, the runners' scratch-profile
  mode and the startup guard (F5), clones only, the trial's pinned worktree and start command (F7).

## 9. How agents work on this plan

1. Read `RULES.md`, `STACK.md`, `rules/index.md`, then only the rules the task needs.
2. Pick the next unchecked task of the current phase (top of this file). Split it into an agent-sized change
   if needed; do not start a later phase early.
3. Choose the model tier per `RULES.md` section 4 and set it explicitly.
4. Implement the smallest complete change, with tests and the rule update in the same change.
5. Verify with `npm run check` (or its documented fallback) and the phase exit criteria that the task
   affects; record measurements, not estimates.
6. Commit atomically on `refactoring` with explicit staging, tick the task here, and advance "Current phase"
   when every exit criterion of the phase is met.
7. No agent starts the owner's profiles (the default DEV userData and the F7 trial profile) unless the owner
   asks; proofs, screenshots and journeys use scratch or cloned profiles (`MEMORA_USER_DATA_DIR`), and clones
   follow F7's triage rule. No task before F7 waits on the owner's use (decision 34).
