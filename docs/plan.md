# Memora Eterna 2.0 refactoring plan

**Current phase: F2 (weeks 7-11).** Branch: `refactoring` (from tag `pre-strangler`). This document holds the
target architecture and the roadmap. Durable invariants live in `RULES.md` and `rules/`; numbers here are
starting points unless marked measured.

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
2. **Filter (0 calls):** arithmetic feasibility while the legacy weighted score exists (lossless by
   construction); a calibrated cosine floor (bypassed by strong FTS or shared entities); a decision cache
   keyed by both note hashes and the decider; keep the top ~8.
3. **Decide P(related):** local reranker by default, MLX first (Qwen3-Reranker on MLXLLM), then GGUF
   Qwen3-Reranker, then bge-reranker-v2-m3; generative decision-only route as the universal fallback; OpenAI
   Decisions as an optional measured accelerator (use `predicate` for acceptance; shuffle options if `choice`
   is used for type). Raw scores for both directions are stored separately from calibration, so recalibration
   never re-decides. Isotonic calibration gives accept / uncertain / reject bands; in Auto mode high-precision
   accepts are applied, the rest of the accept band becomes suggestions.
4. **Type and direction:** only for accepted pairs, one enum JSON call **batched per source** (supports,
   contradicts, extends, depends_on, example_of, clarifies, same_as or none; none is a veto).
5. **Explain later:** a fast model writes a short explanation when the relation is opened (or prefetched
   after a hover delay), cached per pair, hashes, type, prompt and model; low-priority backfill for recently
   viewed pages. The writer may answer NOT_RELATED, which sends the relation to the Inbox.

**Source relations by aggregation:** promote a source relation when ≥2 accepted note pairs connect the two
roots, or one high-probability pair is confirmed by the decider. Discovery pairs without note links come
from source-centroid ANN plus a decider call. This replaces per-pair proposal calls and the Cartesian
trigram join. **Reranker caveats (GGUF fallback):** verify the GGUF header (classification head, rank
pooling; for MLX, the config and architecture) and a relevant-vs-irrelevant smoke test before exposing
`decide`; do not use the custom `template` option for bge; do not quantize the KV cache for ranking;
`rankAll` is serial and llama.cpp issue #30422 is present, so latency is budgeted only after measurement.

### 4.3 Gardener (event-driven maintenance)

Built on the existing `jobs` table (priority, `run_after`, attempts, SKIP LOCKED) plus `dedupe_key` and
`lane` (heavy: ingestion; light: Gardener and Obsidian, with a `compute` worker for work without model calls
and a `model` worker, so placement never waits for a model), with per-source exclusion instead of global
"any job / any AI call" blocks.

| Task | Trigger | Work |
| --- | --- | --- |
| PLACE | note created/edited/accepted, source chunked (debounced) | place in tree, update stats |
| MATCH | per source, as soon as its notes exist | Relations v2 |
| REBALANCE | hard violation (fast) or soft violation after subtree quiet | split, merge, push-down, collapse, re-parent, naming |
| REFRESH | dirty pages, priority = dirtiness × views × recency; P0 when opened | additive overview patches with citations, "Divergences" side by side, explanation backfill |
| AUDIT | after enough time and changes | deterministic lint: reachability, invariants, duplicates, broken links/redirects, stale embeddings, rolling re-placement |

- **States:** queued → running → done | no_change | failed (retryable with backoff; quarantined after a few
  attempts, shown in the Inbox with an action) | blocked (no model, cap, paused, offline, downloading) |
  skipped (same input fingerprint). No policy-wide latch; a pending review never blocks unrelated work.
- **Freshness by content only:** fingerprints use chunk, note and member hashes. Model, prompt and settings
  are provenance; changing a model offers an optional backlog. Saving settings never invalidates coverage.
- **Change-sets:** every applied task yields a localized, deterministic title, affected objects, risk level
  and an undo handle (retained ~90 days).
- **Inbox:** a read-only view over pending-review change-sets, quarantined tasks, contradictions,
  NOT_RELATED vetoes, duplicates and Obsidian conflicts; each decision becomes a calibration label.
- **Controls (three):** autonomy (Off: no generative or remote background work, deterministic placement
  still runs; Suggest; Auto with undo, the default), monthly remote spend cap, pause. Plus the tree-shape
  preference and "only idle" / "only on AC power" options. Always reviewed regardless of autonomy: changes
  touching human, pinned or protected structure or text; large merges; Area-level changes; rebuilds moving a
  large share of items; contradictions that would rewrite prose.
- **Money cap semantics:** remote background spend = recorded tokens × versioned price table; unknown price
  uses a conservative estimate, never zero. At ~80% remote background work pauses (P0 continues); at 100%
  background continues local-only. Subscription routes without per-token price (Codex OAuth) are outside the
  money cap and bounded by lane concurrency and a daily call cap. User-started imports show their estimate
  in the plan chip and do not consume the background cap. In Hybrid without a local writer, generative
  background work waits at the cap while placement and deciding continue locally; Activity says so. Local
  work has no money cap, only a duty cycle (lower while the user is active).
- **Status:** one sentence with ETA and an action ("why isn't it running?"); blocker precedence paused > no
  model > cap > download > waiting > offline; shows coverage and ETA, never call counts.

### 4.4 AI runtime lanes

- **AiScheduler** replaces the global FIFO: one local lane with concurrency 1 shared by embedding, reranking
  and local generation (hardware ceiling); one lane per remote provider configuration with bounded
  concurrency (start: 4 for API-key providers, 2 for Codex OAuth; tuned from 429s and rate-limit headers);
  OpenAI-compatible localhost/Ollama counts as local.
- **Priorities:** P0 interactive (Ask, query embedding, explanation on open, user action), P1 focused
  source, P2 ingestion and linking, P3 maintenance; strict with aging; never preempts a running call.
  Background local work is split into bounded calls so P0 waits at most one of them. A P0 may use an allowed
  remote lane when the local lane is busy.
- **Deadlines** count from execution start (connect, first byte, stalled stream, total per workload class).
  **Retries** in adapters: backoff with jitter for 408, 425, 429, 5xx, network and stalls, honoring
  `Retry-After`; never for 400/401/403/404/413, context overflow or schema failure after repair.
- **Schema output** via Zod JSON Schema: OpenAI `json_schema` strict, Gemini `responseJsonSchema`, Codex
  `text.format`, node-llama-cpp grammar; MLX keeps one repair. Valid items are kept; only missing ones are
  re-requested once.
- **Workload classes:** `embed`, `decide`, `write-fast`, `write-quality`, `answer`, seeded from a Local /
  Hybrid / Cloud preset at first run and tested with one call each. `decide` accepts only validated
  rerankers or explicitly chosen deciders. Local mode needs MLX for generation, so it is macOS arm64 only;
  elsewhere the default is Hybrid or Cloud.
- **Efficiency:** `embedMany` (remote arrays; one reused local context), skip re-embedding when hash and
  space are unchanged, cached config/credentials/adapters, telemetry written outside the slot, residency of
  a small group (embedding + reranker) plus one generative model unloaded after idle (minimal residency
  lands in F2, Q11).
- **Lean ingestion:** graph extraction once (on notes with chunk evidence), no claims extraction, duplicate
  notes on write become Inbox suggestions; windowed ingestion only after an A/B in F6.

### 4.5 Objects and events layer

- **Addresses:** five visible object kinds, each with a page and a stable address `memora://<kind>/<uuid>`
  (Source, Note, Topic, Question, Entity), plus anchors `#passage=<chunkId>`, `#span=<sourceSpanId>`,
  `#section=<sectionId>`. One address serves the router, links, Cmd-K, Obsidian deep links and Back.
- **Read model:** read-only views `knowledge_objects` and `knowledge_links`, plus `current_notes` /
  `current_relations` for currentness predicates. Canonical tables stay authoritative; materialize only if
  EXPLAIN gates fail.
- **Indexes:** immutable `f_unaccent` wrapper, per-row `ts_config`, generated `search_tsv` with GIN on
  chunks, notes and wiki sections; trigram on titles; partial HNSW per target type; materialized
  `root_source_id`; drop unused indexes.
- **IPC (Zod-validated):** `objects.get`, `objects.resolveMany`, `objects.locate` (primary path, "also in",
  citing pages), `objects.backlinks`, `objects.neighborhood` (DOI-ranked, bounded), and `search.omni` (FTS +
  trigram + ANN per kind, RRF across kinds) replacing the 3-4 current searches.
- **Push events:** a typed in-process event bus emitted after commit, coalesced and sent on one
  Zod-validated preload channel (`object.changed`, `tree.changed`, `relation.created`, `job.progress`,
  `inbox.changed`, `gardener.status`). It replaces the ~17 IPC pollers.
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
| Relations (advanced) | current force graph scoped to a branch, coloured by topic | force + Louvain, topic super-nodes when zoomed out | Map › Relations |

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
      setInterval, product lines over 200 characters: numbers only go down; rule lines: fixed 800-line budget).
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
- [ ] T23 Reranker decision gate for ambiguous placements (D10).
- [ ] T24 Area grouping into 7-16 pinnable Areas (D12) and mis-parent re-parenting.
- [ ] T25 Shape icicle with a table alternative; warnings with Apply and Dismiss (D29).
- [ ] T26 Human structure operations (rename, move, create, pin) with undo and review.
- [ ] T27 `objects.locate` on the topic tree (D24).
- [ ] T33 Obsidian topic projection replacing the wiki page branch: folder-note MOCs, aliases from redirects,
      paged delivery on the light lane replacing the fixed caps, with `rules/integrations.md`.

Wave 7 (gate C at the end):
- [ ] T28 Ask about a topic.
- [ ] T29a Calibrate placement and the gate per decider: admission, margin, gate temperature and threshold.
- [ ] T29b Calibrate stability, growth and structure; adopt the config defaults.
- [ ] T29c Gate C measurement (E1-E3 on the evaluation seeds, E6).
- [ ] T30 Owner blind rating (D20).
- [ ] T31 Lazy topic overview (migration 0054) written on open, with verified citations.
- [ ] T32 Zero-config end-to-end test (`topics:e2e`).
- [ ] T19b Embedding-space change with re-embedding and an ID-preserving rebuild (D26).
- [ ] T34b `memora://topic/<id>` deep links that resolve topic redirects.
- [ ] T40r Remove legacy repositories, schemas, prompts and scripts; update `rules/knowledge.md`.

Wave 8 (exit):
- [ ] T41 Exit measurement (`docs/kpi-f2.md`) and phase close.

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

- [ ] AiScheduler (lanes, priorities with aging, deadlines, classified retries, schema output in all
      runtimes, `embedMany`, hot-path caches, idle unload of the generative model and residency group sizing;
      minimal residency lands in F2, Q11); remove `ai-execution-queue.ts`; update `rules/ai.md`.
- [ ] Full workload classes with Local / Hybrid / Cloud presets; map legacy routes.
- [ ] Directed note relations: today `atomicNoteRelationRepository.upsert` sorts the two endpoints by UUID, so
      the direction of directed types (extends, supports, depends_on) is arbitrary (found by the golden replay);
      store canonical pair + explicit direction.
- [ ] Decide → type (batched per source) → explain later; isotonic calibration and bands; streaming
      `relation.explain` with cache; NOT_RELATED veto.
- [ ] Incremental per-source matching; source aggregation and discovery pairs; SQL fixes (search_tsv,
      raw-distance HNSW, no Cartesian join). Design E of `docs/spikes/source-relations-plan.md` (decision 17):
      promote every accepted note relation, discovery on each source's nearest source (2 as fallback), per source
      with no barrier, F1b's compact verdict as the generative judge; exit ≤5 s per source.
- [ ] Note-layer coverage on pinned notes (decision 15): measure with several decider samples; missing
      metadata (always-empty entities/tags/concepts) counts as an absent signal, not 0, re-frozen on tuning.
- [ ] Bake-off on the held-out fixture plus ~300 owner-labeled pairs (1.5-2.5 h): decision-only generative,
      Qwen3-Reranker-0.6B, bge-reranker-v2-m3, and OpenAI Decisions if the owner provides a key and budget.
- [ ] Evidence card and ego-graph v1 on the Note page (graph canvas extracted from the dashboard, colours
      from tokens); graph extraction once; claims stopped.

Exit: fixture ≥27/28 expected on the note layer over pinned notes (mean of several samples), 0/35 forbidden, ≤5% loss of today's reverse-only acceptances; 200 notes end
to end in ≤4-8 min local depending on Spike A (today ~40 min); 0 prose tokens for rejected candidates; a
failing source does not delay siblings; 24 h soak with 0 calls past deadline and repairs ≤2%; ≤40 generative
calls per reference chapter *(cal.)*.

### F4 Gardener, Inbox, Activity and first run (weeks 16-18)

- [ ] MATCH, REFRESH and AUDIT tasks; content fingerprints; outcome cache.
- [ ] Money cap, duty cycle, autonomy, risk levels, complete change-sets with undo.
- [ ] Overview writer limited to placed topics (additive patches, Divergences, non-blocking support check).
- [ ] Event bus with push; Activity pill and drawer with the status sentence.
- [ ] Inbox (view, keyboard flow, icicle diffs); 3-step onboarding; Settings › Knowledge with the three
      controls and tree shape.
- [ ] Drop the legacy tables the F2 legacy wipe emptied, with their insert fence, and the source-deletion and
      `jobRepository` guards on them (after backup). Routines, maintenance v1 and the dead Automation, Organization and Maintenance screens
      are removed in F2 (Q12).

Exit: 7-day soak (start by week 17) with injected writer rejections, timeouts and a mid-run cap: 0 tasks
blocked by another, quarantine ≤1%, ≥95% completed within 24 h; remote cap respected within one call; the
status sentence explains 100% of non-running states; clean Hybrid install places and connects the first note
in ≤10 min (e2e); ≤6 visible automation settings (from 37+).

### F5 Unified workspace (weeks 19-22)

- [ ] Shell (title bar, 5-destination rail, navigator, panel stack, context panel) and the `memora://`
      router with per-panel history and Obsidian deep links.
- [ ] Complete objects layer and `search.omni`; Cmd-K (shadcn Command / cmdk); Ask with streaming and
      persisted answers; Home; Library table; hover previews.
- [ ] Remaining pollers replaced by events.
- [ ] Playwright-Electron journeys: first run, import to tree, read topic, follow a relation, Inbox triage,
      ask and jump to citation.
- [ ] Remove the old top-level views and duplicate wiki browsers.

Exit: import to seeing notes and their path in ≤2 clicks (today ~10-12); any object shows its path with 0
clicks; Cmd-K p95 ≤100 ms; 0 pollers; every screen covers loading, empty, error and success; i18n parity in
all 5 locales; 5 destinations.

### F6 Lenses, lean ingestion, consolidation (weeks 23-26)

- [ ] Atlas only if the spike shows contiguous branches; branch mind map; scoped Relations lens.
- [ ] Windowed ingestion under A/B on the reference library.
- [ ] Finish the design system (primitives, raw-class codemod, pt-BR accents); sigma 4 migration spike with
      go/no-go.
- [ ] Remove remaining legacy code after 2 weeks of stable KPIs and a backup; move remaining numeric
      defaults into typed config with tests.

Exit: ≤15 generative calls per reference chapter with note quality within 5% in the A/B *(cal.)*; raw
palette classes ≤200 (from 1,854, measured); AA in both themes; KPIs green on 7 consecutive nightly runs.

## 8. KPIs and risks

KPIs (real library, *(cal.)* where not yet measured): zero-config install + model + PDF to connected notes
in named topics ≤10 min Hybrid; reachability 100%, Unsorted ≤2% from 50 items; mean depth ≤4.5 with ≥80% of
internal nodes at 4-9 children and 0 single-child chains; weekly path churn ≤3%, undo rate on automatic
structure ≤5%; 200 notes related in ≤4-8 min local with fixture 27/28 and 0/35; 0 tasks blocked by another;
import to notes and path ≤2 clicks; raw palette classes ≤200, pollers 0.

Risks and mitigations:
- Tree quality on short bilingual notes is unproven → Spike B, owner rating, pinning.
- Local reranker latency is unknown (serial `rankAll`, #30422) → Spike A gate, bge, generative decide.
- Automatic restructuring can break spatial memory → hysteresis, freeze, churn budget, undo, Suggest.
- Lazy prose can make topics look unfinished → complete MOC, Ask falls back to notes and chunks.
- The wiki wipe discards existing prose → verified backup first; accepted by the owner (decision 4); done
  early at gate W (D37), with a cold copy of the database as the rollback.
- Rules lagging code make agents undo work → rule in the same change, line ratchet on `rules/`.
- New concurrency races in checkpoints → per-source exclusion, stepwise concurrency, soaks.
- Schedule: one checkout and owner reviews are the bottleneck; any KPI regression stops the line.

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
