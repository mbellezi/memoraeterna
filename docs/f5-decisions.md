# F5 decisions: Unified workspace (2026-11-11)

This file holds the binding decisions for phase F5. The plan holds the F5 task boxes (T106-T176) and the exit line.
This file records:
- how and why F5 is built this way;
- the owner's answers and the defaults taken while the owner was away;
- the gates;
- every bar, with its data, method and owner;
- the slot plan, the budget and the schedule.

All of it is fixed before code. Notation:
- *(cal.)* marks a start value that a named measurement confirms or revises. A value without it is fixed.
- [I] marks an inference that a named card checks.
- X1-X12 are the plan's F5 exit line, made measurable.

The task cards (owned files, tests, proofs, merge order, shared-file chains) are the orchestrator's implementation
spec, `.cache/f5/spec-final.md` (untracked); its section 12 lists the three adversarial reviews' 64 findings and how
each was resolved. Where the spec and this file differ, this file wins. Days are UTC calendar days (London is on GMT)
unless marked agent-days. Plan decision 34 holds: F5's exit is automated only, and no card waits on the owner.

## Owner answers (2026-11-11, about 04:05)

- **New npm packages are allowed** where needed. STACK.md, exact versions and the license check still apply.
- **Codex has no ceiling**, including the optional final Hybrid soak. This covers no money on paid routes and no use of
  the Decisions API beyond what is already approved.
- **Settings v2:** publish the mockups, build on the orchestrator's proposal, adjust later (F7 at the latest).
- **F4:** run the dedicated E1 contention run; the 125 h of soak coverage is accepted.
- **The Mac is off** from Thu 11-12 00:01 until Sat 11-14. All agents stop by Wed about 23:30, and nothing detached
  runs at 00:01. T102 (Local, 25 h) and E1 (about 24 h) wait until Saturday.
- **UX quality gate** (gate U below). Before large surfaces, design candidates and a judge panel, seeded with four
  directions: A Reading desk, B Instrument, C Atlas, D Today. The element list: a path ribbon on every object; hover
  previews and citation chips; quick-look on Space; a live generation strip; skeletons; teaching empty states; stance
  glyphs; a density toggle; focus mode; Ask with inline citations and a sources rail. Each UI card gets real
  screenshots on a scratch profile, in both themes, in the four states, narrow and wide, reviewed by the orchestrator
  and an Opus UX reviewer with a fix loop; journeys are walked at each wave close. **A UI box is never ticked on tests
  alone.**
- **Agent names** show model and effort, for example "Opus (high)".

The Settings v2 mockups (T107, done 2026-11-11) are rebuilt on the gate D design and published with the workspace
mockup as one private artifact for the owner: <https://claude.ai/artifact/Q6eXBYpZvhuomeBExbnUQK> (static pages,
synthetic content). The design record `docs/design/f5-workspace.md`
(gate D, passed 2026-11-11) binds visuals, layout, copy and states; this file binds behaviour, data and keys, with the
gate D amendments applied below.

## Decisions

### Process, schedule and slots

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D1 | **Automated exit; gate U in two parts.**<ul><li>U1 (merge gate): the card's surfaces captured by `npm run screens` (real components over a fake `window.app`) in 4 states × light and dark × 960 and 1440 px, reviewed by the orchestrator and an Opus (high) UX reviewer, at most two fix rounds *(cal.)*.</li><li>U2 (box gate): the same surfaces live in the built app on a scratch profile, in slot windows.</li><li>Journeys' step screenshots are walked at each wave close from W3.</li><li>A UI box is ticked only with its U1 and U2 records.</li></ul> | Decision 34; the owner 11-11. U1 needs no Memora process, so merges do not wait for F4's slot runs; U2 keeps "real screenshots on a scratch profile" per card. |
| D2 | **Four dependencies, exact versions:** `radix-ui@1.8.1` (MIT); `cmdk@1.1.1` (MIT); `@playwright/test@1.64.1` (Apache-2.0, root dev, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, Electron only, never `playwright install`); `umap-js@1.4.0` (MIT, root dev, spike only). Installed by the orchestrator at W2's start after a license listing; [I] dates and licenses confirmed from the registry. No cva, clsx, tailwind-merge or axe-core: primitives are hand-vendored on the tokens. W0 and W1 need none. | The owner allowed it. Rejected: a hand-written combobox; a CDP driver over `ws`; a PCA-only Atlas. 1.64.1 is preferred to the 6-day-old 1.65.0 for field time (a preference, not a STACK.md rule). |
| D3 | **F4's close runs from branch `f4-close`** (cut at the last commit before the first F5 merge) in worktree `memoraeterna-f4-close`, with its own `node_modules` clone taken before the deps commit. F4 close commits land there first and are cherry-picked to `refactoring`. E6A2, FRREC and its replays, C3, T104, the E1 pilot and run, SOAK24B, T103 and the T69/T70 arms run there; no F4 run and no `npm run dev` starts from the main checkout after the first F5 merge. F5 cards that touch files of an open F4 card merge after that card's commit (T123 after E6A2; T114 and T122 after the E1 harness if it touches their files). Tag `f4-final` marks `f4-close`'s last commit at T105. | A 24-50 h run must measure a fixed subject, and electron-vite restarts a DEV app on every merge into its checkout. |
| D4 | **Slots.** One DEV-app holder (any Memora Electron) and one local-model holder (`LOCAL_MODEL_BUSY`) at a time. F4's queue first (SOAK24B, E1, T69 arm 6 overnight, T70 only on a free night). While an F4 run holds the slots, F5 work is model-free at background QoS with at most 2 test processes, no full check and no Memora Electron; the screens tool (bare offscreen Electron, temporary userData, network blocked, no Memora process) counts as one test process. Journeys hold both slots. F5's orchestrator proofs run from worktree `memoraeterna-f5-proof`. | `rules/ai.md`; F4 D2. |
| D5 | **Calendar.** W0 and W1 on Wed 11-11, model-free, no new dependency; agents stop at a clean commit by 23:00; at 23:30 the orchestrator checks that no Memora, vitest, tsx or postgres process runs; leftovers resume Sat 11-14. | The owner's absence. |
| D6 | **Strangler.** An old view leaves only after its replacement's journey is green twice and its U1 and U2 records exist: T157 after J8; T156 after J3 and the Cmd-K latency run; T158 after J2, J3 and J6; T166 after J7 (T174). Until then a legacy overflow in the rail footer keeps it reachable; a legacy-module test keeps removed files and channels out. | Plan. |
| D7 | **Economical verification and run hygiene.** Per card: its own tests plus `check:changed`. The full check and the electron-vite build at wave closes; journeys at W4, W5 and exit, nightly from W4 when free. A first pass within 10% of its bar gets a same-day second run and both must pass; a fail within 10% may get one diagnostic run, never a pass. `retries: 0`. | Owner rule; F4 D3. |

### Workspace

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D8 | **Shell and panel stack.** Rail: Home, Explore, Library, Inbox, Map; Settings in the footer. Each destination has a root surface plus a horizontal panel stack. Click pushes right of the clicked panel (the panels beyond go to a closed list, Cmd-Shift-T); an open address is focused; Option-click replaces. Per-panel history (Cmd-[ / Cmd-]); Back at a panel's start closes it. Cmd-W closes. The top panel keeps at least 568 px *(cal.)*, the reading measure plus padding (552 px at a 960-999 px window); the panel left of it shows in a compact form (216-240 px) when the stack is at least 848 px wide; other panels collapse to 40 px spines, and more than 6 spines merge into one "+N" spine *(amended 2026-11-11, gate D: A1)*. At most 8 panels *(cal.)*, a 9th evicting the leftmost panel that is neither focused nor the root. Navigator per destination (Cmd-\); context panel (Cmd-Shift-\), docked from 1280 px; below that, a 40 px strip that opens as an overlay *(amended 2026-11-11, gate D: A2)*. Cmd-1..5, Cmd-, Cmd-K, Cmd-N. State in `localStorage` `memora.workspace.v1` (with `lastHomeDay` and `lastHomeOpenAt`), Zod-validated in try/catch. | Plan 5. Rejected: tabs; a global history; layout in `settings`. Gate D: a 420 px panel leaves about 45 characters per line, 568 px keeps 60-70; the reading measure needs the width at 1200-1279 px (design record §3, §20.1 rows 6 and 8). |
| D9 | **Home rule.** Home on first run and on the first open of each local day; otherwise the last place. Choosing the first source in onboarding opens Explore with that Source panel pushed, so the navigator shows the tree being born; until then, Home is the first-run surface *(amended 2026-11-11, gate D: A6)*. "New" is computed since `lastHomeOpenAt`, passed by the renderer. | Meets ≤2 clicks at first run. `view_history`'s checks allow only object rows. Gate D: the first source teaches the tree and the path at the moment they appear, and X1's count is unchanged. |
| D10 | **One router, one object grammar.** `object-address.ts` stays the only object parser and gains the anchor `relation`. `normalizeMemoraLink` accepts the canonical form and the real legacy forms: `open/source/<id>`, `open/source/<id>?relation=<rid>` (→ `#relation=`), `open/wiki/<id>` with optional `revision` and `evidence` (retired notice; fields ignored). View addresses live in `R/workspace/route.ts`. External deep links only open objects. The channel becomes `deepLinkOpen`. The projections write the canonical form; the parser keeps the legacy forms. Topic redirects resolve in `objects.get`. | Plan 4.5. Two parsers drift. |
| D11 | **Objects layer as a read repository, no SQL views.** `objects.get` (preview ≤280, status, redirect; an anchored address previews its passage), `objects.resolveMany` (≤200, optional path), `objects.backlinks` (≤50, cursor; `via` = evidence, relation, source_relation, overview_citation, question_citation, mention), `objects.locate` for all five kinds. Relation visibility only through `note-relation-sql.ts` (its guard test stays green), topic scope through `topicScopeSql.ts`, currentness through `noteRetrievalSql.ts`. `objects.neighborhood` stays notes-only. Materialize only if EXPLAIN fails. | A view would duplicate the predicate one module test keeps single. |
| D12 | **`search.omni`.** Quick mode: one SQL statement; trigram `word_similarity` arms on `f_unaccent(title)` (sources, topics, notes), `f_unaccent(text)` (questions), `f_unaccent(canonical_name)` and `f_unaccent(f_jsonb_text_array(aliases))` (entities), each matching its index expression; FTS arms on notes, topics (aliases at weight B) and questions; each arm `LIMIT 20`; RRF k = 60; deterministic tiebreak. Full mode adds chunk FTS and ANN with the P0 query embedding, and degrades explicitly with no embedder. The renderer keeps one request in flight, latest wins, no debounce. It replaces `search.query` and SearchView. If the planner cannot use the entity alias index [I: T117], the alias arm leaves quick mode. | Plan 4.5. A debounce would eat the 100 ms budget. Rejected: ANN in quick mode; a topic-alias trigram index. |
| D13 | **Cmd-K.** cmdk inside a Radix Dialog. Prefixes `>` actions, `?` Ask, `#` topics, `@` entities. The empty query shows recents and pins. Enter pushes, Option-Enter replaces, Shift-Enter opens the full search results panel. | Plan. |
| D14 | **Ask streams and persists.** The Question row is inserted at start (`memora://question/<id>` valid from the first token). `consultation.delta` carries the complete paragraphs so far (idempotent), from an incremental JSON reader. `consultation.status` stages: retrieving, answering, waitingForProvider, done, failed, canceled; never coalesced. On completion the answer version and its citations are stored, each with its target's hash from one SQL expression per kind (note: title, idea and body; chunk: `content_hash`; source: hash plus summary; topic: overview version). Staleness is computed on read; "Ask again" creates a new version. Default scope: the whole library; topic and source scopes stay. Questions are local (backups yes, Obsidian no), with Clear questions in Privacy. `rules/knowledge.md` changes with the first card that writes a Question (T121): an Ask stores only its own Question. | Plan; F2 Q2. Rejected: token deltas; save on click; a staleness job. |
| D15 | **Hover previews and quick-look.** A Radix HoverCard after 300 ms *(cal.)* of hover or keyboard focus on any object link. A citation chip instead expands its passage in place in the answer's sources list: the Evidence tab, a note's margin, or a passage tray at the panel foot below 1280 px; it never shows a card over the text. Relation rows in the context panel show no card *(amended 2026-11-11, gate D: A3)*. One `resolveMany` per 16 ms batch; a citation click opens the passage highlighted (topic overview and topic Ask citations carry their anchors). Space (outside text fields) or Cmd-Y (anywhere, including Cmd-K) opens quick-look, a centred non-modal sheet; ↑/↓ peek the next row and Esc closes it *(amended 2026-11-11, gate D: A4)*. `memora://` links in Markdown render as object links. | Plan 5: "hover shows the passage, click opens it". Gate D: the passage never covers the text being read; `rules/frontend.md` keeps previews non-modal. |

### Events, settings, maps, import, safety

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D16 | **Bus v2 and 0 pollers.** Per-type coalescing: default 250 ms; `consultation.delta` and `explanation.delta` 50 ms keyed by `requestId`; `consultation.status` and `database.status` 0. Sticky replay for `database.status`, `model.loading` and `gardener.status`. Services publish through `appEventPort` after commit. New types: `object.changed` (refs ≤200 or overflow by kind), `view.changed`, `settings.changed`, `database.status`, `model.loading`, `obsidian.sync`, `obsidian.projection`, `monitoring.changed`, `consultation.delta`, `explanation.delta {requestId, relationId, text}`, `import.progress`. Retired: `topicsChanged`, `relationsChanged`, `viewHistoryChanged`, `aiLocalEmbeddingLoadStatus`, `relationExplanationDelta`, `ingestionFileProgress`; outside the bus only `windowNavigation`, `menuCommand`, `deepLinkOpen`. "0 pollers" = ratchet `rendererSetIntervals` 6 → 0 and a new `rendererPollLoops` 2 → 0, **and** J-idle's runtime proof (an IPC trace shows 0 invocations in 60 s idle per destination not caused by an event or a gesture). The Import clock becomes a start time. | Plan 4.5. A 250 ms delta stutters; a regex alone is gameable. |
| D17 | **Settings v2.** Seven sections: General, AI (presets first), Knowledge, Library, Integrations, Privacy, Advanced (with Diagnostics). Registry v2 per entry: section, group, label and help keys, English keywords, default (value, OS locale, unset or computed), reset adapter, reader `{file, symbol}`. Entries: today's 72 settings less the two T123 removes, one per AI workload-class route (embed, decide, write-fast, write-quality, answer) and per provider credential, plus page entries. The reader test needs a body that reads the key, a file off the deny-list, and reachability from an app entry point. AI › This Mac shows the hardware tier and recommended setup, informative only (decision 25). Diagnostics: the AI call log (read-only, prune with confirm), task history, debug switches with "Clear similarity debug runs", prompts. Kept: `graphWheelZoomSensitivity`, `keepLocalEmbeddingModelsLoaded` (Advanced). Merged: upload copies and their folder; one `contentLanguage` control; the Obsidian layout language stays an Advanced override. F4 E7 (≤6 automation controls outside Advanced) holds. | Decisions 24 and 25; the owner 11-11. The class routes are the settings most changed. Rejected: dropping columns in the UI phase. |
| D18 | **Settings order.** Mockups first (W0, a private artifact), registry in W4, UI in W5. Nothing else depends on it. **T107 is done (2026-11-11):** the mockup was rebuilt on the gate D design and reviewed (`.cache/f5/mockups/settings-v2/index.html`, untracked). Its open points take these defaults (Q31, Q35, Q36): list density, "open in" and "reduce motion" are not settings in F5 (density lives only in the Library header; motion follows macOS); the notes' language (`contentLanguage`) defaults to the macOS language (the registry's `osLocale` default), not "same as the source"; the "changed" marker is a grey dot, and the 2 px bar of a changed row uses the accent. | Plan; the owner may adjust in F7. |
| D19 | **Map › Relations.** `relations.branch` (topic or source scope; ≤400 notes, ≤2000 relations) returns topics, nodes, edges, outside, super-edges and truncated. Colours from `--graph-topic-1..12` (≥3:1 against the surfaces; adjacent ΔE ≥20 *(cal.)*). Louvain inside large topics; topic super-nodes when zoomed out; a table alternative. The per-source graph tab is removed; "Open in Map" scopes to the source. It replaces the old Knowledge Graph screen. | Plan box. Rejected: sigma 4 (F6). |
| D20 | **Map › Shape.** The Shape screen (F2 T25) under Map; depth cap 5 → 7 (`topicReadLimits`); growth from `topics.history` = daily primary-placement arrivals over ≤90 days from `topic_structure_events` joined to applied `topic_change_sets`. Home shows a compact Shape strip. | Plan box; plan 6 puts Shape on Map, Home and Inbox. |
| D21 | **Atlas spike, record only, $0.** Data: golden-small vectors (`.cache/topics/vectors/env-g.*`) with an `env-g` clone's placements (generation compared with the store's 15), and an ENV-C clone. Method: kNN purity in 1024-d; UMAP (3 seeds) and PCA; Procrustes disparity; level-1 contiguity. **Go for F6, frozen before the first run:** contiguity ≥0.70 and disparity ≤0.20 on both datasets; a later change is reported as a re-registration. The golden-small result is weak (8 topics, 160 notes). Report: `docs/spikes/atlas-f5.md`. | Plan box; no inference and no model slot needed. |
| D22 | **Parallel calls inside one import.** `mapInOrder` (bounded pool, outputs in index order, derived abort, lowest-index error); `AiService.taskRouteConcurrency` (API keys 4, Codex 2, local 1); the summary map and the graph extraction pooled with fixed 12/12 per-call caps; `remainingGraphLimits` and the settings `knowledgeGraphMax{Entities,Relations}PerSource` removed everywhere; checkpoints reused by key; progress writes serialized; identity resolution after all batches, as today. | Plan box. A cumulative cap makes batch N depend on batches 0..N-1. |
| D23 | Prompts stay identical except for sources whose cumulative entities had reached 250: they now run their remaining batches. T122 counts them in X7-REF and golden-small from the recorded traces. | It explains any calls-per-chapter change before R1. |
| D24 | **Import-time measurement (correction).** $0 permutation tests (20 orders); $0 X7-REF replay with recorded timing on product lanes, serial against c = 2; R1 live X7-REF on Codex c = 2. The paid API-key c = 4 run (R3) is not run without the owner (Q17): the box ticks on R1, the replay and the permutations, with the paid clause open and a forecast. | TP-C200 is S1's source-layer timing, not an import harness; a paid route spends money not approved. |
| D25 | **Startup guard.** A blank or relative `MEMORA_USER_DATA_DIR` is refused (exit 78). An unpackaged build whose userData is the default (compared by realpath, case-folded on macOS) refuses to apply pending migrations (history's max `created_at` older than the journal's last `when`) unless `MEMORA_ALLOW_DEFAULT_PROFILE_UPGRADE` is exactly `1`. A fresh default profile starts. The check runs in `database-service` before `runMigrations`. | Plan box; decision 34. Today a blank variable silently opens the owner's profile. |
| D26 | **Scratch-profile runners.** A new `isScratchProfilePath` (`.cache/profiles/<name>` and `.cache/f<N>/scratch/…`, realpath, no escape) gates the matching pilot and benchmark only; `isMeasurementProfilePath` is unchanged. Artifacts live in `<userData>/matching-{pilot,benchmark}/`; `inspect` writes `preflight.json`; the scripts require `--profile` and never print the connection descriptor. The two matching docs are unfrozen. | Plan box. Widening the old predicate would let the profile reset wipe scratch folders. |
| D27 | **Plan 4.5 index items.** Built: topic `search_tsv` (A/B/C); question `search_tsv`; trigram indexes matching the omni arms (source, topic and question titles; entity names and aliases through the immutable `f_jsonb_text_array`); a GIN on `chunks.search_tsv`; drops of `chunks_content_trgm_idx` and `chunks_content_fts_idx` (unused, in no snapshot). Not built: per-row `ts_config`; wiki-section `search_tsv` (none exist); `root_source_id` and a partial chunk HNSW (levers if an EXPLAIN gate fails). | Plan 4.5; F3 D28. |
| D28 | **P0 spill deferred until after F7.** | A remote embedder is a different vector space; a spill breaks Local privacy; Hybrid's writer is already remote. |
| D29 | **"Verify on this Mac" deferred until after F7.** | Decision 26: benchmarked models are record-only; an in-app benchmark whose results are not shown would be dead UI. |
| D30 | **IPC wiring by area.** Service cards write area files (`S/ipc-<area>.ts`, `M/services/<area>-ipc.ts`, `P/<area>-api.ts`). One wiring card per wave (T170, T171) owns `M/index.ts`, `M/ipc.ts`, `S/ipc.ts` and `P/index.ts` for the wave's new areas; every other edit of those files is a link of a fixed chain and starts only after the previous link merged. | RULES.md section 5: one owner per shared file at a time. |
| D31 | **Context panel tabs:** Connections, Mentions, Evidence, Graph (T143), Activity (the object's change-sets with Undo) and Ask (scoped to the focused object) (T173). The Activity tab is labelled History (pt-BR "Histórico"); "Activity" names only the global pill and drawer. Connections, Evidence and Ask are shown; the other three sit under "More" *(amended 2026-11-11, gate D: A5)*. | Plan 5 names the six tabs. |
| D32 | **ImportView leaves the top level** and stays as an advanced import panel (structure editor, enrichment, manual entry, containers, source editing), reached from the Add menu ("More import options…") and the Source panel, and as the onboarding import step, until F6 rebuilds it. Add's main button (Cmd-N) opens the file picker directly, and a window drop imports at once. The chevron menu offers a link, a note and the import mode. The chosen Source is pushed onto Explore's stack at once, with no "Open" toast *(amended 2026-11-11, gate D: A7)*. | Its flows have no replacement yet; rebuilding them serves no F5 exit bar. Gate D: one gesture fewer and no toast over content. |

### Inbox (gate D, 2026-11-11)

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D33 | **Inbox routing of suggestions** *(new 2026-11-11, gate D: A9; a default the owner may change, Q30)*. A suggested relation whose confidence is below "high" (typed configuration, 0.85 *(cal.)*), or whose stance is contradicts, appears in the Inbox as well as inline, and counts in "needs you". Other suggestions are inline only. A suggestion with no probability (null: written by an uncalibrated or threshold-only decider) is not "high": it routes to the Inbox and its confidence is worded "confiança desconhecida" with no number (Q37). The Inbox read model's arm and the domain predicate `routesToInbox` implement this one rule, so the inline words and the Inbox never disagree. Visibility still comes only from `note-relation-sql.ts`. The read stays bounded to the Inbox page size and the count comes from an indexed query; an EXPLAIN on an ENV-C clone is its proof. T176 extends the Inbox read model. | Design record §5.6 and §19.9. Risk: volume on a large library; the threshold is typed configuration. Rejected: the F4 kinds alone (a medium-confidence suggestion would never reach the user's queue). |
| D34 | **Inbox keys in F5** *(new 2026-11-11, gate D: A8; replaces F4 D29's key list)*. j/k and ↑/↓ move, and Enter opens. a accepts: apply a structure proposal, or keep a relation. Backspace removes: the `relations.review` remove verdict (status rejected), so the decider never suggests that relation again; it never sets `vetoed_at`, which is the withdrawn state. x only dismisses: the item leaves the Inbox and nothing changes; it is offered only where a dismiss verb exists. e edits names before applying a structure proposal, only where the writer supports it. r retries, u undoes, and ? shows the keys. | Removing and dismissing are different verdicts; the first-time-user critic flagged the merged key as a must-fix (design record §20.1 row 22). |

## Readings and corrections of the plan

- **Read model.** Plan 4.5's views `knowledge_objects`, `knowledge_links`, `current_notes` and `current_relations` are
  read as a read repository over the predicate modules (D11); `rules/data.md`'s "projection views may unify objects"
  line is replaced (T118).
- **`search_tsv` on wiki sections** is read as topics and questions (D27): wiki sections were dropped in migration 0063.
- **"~17 pollers, 9 `setInterval`s"** is read against the code: 6 `setInterval`s remain (one is a clock), plus the
  boot loop's `await delay(...)`. "0 pollers" = both ratchet metrics at 0 plus J-idle's runtime proof (D16).
- **"Cumulative caps become fixed per-batch caps (12/12)."** The per-call caps were already 12/12; what goes is the
  cumulative budget and its two settings (D22, D23).
- **"Import time (X3's TP-C200 on a paid route)"** is corrected to the replay and Codex run of D24; the paid-route
  clause stays open unless the owner approves R3 (Q17).
- **"`objects.neighborhood` (DOI-ranked, bounded)"** reads DOI as F3 D43's probability-then-depth ranking, on notes.
  F3 D43's "F5 widens it" is replaced by `backlinks` for cross-kind links (D11).
- **"Map › Shape on the icicle F4 builds for the Inbox"**: the icicle is F2's (T25); F4's diff icicle reuses it (D20).
- **"Settings v2 mockups approved by the owner first"** is superseded by the owner's 11-11 answer (D18).
- **"Cmd-K (shadcn Command / cmdk)"** is built on cmdk with hand-vendored token wrappers (D2), without the shadcn CLI.
- **Persisted Ask answers.** `rules/knowledge.md`'s "browsing and asking are read-only; saving is explicit" becomes
  "an Ask stores only its own Question" in the same change that first stores one (D14, T121).
- **Context panel** (plan 5): the six tabs are built (D31).
- **Shape on Home** (plan 6): a compact strip (D20).
- **Hardware profile in Settings v2** (decision 25): AI › This Mac, informative only (D17).
- **"Remove the old top-level views"**: ImportView leaves the top level but stays as a panel until F6 (D32).
- **"Atlas spike on a golden-small clone"**: plus an ENV-C clone, because golden-small has only 8 topics (D21).
- **The `similarity_debug_*` tables** are read by the matching evaluation and golden scripts, so they stay; only the
  Debug dashboard's list view leaves.

## Owner questions

Defaults Q4-Q21 were taken on 2026-11-11 while the owner was away; the owner may change them. Q1-Q3 are answered.
Q22-Q37 are the defaults taken at gate D on 2026-11-11, also while the owner was away: the design record's §19 items
1-13, the Settings v2 mockup's three open points (Q31 covers both §19.10 and the first point) and the null-confidence
routing found by the amendment's review (Q37). The owner may change any of them, at the latest in F7.

| # | Question | Default |
| --- | --- | --- |
| Q1 | The four dependencies of D2 | **Answered yes** (11-11) |
| Q2 | Remote spend | **Answered:** Codex without a ceiling: R1 runs, R2 and R4 if needed. No paid route (Q17) |
| Q3 | Settings v2 approval | **Answered:** publish the mockups, build on the proposal, adjust by F7 |
| Q4 | The guard refuses only pending migrations on the default profile | Yes; a fresh default profile starts |
| Q5 | Scratch roots `.cache/f<N>/scratch/` for the matching runners only | Yes |
| Q6 | Ask answers stored automatically as Questions | Yes (deletable; Clear in Privacy) |
| Q7 | Remove the two cumulative graph-cap settings | Yes |
| Q8 | Remove the Source page's graph tab (Map › Relations scoped to the source replaces it) | Yes |
| Q9 | Diagnostics contents (call log, task history, debug switches with the similarity clear, prompts) | Yes; the Debug list goes; the similarity tables stay |
| Q10 | P0 spill | Deferred until after F7 |
| Q11 | "Verify on this Mac" | Deferred until after F7 |
| Q12 | Obsidian layout language as an Advanced override | Yes |
| Q13 | Atlas data and the frozen go criterion (D21) | Yes |
| Q14 | Home rule (D9) | Yes; the first source's landing amended at gate D (Q34) |
| Q15 | F4's remaining runs on branch `f4-close` in their own worktree (D3) | Yes |
| Q16 | Questions are local (backups yes, Obsidian no) | Yes |
| Q17 | Run R3, the paid API-key import at c = 4 (about 204k tokens at that route's price) | **Not run**; the box's paid clause stays open with R1's forecast |
| Q18 | T69 arm 6 the night of Tue 11-17; T70 only on a free night before Fri 11-20, else its plan's "skip" | Yes |
| Q19 | ImportView stays as an advanced import panel until F6 (D32) | Yes |
| Q20 | Gate U in two parts, U1 blocking merges and U2 blocking boxes (D1) | Yes |
| Q21 | F5 closes about Fri 11-27 (bound Tue 12-01); F6 and F7 shift with it | Yes (plan rule) |
| Q22 | Structure changes: proposed or applied first? (design §19.1) | High-risk structural changes stay proposed and unapplied until decided; low-risk ones are applied with Undo |
| Q23 | Map › Graph colour by topic, beyond the kind, stance and state roles (§19.2) | Topic colours (`--graph-topic-*`) on the graph canvas only, always named in the legend and the edge table |
| Q24 | What a click on Add does (§19.3) | The main part opens the file picker; the chevron offers a link, a note, "More import options…" and the import mode (D32) |
| Q25 | Rail label for Home (§19.4) | "Início" (Home), not "Hoje", because it also hosts the first run |
| Q26 | A hero size above the `--type-display` 24 cap (§19.5) | No; a hero size needs the owner's sign-off |
| Q27 | Theme toggle in the rail (§19.6) | Removed from the rail; Theme is in Settings and in Cmd-K ("> tema") |
| Q28 | A reading-size setting (§19.7) | None; if wanted, two steps inside the scale (16 and 17) |
| Q29 | Topic glyph against the warning colour in dark (ΔE00 2.1; §19.8) | Separated by form (outline glyph against solid triangle) and position; no new dark warning value |
| Q30 | Suggestion routing threshold (§19.9) | Confidence below "high" (0.85 *(cal.)*) or the stance contradicts goes to the Inbox and counts in "needs you" (D33) |
| Q31 | "Open in", density and reduced motion as settings (§19.10; the Settings v2 mockup's first open point) | None is a setting in F5: density is the Library header's toggle, the Home rule is D9's, motion follows macOS (D18) |
| Q32 | A question's place (§19.11) | Read from its citations when the answer is done; questions are not tree leaves in F5 |
| Q33 | "Para relembrar" on Home (§19.12) | Not in F5 (no resurfacing schedule yet); Home's fourth column is recent questions |
| Q34 | Where the first source lands (§19.13) | Explore, with the Source panel on top (D9) |
| Q35 | Default of the notes' language (Settings v2 mockup) | The macOS language (the registry's `osLocale` default), not "same as the source" (D18) |
| Q36 | The "changed from default" marker (Settings v2 mockup) | A grey dot; the 2 px bar of a changed row uses the accent (D18) |
| Q37 | A suggested relation with no probability (an uncalibrated or threshold-only decider) | Not "high": it routes to the Inbox, worded "confiança desconhecida" with no number (D33); while a decider is uncalibrated every suggestion it makes routes, and the Inbox read stays bounded |

## Gates

| Gate | When | Passes if | If it fails |
| --- | --- | --- | --- |
| **D. Design** | End of W0 (T108). **Passed 2026-11-11** | `docs/design/f5-workspace.md`, built from the design workflow's four candidates, three judges and synthesis, names the direction or blend, per-screen layouts, token additions and element placements, with the judges' scores; signed by the orchestrator. Result: D Today as the base (24.5 of 30: intuitive 8.5, beauty 8, access and feasibility 8) in A's visual language (A Reading desk 21.5, C Atlas 18.5, B Instrument 18.5), with grafts from A, C and B; amendments A1-A9 applied to D8, D9, D15, D31, D32 and the new D33 and D34; spec adjustments S1-S13 applied to the cards | Shell and primitive cards wait; non-UI work continues |
| **M. Migration safety** | After T116, T117 and T169 merge: Wed 11-11 21:00 if free, else Sat 11-14 09:00 before SOAK24B | Heads recorded on clones of ENV-C, `env-g`, `env-soak24` and SEED30K; `db:questions:verify` and `db:search-indexes:verify` green; **≤15 s per profile**, each migration timed apart; EXPLAIN uses the new indexes; Ask's candidate plan unchanged; F4's gate M tool on clones, paused, no AI; the owner's DEV profile never started | Fix the migration; nothing touches a real profile |
| **U. UX quality** | U1 per UI card before merge; U2 per card in slot windows; journeys walked at each wave close from W3 | No open "fix" finding from the Opus (high) UX reviewer and the orchestrator after at most 2 rounds *(cal.)* | U1: the card stays unmerged; U2: a fix before the wave closes, the box stays open |
| **J. Journeys** | W4, after T154 and T155 (about Sat 11-21) | J1-J6, J8 and J-idle green twice in a row on the W4 code, `retries: 0` | Removals wait (D6) |
| **X. Exit** | W6 (T168, about Fri 11-27) | X1-X12; the non-regression list; every F5 box ticked with evidence (UI boxes with U1 and U2 records); rule lines ≤900; R1 reported with the paid clause open; Atlas recorded | Stop the line (plan section 8) |

## Measurement

### Datasets and profiles

| Name | Content | Used for |
| --- | --- | --- |
| BASE-J | Journeys base: an empty profile under `.cache/f5/scratch/journeys/<run>/base`, onboarding (Hybrid) in the built app, models seeded from `.cache/models`, the E6 PLOS paper by `firstrun-hybrid-f4` replay, the DEV Codex credential stub, and the fake remote for Ask and explanations. Each spec APFS-clones it. | J1-J8, J-idle, U2 |
| FR2 | As F4 (cassette `firstrun-hybrid-f4`) | J1, J2 |
| ENV-C | `.cache/profiles/env-c` clone (17,735 notes) | X3, branch p95, gate M, Atlas |
| SEED30K | A persistent scratch cluster at the 0065 head built once by `locate-benchmark.ts --seed --keep` (T169; 30,000 notes, 2,500 topics, 3,000 sources), cloned per use | X3a, `objects.*` p95, gate M |
| GS | golden-small: an `env-g` clone; vectors `.cache/topics/vectors/env-g.*` | X3a, branch p95, Atlas |
| X7-REF | As F3/F4 (cassettes `golden-x7-f3`, `f4-x7g2`), from an empty profile | D24 replay and R1 |
| GALLERY | No profile: screen-module fixtures over a fake `window.app` | Gate U1 |

Every clone starts paused, autonomy Off and remote routes blocked unless the run says otherwise. Cassette misses fail
(`MEMORA_AI_CASSETTE_LOCAL_MISSES` unset). PostgreSQL is started only on clones under `.cache/f<N>/scratch/`.

### Exit bars X1-X12

Gestures (X1, X10) are counted in the renderer: trusted `pointerdown` events and trusted `keydown` events of
non-printable keys or with Meta or Ctrl; printable characters typed into a field do not count.

| # | Data | Method | Bar | Who |
| --- | --- | --- | --- | --- |
| X1 import to notes and path | BASE-J clone; FR2's second source through Add | J2 counts gestures from the file choice (the stubbed picker returning; with D32's direct picker there is no confirm step) until a note row whose path chip equals `objects.locate(primary)` is visible; the count from Cmd-N is reported; J1 records the first-run case | **≤2** | T154; orchestrator |
| X2 path with 0 clicks | One object of each of the 5 kinds | J3 opens each by deep link and by Cmd-K and, with 0 gestures, compares the ribbon's segment addresses with `objects.locate(primary)` (≥2 segments for a note below level 1); `npm run screens -- --check` asserts the ribbon in every object panel's success state | **5/5, 0 gestures, equal** | T154, T138 |
| X3 Cmd-K | (a) ENV-C, SEED30K, GS clones; (b) ENV-C clone in the built app | (a) `bench:omni`: 200 prefix queries per profile (seed 20261111), 5 warm runs, quick mode, EXPLAIN per arm. (b) A journey types the same prefixes at 80 ms per key; per keystroke, from its keydown to the first paint answering it or a later key; queue wait and the never-sent share reported | (a) reported, ≤60 ms expected *(cal.)*; (b) **p95 ≤100 ms** | T128, T145; orchestrator |
| X4 pollers | (a) renderer sources; (b) the built app | (a) ratchet `rendererSetIntervals` and `rendererPollLoops`; (b) J-idle: 60 s idle per destination and Settings with an IPC trace | **(a) 0 and 0; (b) 0 uncaused invocations** | T126, T154 |
| X5 states | Every surface in `R/workspace/surfaces.ts` | `screens.test.tsx` (coverage) and `npm run screens -- --check` (each surface reaches each of the 4 `data-state`s from its own frame over a fake API, both themes, both widths), plus U1 and U2 records | **100%**, 0 check failures | T138, UI cards |
| X6 i18n | 5 locale files | `parity.test.ts`: same keys, same placeholders, no empty values, no value equal to its key, a value identical to English only on the allowlist | **0 defects** | T110 |
| X7 destinations | Rail | Unit test; J1 counts | **exactly 5** | T135, T154 |
| X8 sections | Registry v2 | Unit test | **≤7** | T159 |
| X9 search finds | Registry × 5 locales; T109's held-out queries, written blind before T175's keywords | (1) each label as the query; (2) each held-out query | **(1) top 5 for 100%; (2) top 5 for ≥90% per locale, and ≥1 held-out hit per entry and locale** | T161 |
| X10 ≤2 clicks | Built app | J7: rail, type the entry's held-out query (its label where X9 recorded a miss, listed), the entry's result, setting visible and focused; non-advanced also rail and section | **100% in ≤2 gestures** | T174 |
| X11 no unread settings | Registry v2 | AST reader test: body reads the key, file off the deny-list, reachable from an entry point | **0** | T159 |
| X12 AA | Tokens; every journey step | `npm run contrast` plus a computed-style scan of every visible text node and glyph at every step of J1-J8 in both themes; keyboard reachability recorded | **0 failures** | T137, T154, T155, T174 |

### Non-regression (wave closes and exit)

- The full `npm run check`, the electron-vite build and `npm run screens -- --check` at every wave close: rule lines
  ≤900, ratchet and contrast included.
- In slot block A (Mon 11-16) and at exit:
  - `topics:e2e` (`e2e-plos-f4`) replay green;
  - the golden-small non-regression replay;
  - C3 Ask p95 (SOAKDB ≤176 ms, CORP ≤500 ms; F4) after 0067;
  - F3's SEED30K bars (`objects.locate` ≤50 ms, `notes.page` ≤5 ms, neighborhood ≤20/50 ms);
  - X7-REF replay calls per chapter ≤40.0, after T122.
- At W3 and exit: `firstrun:e2e` replay ≤10:00 (F4 E6) and `test:graph-webgl`.
- At W4, W5 and exit: journeys twice. Nightly from W4: journeys plus `topics:e2e`, when the Mac is on and the slots are
  free.

### Reported values (no bar)

- J1 T0→T1; X1's count from Cmd-N.
- Omni full-mode p95 and its degraded share; X3(b)'s queue wait and never-sent share.
- `relations.branch` p95 (≤150 ms expected *(cal.)*) and the canvas frame time p95 from the `test:graph-webgl` branch
  scene.
- Import parallelism: replay wall time serial against c = 2; R1's time, calls per chapter, yield and merged-entity
  statistic M (F4 C1's method); cap-bound sources (D23); permutation equality 20/20 (a test).
- Atlas metrics and the go or no-go.
- The ratchet values at exit; Settings entries per section; X9's held-out hit rate and X6's identical counts per locale.

### Slot plan

| When (UTC) | Holder | Run |
| --- | --- | --- |
| Wed 11-11 until 23:00 | F4 | T69 arm 5, T104, helper align, FRREC and replays, REFRESHP, E1 pilot if ready |
| Wed 11-11 21:00 (if free) or Sat 11-14 09:00 | F5 | Gate M (about 1 h, DB only) |
| Sat 11-14 10:00 → Sun 11-15 11:00 | F4 | SOAK24B (T102) |
| Sun 11-15 11:00 → Mon 11-16 11:30 | F4 | E1 run |
| Mon 11-16 12:00 → Tue 11-17 02:00 | F5 | Block A: J0 ×2, U2 for W2, `topics:e2e`, golden-small replay, C3, SEED30K benches, X7-REF replays, `bench:omni`, `bench:branch`, T112 pilot proof, full check |
| Tue 11-17 08:00-12:00 | F5 | R1 |
| Tue 11-17 20:00 → Wed 11-18 06:00 | F4 | T69 arm 6 (idle Mac; F5 ≤2 background agents) |
| Wed 11-18 and Thu 11-19, daytime | F5 | U2 batches, `firstrun:e2e`, `test:graph-webgl`, W3 close |
| Wed 11-18 night (optional) | F4 | T70, only if F4 runs it (Q18) |
| Sat 11-21 | F5 | Gate J (journeys ×2) |
| Wed 11-25 | F5 | J7 ×2, U2 for Settings, W5 close |
| Thu 11-26 → Fri 11-27 | F5 | T168 (gate X) |

## Budget

### Claude (the owner's plan)

- Calibration: about 1.4 weekly points per agent-day; 1 point ≈ US$39-46.
- Starting point: 10% used at 04:30 on 11-11; resets on 11-13 and 11-20 at 16:00.

| Window | Work | Points |
| --- | --- | --- |
| Until 11-13 16:00 | W0 + most of W1 (15.5 agent-days) + reviews + F4 close | about 27 |
| 11-13 → 11-20 | W1 rest + W2 + W3 (43.25, with gate D's +2.75) + reviews | about 68 |
| 11-20 → 11-27 | W4-W6 (20.5) + reviews | about 30 |
| **F5** | **79.25 agent-days of cards + about 6.25 of Opus reviews ≈ 85.5** | **about 120 (US$4.7-5.5k)** |

Rules:
- Launches stop at 85% weekly.
- No 5-hour window passes 85% (about 6 concurrent agents *(cal.)*, shared with the F4 close).
- Above 90%: one or two Sonnet agents only.
- Any limit with less than 1% left pauses everything until the owner resumes.
- Drop order: second U1 rounds, then nightly journeys, then the Atlas spike moves a window. Gates and boxes are never
  dropped; F5 slips instead.

### Codex (`gpt-5.6-luna`; no ceiling, owner 11-11)

| Run | What | Tokens | Cap | Condition |
| --- | --- | --- | --- | --- |
| R1 | Live X7-REF import at Codex c = 2 | about 204k | 300k | After T122 and its replay; Tue 11-17 |
| R2 | B5 lane probe | about 60k | 80k | Only if R1 logs 429s |
| R4 | Cassette `journeys-f5` | about 40k | 80k | Only if T137 finds replay misses |

Not run without the owner: **R3**, the paid API-key c = 4 import (about 204k tokens at that route's price-table rate);
default not run (Q17). All other F5 measurement costs $0. Only the orchestrator calls a provider.

## Schedule

| Wave | When (UTC) | Cards | Agent-days | Ends with |
| --- | --- | --- | --- | --- |
| W0 | Wed 11-11 | T106-T108 | 1.5 | Gate D; mockups published |
| W1 | Wed 11-11 → 23:00; rest Sat 11-14 | T109-T123, T138, T169, T170 | 18.5 | Gate M |
| — | Thu 11-12, Fri 11-13 | Mac off | — | — |
| W2 | Sat 11-14 → Mon 11-16 | T124-T137, T171 | 17.25 | Deps commit; T135/T136 on U1 by Sun 11-15; slot block A |
| W3 | Sun 11-15 → Thu 11-19 | T139-T153, T173, T176 | 21.5 | U1 per card; U2 batches; R1 |
| W4 | Fri 11-20 → Mon 11-23 | T154-T160, T172, T175 | 10.5 | Gate J, then the removals |
| W5 | Mon 11-23 → Wed 11-25 | T161-T167, T174 | 9.25 | J7 twice, then T166; J1-J8 twice |
| W6 | Thu 11-26 → Fri 11-27 | T168 | 0.75 | Gate X |

There is no slack before gate X; a slip moves it day for day up to Tue 12-01, and F6 and F7 follow one for one (plan).
Gate D added 2.75 agent-days (T176 and the growth of T120, T130, T131, T141 and T142); T176 runs beside the W3 chains,
and T142's growth (it also took the Inbox icicle's labels from T176 at the amendment's review) lengthens the chain
T142 → T151 → T152 from 3.5 to 4.0 days.

**Merge order.** Cards that share no chain file may merge in either order.

| Wave | Order |
| --- | --- |
| W0 | T106 → T108 (T107 and T109 are untracked) |
| W1 | T110 → T111 → T112 → T169 → T113 → T116 → T117 → T138 → T114 → T115 → T118 → T119 → T120 → T121 → T122 → T170 → T123 |
| W2 | deps → T125 → T126 → T124 → T127 → T128 → T129 → T130 → T131 → T132 → T133 → T134 → T137 → T171 → T135 → T136 |
| W3 | T176 → T139 → T140 → T141 → T142 → T143 → T144 → T145 → T146 → T147 → T148 → T149 → T150 → T151 → T152 → T153 → T173 |
| W4 | T154 → T155 → (gate J) → T157 → T156 → T158 → T159 → T175 → T160 → T172 |
| W5 | T161 → T162 → T163 → T164 → T165 → T174 → (J7 twice) → T166 → T167 |
| W6 | T168 |

**Chains** (one owner at a time; a later link starts its edit after the previous merged; the full table is the spec's
7.3):

| File | Chain |
| --- | --- |
| `M/index.ts` | T111 → T170 → T123 · T125 → T171 · T141 → T150 → T173 · T157 → T156 → T158 → T160 · T166 |
| `M/ipc.ts` | T170 · T125 → T171 · T150 · T157 → T156 → T158 · T166 |
| `S/ipc.ts`, `P/index.ts` | T170 → T123 · T125 → T171 · T141 → T150 → T173 · T157 → T156 → T158 → T160 → T172 · T166 |
| `R/App.tsx` | T125 → T126 → T135 → T136 |
| Schema and migrations | T116 → T117 → T176 (only if its EXPLAIN needs a partial index: migration 0068, timed on gate M's clones before it merges) |
| Rules | `architecture.md` T111 → T120 → T125 → T137 → T167; `knowledge.md` T121 → T127 → T167; `frontend.md` T138 → T136 → T159 → T167; `data.md` T118; `ai.md` T122; `integrations.md` T141 |
| `docs/plan.md` | T106 → gate D amendments (F5AMEND) → T167 → T168 |

F4 close commits land on `f4-close` first and are cherry-picked forward; an F5 card touching a file of an open F4
card merges after it (D3).

## Plan boxes → cards

| F5 box | Cards |
| --- | --- |
| Shell, rail, navigator, panel stack, context panel; `memora://` router with per-panel history and Obsidian deep links | T120, T135, T136, T141, T143, T173 |
| Complete objects layer and `search.omni` | T117, T118, T119, T127, T128, T129, T169 |
| Cmd-K | T124, T145 |
| Ask with streaming and persisted answers | T116, T121, T129, T146 |
| Home; Library table; hover previews | T130, T148; T131, T149; T144 |
| Remaining pollers replaced by events | T113, T114, T115, T125, T126, T170, T171 |
| Playwright-Electron journeys (with Inbox triage stores) | T137, T154, T155, T174 |
| Scratch-profile mode of the matching runners | T112 |
| Startup guard | T111 |
| Settings v2 | T107 (mockups), T109, T159, T175, T160, T161-T166 |
| Remove the old top-level views and duplicate wiki browsers (and Jobs, the legacy Review queue) | T156, T157, T158, T166, T172 |
| Map › Relations | T133, T151, T152 |
| Map › Shape | T134, T142 |
| Atlas spike | T153 |
| Parallel calls inside one import | T122, T123 (R1) |
| Plan 4.5 indexes and read model | T117, T118 (D11, D27) |
| Design candidates and judges (owner 11-11) | T108 (from the design workflow); T176 (gate D's Inbox routing, D33) |
| Screens tool and four-state check (X5) | T138 |
| Record, rules, exit | T106, T167, T168 |

## Not in F5

- The P0 spill (D28) and "Verify on this Mac" (D29): after F7.
- Atlas as a product lens: F6, on the spike's go.
- Per-row `ts_config`; `root_source_id` and a partial chunk HNSW unless an EXPLAIN gate fails; SQL views for the read
  model; widening `objects.neighborhood`.
- To F6: the sigma 4 spike; the raw-palette codemod and the design-system finish; windowed ingestion; dropping
  `privacy_mode` and `fallback_policy`; rebuilding the advanced import editor (D32); legacy route mapping and claims
  remnants; the Keep and Remove label export (it reads J5's stores).
- Dropping the `similarity_debug_*` tables: not planned (the matching evaluation reads them).
- The paid-route import timing (R3): only if the owner approves (Q17).
- Streaming and veto for source-relation explanations: later.
- Bulk actions in the Library table.
- Adopting any benchmarked model, quantization or runtime: after F7, decision 26.
- Recalibration from real labels: F7.
- Upgrading the owner's DEV profile: never on refactoring code unless the owner asks.
