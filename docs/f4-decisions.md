# F4 decisions: Gardener, Inbox, Activity and first run (2026-10-23)

Binding decisions for phase F4. The plan holds the F4 task boxes (T67-T105) by wave and the exit line; this file
records how and why F4 is built that way, the owner's answers, the gates, every bar with its data, method and owner,
the 7-day soak plan and the budget, all fixed before code (D3). Values marked *(cal.)* are start values that a named
measurement confirms or revises; [I] marks an inference a named card measures; (unverified) an assumption nobody has
checked. E1-E7 are the plan's F4 exit line; C1-C4 are bars carried from F3 (`docs/kpi-f3.md`). The task cards (owned
files, tests, proofs, merge order) are the orchestrator's implementation spec (`.cache/f4/spec-final.md`, untracked);
where it and this file differ, this file wins. Days are UTC calendar days unless marked agent-days.

## Owner answers (2026-10-23)

- **Go:** F4 started on 2026-10-23 ("Pode começar"), after the weekly Claude reset at 16:00 UTC; wave 0 (T67 before
  the reset) folded into wave 1's start.
- **Q1-Q13:** every default accepted except **Q4** (the matching controls go to Advanced › Matching, not to typed
  config; section "Advanced › Matching") and **Q12** (the US$0.50 Decisions ledger probe runs). Table under Owner
  questions.
- **Decision 32** (plan section 2): local models first, a remote run as the last check; F4's "close" and remote spend
  are pre-registered in section "Decision 32 in F4".
- **Moved to F5:** parallel calls inside one import on remote routes (plan F5 box).
- **2026-10-24:** wave 3 (and T99 if its proofs pass first) merges before gate S and the soak; a Gemma 4 12B arm
  joins the record-only benchmark. Both are in section "Amendments after the start".

## Amendments after the start (2026-10-23/24)

Recorded in the orchestrator's run log as they happened. Each amends the decision, bar or line it names and wins
over the text below where they differ.

- **Wave 3 and T99 before the soak (owner, 10-24 about 04:45 UTC).** Gate S and the 7-day soak wait for wave 3
  (T93-T98), so the soak runs the code with W3 merged and D1 needs no soak-subject proof for W3's main-process parts;
  W3 closes before gate S with its own full check (no longer at W4's close), and T100 follows it. T99 (the
  MLX mask) joins before the soak if its proofs pass first: the release helper build, ranker parity on every
  profile and C4's replay bars, since the soak's MLX ranker runs on that helper (a new helper hash in D1's
  record); otherwise it merges after the soak with D1's behaviour-neutral proof.
- **A Gemma 4 12B arm (owner, 10-24; D25).** `mlx-community/gemma-4-12B-it-4bit` @ `73bcf090` (6,773,372,848 B,
  sha256 verified), in `.cache/models/gemma-4-12b-it-4bit-mlx`, is a fifth arm of the record-only benchmark
  (decision 26: no catalog entry, preset, default or merge). It runs after the critical-path proofs and before the
  soak only if the slots leave a gap before gate S; otherwise after the soak, since no local inference runs during it.
- **T72's proof bar (orchestrator, pre-registered 10-23 before any run).** The card's "typing agreement ≥95%
  against the recorded M2 answers" measures the typer's own noise, not the schema change: F3's S0 and S2, two live
  runs of one typer, agree on type and direction on 59.8% of 97 pairs from byte-identical prompts (61.6% of the 263
  common pairs, 64.6% on type alone). The bar is instead: every write-fast structured row `strict`; agreement with
  S0 on type and direction at least the S0-vs-S2 floor minus 5 points, type-only beside it; 0 schema failures and 0
  repairs on the typing rows. T72PJ (the 43 typing calls live, 98,648 Codex tokens against the 67k budgeted) passed:
  `strict` 43/43, 62.7% (165/263) against the floor's 61.6%, 0 failed, 0 repairs. The quit proof passed on X7B's
  exit (disposed in 54 ms, every step under its bound; the MLX writer was not loaded, only the ranker).
- **Identity twins (T87, D20).** Grouped per source, a later row listed an earlier row's provisional identity as a
  candidate whose text is that row's own, so a call showed the earlier row its "twin". Codex matched the twin for 8
  of 19 such rows over the recordings (no other invalid identity answer in 1,411 rows), and the one repair asked
  the pending rows together, so in FRREC the PLOS source's knowledge-graph stage failed with
  `errors.entityIdentity.invalidOutput` (extraction kept). Fix 1 (649d0b94): the repair splits the undecided rows
  wherever a call would show a row its twin; correct, but every twin repaired is a call (C1 would land at 40.0-41.6
  per chapter on X7-REF, about one repair per source on golden-small, near the soak's 2% repair bar). Fix 2 (11b4dfe1):
  unpinned, an earlier row's identity is named by its row key and a call lists no candidate that is one of its own
  rows' lines, so no identity call shows a twin. The pinned path, the identity templates and the stored
  `entity_identity_keys` are unchanged; grouped prompts differ, so the cassettes recorded with grouping miss. Both
  fixes are in `refactoring` (11b4dfe1).
- **Re-records (E6REC, FRREC).** After T87 the `e2e-plos-f3` replay missed one call (bisected to T87's per-source
  identity), and after fix 2 the cassettes recorded before it miss at the new prompts. The E6 replay is recorded
  again as `e2e-plos-f4` (label E6REC), which gate S and section "Non-regression" read in place of `e2e-plos-f3`.
  FRREC, T90's live clean-install record `firstrun-hybrid-f4` (10-24 06:05-06:16 UTC, real Codex), failed on the
  twin defect: both downloads succeeded (D = 0:18 on the critical path; the status explained 36 of 36 waits), then
  it stopped at its 150k live-token cap after about 10 min (471 calls) with no topic tree yet. It is recorded again
  after W3 merges (T96 extends its setup sequence).
- **Codex use runs above the F3-based estimates (C2, E6).** C2's first microbenchmark run (C2MB, 10-24) is void: its
  live judge (C2G) reached its 18k cap at 21k with 13 of 14 pairs judged. A complete FRREC needs about 370k tokens
  (the PLOS source alone about 280k) against the 100k budgeted. So every live label runs under its own cap
  (`F4_CAP`, 2 to 2.5 times its estimate) and a capped run resumes on its cassette copy (recorded calls are served
  at no cost); the microbenchmark runs first, and S1 and X3 at two neighbours only if it passes (D21; about 0.6M
  saved otherwise); FRREC's cap and sources go to the owner before it runs again. Codex spent so far: 284,549
  tokens after C2MB (pre-soak cap 1.5M, Q1).
- **T74's open items (orchestrator, 10-23; D8, D9).** A null fingerprint never adds up toward quarantine; an
  invalid model answer (`invalid`, `invalid_output`) is retried with backoff (spec 3.1b); a recovered job keeps its
  dedupe key.
- **Gate M's largest profile.** ENV-C, not `env-soak24`, is the largest profile in every table (gate M, 10-24), so
  runbook step 5's bound for chunks is ENV-C as well.
- **Wave closes bundle the app (orchestrator, 10-24).** The full check never bundles: after wave 1 electron-vite
  placed its CommonJS shims inside a comment of the worker bundle and the app did not start (fixed in 7c7d9f79, with
  a static test). Every wave close also runs `npx electron-vite build` in `apps/desktop` (section "Non-regression").
- **C2 missed; one neighbour, the judge per pair (D21, 10-24).** C2's microbenchmark (C2G + C2C, both usable)
  accepted 10 of LIB2's 27 panel-positive pairs (bar ≥12) with 2 panel-negatives (≤5): the batched judge (perRoot, v6)
  typed 3 positives `similar_to` (a weak type the product drops) and left 2 under the importance/confidence floors.
  `discovery.neighbours` stays 1, the two-neighbour S1/X3 runs are not run, and the source judge returns to `perPair`
  (F3's v5 judge byte for byte, the configuration F3's S1 bars measured: 1.60 / 1.44 judge calls per source); `perRoot`
  stays available by configuration.
- **C1 (X7-REF, 10-24).** 35.9 generative calls per chapter (bar ≤40, met), yield 1.000 of F3's X7, but M = 64 merged
  entities against the per-batch baseline's 58 (+10.3%, bar ±5%). Every one of the 8 extra merges joins a same-name,
  same-type, same-story duplicate across batches that the per-batch code missed (same-name duplicates left: baseline 8,
  X7B 9, X7G 2); the 2 lost merges came from a defect (three earlier same-name rows crowded the stored candidate out of
  a later row's places), fixed in the tolerant reader (c4653240; prompts unchanged). The ±5% band reads better recall as
  a miss: C1's M goes to the owner (recommendation: accept), and C1 runs again on the merged code (perPair judge).
- **Proof pass-rule fixes (10-24).** GOLDN2's check compared the judge mode with a value the product never writes and
  the harness's neighbours default overrode the caller's (fixed; GOLDN2 passes as a two-neighbour run: golden pairs 3/3).
  MATCHP's script required "unknown" for a `same_as` relation, which correctly shows `symmetric` (fixed; both rounds
  pass). REFRESHP's backfill pass is never queued while an AI cassette is installed, its token check added local tokens
  and its move plan starved two topics (proof fixed; it runs again).
- **Gate M with 0065 (10-24).** Wave 3 added `0065_divergence_findings` (T94's Divergences in the Inbox, D17); gate M
  steps 4-6 and the smoke ran again and passed (F4 set 0060-0065: 195 ms DEV, 1.5 s soak24, 4.7 s ENV-C).
- **Owner decisions of 10-24 (afternoon).** (1) C1 is accepted: 35.9 generative calls per chapter and M = 64 against
  58, the extra merges being correct cross-batch duplicates. (2) FRREC, the live first-run record, runs before gate S
  with a cap of 560k Codex tokens (it needs about 370k: the PLOS paper alone about 280k); the pre-soak cap stays 1.5M.
  (3) The soak's Codex cap rises to 6.0M (F4's measured use runs about 1.7x the F3-based estimates, which would put the
  7-day soak near 5.4M against the old 4.7M); gate S still re-freezes the expected spend; the F4 cap becomes 7.6M.
  (4) Gate S (about 0.77M at the measured rate) is paid by raising the pre-soak cap from 1.5M to 2.2M; the F4 cap
  becomes 8.3M. (5) Q13's pre-approved restart covers one restart at the same profile up to the 6.0M soak cap, the gate S
  run D38 requires included; a second restart needs the owner. The re-freeze reads the band's top as the measured
  projection (band 1.0, orchestrator), so the soak runs at full intensity within 6.0M.
  (6) Later on 10-24, after the first gate S recorded no sample (a harness schema bug, fixed) and spent 391k in 2 h
  (about 2.3x the gate plan's unit costs), the owner raised the pre-soak cap to 2.7M for a full gate S rerun and let the
  soak cap rise up to 8.0M if the re-freeze confirms the measured rate (full intensity); the F4 cap becomes about 10.8M.
- **Q12's probe (10-24).** 20 synthetic requests, provider-reported US$0.0019 equal to the ledger's figure: T76 done.
- **Strict output for the callers gate S saw repairing (owner, 10-25; amends D23).** Gate S's six real Codex repairs
  (the Ask 3 of 11 calls, notes, the source judge and naming one each) were all on contracts sent at schema none
  (strict rows 0/28, none 6/95). Their contracts cannot be strict as written (optional members, the Ask's refinement,
  the judge's tuple), so each caller now states the same answer in strict terms beside its contract
  (`AiOutputContract.strictContract`) and remote runtimes are sent that strict schema: every member required, the
  Ask's `change` and a note's `language` nullable (their parsers read null as absent), a name's `aliases` a required
  list (absent reads as empty), the Ask's distinct citations left to its parser, and a judge item (perPair v5 and
  perRoot v6 alike) a list of exactly seven aliases, scores 0-100 or chunk lists. A local runtime keeps what it was
  sent: naming and notes their contract's own grammar (T99, per-call grammars unchanged), the Ask and the judge none
  (`grammar: false`); the extraction pin still asks notes without a schema. Prompts, the parsers as final validators,
  decider and cassette keys (which never read a request's schema) are unchanged. Before gate S runs again, STRICTP
  (`.cache/f4/scripts/run.sh STRICTP`, about 60k Codex tokens, cap 80k) asks a few of each live on an ENV-G clone
  through the product's builders and requires `strict` on every row and 0 repairs.
- **The Ask drops a context link it cannot cover (orchestrator, 10-25; D35).** In STRICTP both the Ask's answer and
  its repair linked a summary to a paragraph that cites only one of the summary's two passages, so the Ask failed;
  such a link, one that names no context or relation of the question, or one that is no id at all (a later STRICTP
  answer put passage handles there) is now dropped from its paragraph and the answer kept, the count going to the structured log line `consultation_context_links_dropped`. Every other check
  still rejects the answer (schema, citations, `[eN]` markers, the investigation rule); prompts and cassette keys are
  unchanged.
- **A lane's problem holds only the work on that lane (orchestrator, 10-25; D27, spec 3.8).** In gate S
  (`soak7-gate-20261025T0815`, E5 v5 FAIL 131/133) a random injected 401 hit the Codex lane at 12:25:19 while the money
  window had routed the only remote work, six explanation backfills held by `cap.money_80`, to the priced fake's lane;
  the Codex lane ran and queued nothing, yet the status said `no_model.signin_required` (attention) from 12:25:30 to
  12:29:30: its lane holds counted every remote Gardener task on every lane. A lane's rate limit, outage, unreachable
  network or refused sign-in now holds only while the lane runs or queues calls, or remote work (held or not) whose
  calls take it: the status service reads every route a kind's calls resolve (operation, class, then task route) and
  the lane the scheduler names for each (`remote:<provider configuration>`), for the kinds whose calls are all known:
  topic names, Areas, overviews and label embeddings on their operation's route, the re-typing sweep on the typing and
  typing-repair routes, the explanation backfill on the explanation's. A kind on several lanes is work on each; work
  routed to a local model or with no route takes no remote lane; any other kind (the relation decider's, a link job, a
  catalog header, whose embedding and graph calls are not on its class route, an import) or a route that cannot be
  read still counts on every remote lane. Precedence, reasons and copy are unchanged; E5 v5 (`f4-e5v4` 3d32afe8) reads
  the same rule.
- **Pre-soak cap 3.1M (owner, 10-25).** Gate S `soak7-gate-20261025T0815` on `f4-soak-start-r2` spent 626,321 Codex
  tokens and failed E5 on the lane-hold defect above, leaving the ledger at 2,362,969 of 2.7M; D38 needs gate S again
  on a new tag (`f4-soak-start-r3`), about 630k, so the owner raised the pre-soak cap to 3.1M. The soak cap (up to
  8.0M) is unchanged. The same gate also moves its typing-fault import to minute 20, where no window meets it (both
  earlier gates started it in the second `g190-embedder-verifying` opened).

## Decisions

### Process, schedule and slots

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D1 | **The 7-day soak is the calendar spine and runs frozen code.** Everything it tests merges before gate S: task state, policy, budget, change-sets, MATCH, REFRESH, AUDIT, status, the migrations, the event bus, D23, T87 and T88 (its imports run identity and the source judge). It runs from a worktree beside the checkout, `memoraeterna-f4-soak` (never under `.claude/worktrees/`, which agents prune), on branch `f4-soak` at tag `f4-soak-start`, with its own `node_modules` clone and helper 44d081e0; its data root is absolute (`MEMORA_SOAK_DATA_ROOT` = the main checkout's `.cache`: profiles, corpus, run folder `.cache/f4/soak/<run>`, and that checkout's `LOCAL_MODEL_BUSY`, held 169 h). A soak fix lands on `f4-soak` and is cherry-picked to `refactoring`. At the close T101 lists the soak-subject diff since the tag over `apps/desktop/src/main/**` and `packages/**` except renderer, i18n and tests; such a change merges before the close only with a behaviour-neutral proof (a test, ranker parity, the Local re-run), else it waits for F5, so no Hybrid re-soak can be needed. | Decision 23; electron-vite's watcher would restart a soak in the main checkout; the harness resolved every path under the checkout's ignored `.cache`. |
| D2 | **Slots, local inference and load.** One DEV-app holder and one local-model holder (F3 D45); the soak holds both 169 h. Before it: the record-only benchmark and runtime spike in W1's idle slot window from a worktree pinned before 0060; X7, S1/X3, MATCH and REFRESH proofs, the e2e record and gate S, critical-path proofs first. After it: the decoder's model proof, the Local 24 h re-run, the e2e gate, DEV screenshots. During the soak only model-free work runs, at background QoS (`taskpolicy -b` / `nice -n 19`), at most 2 test processes, no full check, no e2e, no Swift release build; a per-minute load ledger (load average, memory pressure, top non-soak processes) attributes a STOP. | One local inference per machine (`rules/ai.md`); agent load would trip the lag, P0-wait and pageout checks. |
| D3 | **Pre-registration and run hygiene** (F3 D3, D7): every bar here is fixed before code; every run is reported; a passing result within 10% of its bar gets one same-day second run and both must pass; a failing result within 10% may get one diagnostic run, reported, never a pass; no second run for the 24 h and 7-day soaks; injected faults go to a ledger and are set aside. | A second run must not cherry-pick. |
| D4 | **Quota gates.** Codex: the caps and drop orders of Budget; the line stops and asks before crossing the pre-soak cap or before a restart outside Q13. Claude: in the week from 10-23 launches stop at 85% of the weekly limit and parallel agents are capped so no 5-hour window passes 85%; above 90% one or two Sonnet agents; above 99% on any window pause until the owner resumes; usage read before every launch. | Owner rules 2026-10-17/18. |

### Gardener core

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D5 | **Task state without an enum change.** `jobs` gains `scope_key`, `subject_key`, `outcome` (`done`, `no_change`, `skipped`), `blocked_class`, `blocked_reason`, `blocked_at`, `quarantined_at`, `input_fingerprint`. The Gardener state is derived: queued (unblocked), blocked, running, done / no change / skipped (succeeded + outcome), failed (retry pending), quarantined, canceled; a pre-0060 succeeded row reads `legacy` (E3 counts it apart). The free-text `result.status` stays for its readers; T74 maps each literal to an outcome, a blocker or a failure (`deferred` and `space_changed` re-requests inherit the first creation's clock), with a static test that fails on an unmapped literal. Readers of queued and running (`topics.status` `building`, Jobs) skip blocked rows. The stale domain `JobStatusSchema` is deleted. | `ALTER TYPE ADD VALUE` cannot run in the migrator's one transaction; an enum touches claim, retry, recovery and UI (F3 D25). |
| D6 | **Scope keys and claim-time exclusion, on claimable kinds only:** `root:<rootId>` for ingestion, link, promote and MATCH; `topic:<id>` for REFRESH; `tree:<id>:structure` for place, sweep, rebalance, build and audit lints; `tree:<id>:gate` for `topic-gate` (its apply relies on the engine's tree lock and generation check); `tree:<id>:names` for naming, Areas and label vectors; the singletons `catalog-header`, `relation-composite`, `retention`; **null for inline ingestion stage rows** (they run beside their scoped parent) and cache-only work; a static test fails on a job type without a kind row. A partial unique index on `scope_key` where `status = 'running'` makes two running tasks of one scope impossible (no plain `scope_key` index: source deletion filters on the payload); `claimNext` skips scopes with a running row and retries without that scope on `23505`. Link and promote payloads gain `sourceItemId`; a dedupe merge raises the queued job's priority. Light work waits only for a running task of its own scope (`rules/architecture.md`, T74). | Plan 4.3 per-source exclusion; an advisory-lock filter inside `SKIP LOCKED LIMIT 1` is planner-dependent; a stage row with its parent's scope would hit `23505` on every import. |
| D7 | **Blockers set work aside without burning attempts.** Classes in precedence order paused > no_model > cap > download > waiting > offline (reasons below). Global gates (pause, autonomy, only idle, only AC, an exhausted budget class, a missing route) act in the claim SQL: gated kinds leave `allowedTypes`, so their rows are never claimed (attempts and `dedupe_key` untouched) and the blocker service stamps class and reason for status. Per-task blocks found after claim (a refused reservation, a download of that model, a long provider wait) return the row to `queued` with `attempts − 1`, its `dedupe_key` restored (merged into a queued duplicate on conflict), class and reason stamped, and `run_after` at the clear time when known. Clearing events (resume, model validated, day or month rollover, download done, reset time, network back) clear exactly the rows of their reason; at startup every blocked row is re-gated before workers start. A running task that meets its blocker at admission ends blocked, not failed. | Plan 4.3 "no policy-wide latch"; `claimNext` adds an attempt and nulls the dedupe key today. |
| D8 | **Failure and quarantine.** Transient errors back off as today; a bare `AbortError` with a live job signal is transient (`job-failure.ts`). `gardener_outcomes(kind, subject_key)` (subject = the dedupe key's subject `note:`, `topic:`, `relation:`, `root:`, `tree:`; apart from the scope) counts consecutive failed jobs per (kind, subject, fingerprint); the second failed job (six attempts) quarantines: no automatic re-enqueue until the fingerprint changes or the user retries; an Inbox item with the error class, Retry and Dismiss. Light jobs get a manual retry. | A deterministic failure repeats on every trigger today; keyed by scope, unrelated inputs would add up. |
| D9 | **Fingerprints and the outcome cache.** Each task computes a content-only input fingerprint and ends `skipped` when it equals the last successful one for its (kind, subject). Model, prompt and settings are provenance: they never enqueue work; a model or prompt change offers an optional backlog. Reuse guards keep their keys (typing, decisions, explanations, ingestion stage prompt fingerprints, the source judge's identity): T88's new judge prompt makes a re-imported root's pairs judged once again and enqueues nothing. Overviews go stale on members only; a language or prompt change shows an "Update" offer. | Plan 4.3 freshness by content; re-keying the typing cache would re-ask every pair once. |
| D10 | **Change-sets: one view over three stores:** `topic_change_sets`, `relation_match_runs` (+ title key and params, risk, review status, `undone_at`) and new `topic_overview_versions`, unioned by the SQL view `change_sets`, which excludes human relation runs (`review`, `veto`); each store keeps its exact undo (`undoChangeSet`, `revertRun`, version restore) behind one IPC (`changes.list/undo/review/diff`). Embeddings, composites, catalog headers and the Obsidian projection are derived, not change-sets. A daily retention job prunes applied or undone change-sets older than 90 days *(cal.)* with their events, never pending reviews; an undo pair goes only when both are past the window; pruning runs inside the single writers. Succeeded and canceled `jobs` rows go after 30 days *(cal.)* (failed and quarantined kept until resolved; `local-model-download` never). Undo lasts the retention window (T100 edits `RULES.md` and `rules/knowledge.md`). | Plan 4.3 "retained ~90 days"; one physical envelope table would duplicate writes in two engines. |
| D11 | **Risk levels** (`changeSetRisk` extended in place): high = always reviewed (human, pinned or protected content; Area level; merges over 30 items *(cal.)*; rebuilds moving over 20% *(cal.)*; a Divergence that would rewrite prose; a tree-shape rebuild); medium = moved share ≥5% *(cal.)*, an overview patch with a Divergence, a rename of a topic opened in the last 7 days; low = the rest. | Plan 4.3's always-reviewed set; risk comes only from moved share today. |
| D12 | **Autonomy** (matrix below). Off: no generative or remote background work; PLACE, local deciding (suggestions), hard-invariant repairs and deterministic lints run; names stay provisional; typing waits (untyped fallback). Suggest: what Auto would apply becomes `pending_review`, except PLACE, deciding and hard repairs. Auto (default): applied with undo; D11's always-reviewed set stays reviewed. Local deciders only suggest in every mode (decision 29); the Decisions decider applies only in its band when opted in (decisions 30, 31c). | Plan 4.3; decision 2. |
| D13 | **Controls store:** one Zod-defaulted setting `knowledge.controls.v1` {autonomy, monthlyCapUsd, paused, treeShape, onlyIdle, onlyOnAc}, cached in main behind a generation counter and published as `gardener.status` on change. A tree-shape change creates a rebuild proposal through `topicTreeConfigForPreset` (always reviewed; the presets had no product caller). | Main reads settings per call today; a shape change moves many items. |
| D14 | **RemoteBudget.** Every background remote **attempt** reserves before it starts (a `beforeAttempt` hook in the retry loop; a refused retry ends as a budget blocker). (a) Money meter on priced lanes: estimate = `estimateAiPlanningTokens` (input + instruction bytes + `maxOutputTokens`, an over-count) × a versioned price table, monthly window; an unknown model is priced at 1.5× the table's highest price *(cal.)*, never zero; at 80% remote background pauses with an Activity "needs you" item to continue; at 100% background goes local-only (Hybrid without a local writer: generative background waits, placement and deciding continue). (b) Call meter on subscription lanes (Codex OAuth, price entry `subscription`): a daily background call cap, 800 *(cal.)*, in typed config, with a DEV runtime override for the soak only. One in-process admission mutex covers reservation and the in-memory ledger; a reservation is released only after its audit row commits; NULL usage keeps the estimate as spend, billed failed attempts count, and priced P2/P3 rows written before 0061 (null class) count once. P0 is never refused; user-started work (`budget_class = user`) is counted, never refused. The relation (500), topic (270, remote calls only) and header (50 roots) daily caps stay as sub-caps; the Decisions decider keeps its daily US$ cap and counts in the ledger. An attempt is admitted only if spent + reserved + its estimate ≤ cap, so no cap is passed by more than one attempt's estimation error. | Plan 4.3 money cap; up to 3 billed attempts per call, and the audit row is written after the lane is released. |
| D15 | **Duty cycle, only idle, only on AC** from Electron `powerMonitor` in a main `PowerSignals` service: local calls with `budget_class = background` keep a 50% duty cycle while the user is active (idle < 60 s), 100% when idle *(cal.)*; "only idle" holds Gardener tasks until 5 min idle *(cal.)*; "only on AC" holds them on battery. All three key on the budget class, never on priority (P2 also carries user imports). A DEV override (soak knob only) injects activity and battery windows. | Plan 4.3; no `powerMonitor` use exists. |

**Blocker reasons** (each an i18n key `gardener.status.<class>.<reason>` with parameters, never variable key parts, and
one Activity action):

| Class | Reasons |
| --- | --- |
| paused | `user_pause`, `autonomy_off`, `only_idle_user_active`, `only_ac_on_battery` |
| no_model | `no_route` {routeClass}, `model_missing`, `no_decider`, `signin_required`, `space_changed` |
| cap | `money_80`, `money_100`, `subscription_daily`, `provider_quota`, `feature_daily` |
| download | `model_downloading`, `model_verifying`, `model_loading` |
| waiting | `queue`, `same_scope`, `provider_rate_limit`, `provider_unavailable`, `local_memory`, `waiting_for_embeddings`, `retry_backoff` |
| offline | `network_unreachable` |

**Autonomy matrix (D12):**

| Work | Off | Suggest | Auto (default) |
| --- | --- | --- | --- |
| PLACE, gate, hard-invariant repairs, deterministic lints; local deciding (suggestions) | runs | runs | runs |
| Soft REBALANCE operations | provisional names, ops proposed | proposed | applied with undo |
| Naming, Areas | provisional TF-IDF names | proposed | applied (Area level reviewed) |
| REFRESH patches; explanation backfill | none | proposed; runs (vetoes to the Inbox) | applied with undo; runs |
| MATCH remote typing and discovery | waits (untyped) | runs (suggestions) | runs (suggestions) |
| D11's always-reviewed set | reviewed | reviewed | reviewed |

### Gardener tasks

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D16 | **MATCH**: a `relation-match:<noteId>` light job (relations worker, scope `root:`) after a human edit is re-embedded or a note is accepted (debounced 60 s, dedupe per note); it skips when the note's rendered-input hash (new `note_match_state.input_hash`, 0060) and space key are unchanged, else decides the note (local ranker) and enqueues its root's link job (types, promotes, discovers; deduped). Ingestion-time matching dedupes by `note_match_state`. Results stay suggestions (decision 29) with no automatic direction (31b), as a `relation_match_runs` change-set. A decider or model change posts a `backlog` finding; accepting enqueues the affected notes at P3; the owner's DEV library is not re-matched (Q8). | Plan 4.3; F3 did not build it. |
| D17 | **REFRESH**: a `topic-overview` job (model worker, P3 with aging, scope `topic:`) only for placed topics (non-root, ≥3 placed notes *(cal.)*) that have an overview or were opened in the last 30 days *(cal.)*; priority = dirtiness (new member evidence share) × views (decayed `open_count`) × recency. **Additive patch** (`topic.overview.patch`, strict schema): stored paragraphs as citations E1..En, only uncited evidence En+1.. within the 8,000-token budget; it returns ≤12 − existing new paragraphs and optional Divergences; code appends, so old text is byte-identical; numbering continues; zero new paragraphs → `no_change`. A P0 open of a stale overview joins a running write or runs the same patch at P0 (a first overview is a full write); the queued REFRESH then skips. Every write (P0 or P3) stores the previous version in `topic_overview_versions` (undo); a Suggest proposal records its base `version` and is re-proposed if a write moved it. The support check scores only new sentences, after the save, **at the job's priority** (no REFRESH run records a P0 row). A Divergence never rewrites prose: stored side by side, Inbox, high risk; a full topic (12 paragraphs) gets a rewrite proposal, never an automatic rewrite. | Plan 4.3; the write and support check hard-code P0 today; `rules/knowledge.md` changes with T84. |
| D18 | **Explanation backfill**: shown relations of notes opened in the last 7 days *(cal.)* without a cached explanation, at P3, ≤20 a day *(cal.)*, through the RemoteBudget; a `NOT_RELATED` withdraws the relation as on open and adds an Inbox item. | Plan 4.2 step 5 waited for F4 (F3 D22). |
| D19 | **AUDIT extensions** (compute worker, deterministic): (1) duplicate notes, on write and incrementally (cosine ≥0.97 *(cal.)* among the 3 nearest, or equal normalized titles) → `gardener_findings`; (2) broken `memora://` links and redirect chains (compressed through the engine as a change-set); (3) stale embeddings (content hash or space mismatch) → re-embed job; (4) rolling re-placement of 1% of placed notes a day *(cal.)* → re-parent candidates for REBALANCE's rule; (5) theme-drift renames (decision 20): label vector against the topic centroid below 0.55 *(cal.)* → a naming request, inside `runOnTree` (centroids live only in the tree cache); human names never change. Every tree write goes through the engine. | Plan 4.3, 4.4; decision 20. |

### Carried from F3

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D20 | **Entity identity grouped per source.** Extraction checkpoints every raw batch first; identity then resolves the source's rows in groups sized by locality in typed config: **24 rows and 24,000 characters per call on remote writers, 12 and 12,000 on local ones** (Q4's reading below: the stored values size local groups, never above 12 / 12,000); keys namespaced `b<batch>:<key>` while the fingerprint keeps the original key and the identity templates stay byte-identical (stored `entity_identity_keys` stay valid, version unchanged); relation-type resolution grouped the same way; a failed identity group no longer discards its batch's extraction; a retried stage resumes at the grouping phase; `MEMORA_GOLDEN_PIN=extraction` stays per batch; rows ordered by batch, then entity position. C1 records the effective group sizes and which cap bound. | F3 closed X7 at ≤45 calls per chapter (each identity call covers one 3,500-character batch); grouping projects about 38, needing identity 26 → ≤15 calls on X7-REF; the local writer's identity repairs argue against bigger local groups before C4. |
| D21 | **Two neighbours behind one judge call per root**: the new root against its ≤2 nearest roots plus its reverse partners in one `sources.decide` prompt (roots aliased in content order); items split per pair to `commitDecision`; the pair key excludes the batch composition; a malformed item re-asks only the missing pairs once; the daily relation cap reserves one call per root. Adoption (pre-registered): the LIB2 microbenchmark accepts ≥12 of 27 panel-positive pairs with ≤5 panel-negatives, then S1 and X3 (C2) all pass → `discovery.neighbours = 2`; any miss → one neighbour, recorded. Judged source relations keep the judge's direction. | On LIB2 one neighbour accepts 6 of the 27 panel-positive pairs, two accept 13, but per-pair N2 cost 2.96 calls and 5.09 s per source (bars 2 and 5.0); the 1.8 s fixed latency per call dominates. |
| D22 | **Ask retrieval and cancel.** Stored generated `chunks.search_tsv` and `atomic_notes.ask_tsv` as `to_tsvector('simple', f_unaccent(...))`, a btree on `atomic_notes(evidence_chunk_id)`, entity and title signals in per-statement CTEs; the statement ranks identically (the `unaccent()` → `f_unaccent` substitution is a tested claim: ranks equal to 1e-9). The GIN only with the prefilter (Readings). Cancel: each Ask statement carries `/* ask:<requestId> */`; on abort a control client runs `pg_cancel_backend` on the matching active backend; `budgetedQueries` checks `signal.aborted` before mapping SQLSTATE 57014, so a cancel stays `canceled` and a timeout stays `StatementBudgetError`. A long `Retry-After` follows Q2. | The signals rank every chunk in scope at about 0.07 ms per chunk (about 2 s near 25-30k chunks); indexes serve their queries (`rules/data.md`); an Ask reserves no client, so the in-flight statement's backend is the target. |
| D23 | **F3 follow-ups before the soak:** every catalog caller (typing, naming, identity, graph, notes, overview) states its output contract (Zod contract and name) in the log context, typing moving it out of `limits`; the service derives `strict` via `toStrictJsonSchema` for remote adapters (typing and overview qualify; identity's tuple never reaches Codex) and `grammar` via D24's emitter for runtimes advertising `schema`; the MLX host sends `{command:"shutdown"}` with a 2 s grace before signals and logs each dispose step's time; GGUF dispose is bounded. | No product caller sent a schema (`schema_mode` none); T64r follow-ups. |
| D24 | **JSON-constrained decoding in the MLX helper (31a).** (1) A grammar emitter in `structured-output.ts` (Zod → JSON Schema with `prefixItems`, `pattern`, lengths, optional members not required), sent with `strict: false` only to runtimes advertising `schema`; every catalog contract emits (test). (2) A pure-Swift library `MemoraGrammar` (no MLX import): subset compiler (objects, required, enum/const, strings with length and pattern, number ranges, booleans, null unions, arrays with `items`, `prefixItems`, min/max items) into a byte automaton with UTF-8 states, a token trie and bitset masks in a bounded per-call cache; tested by `swift test` on a synthetic vocabulary. (3) A thin `JSONSchemaMask: LogitProcessor` in the helper target, composed with the penalty processor; EOS only after the root closes; a closing reserve against `maxTokens`. `Package.swift` changes targets only. Byte-level BPE tokenizers only (the Qwen writers); another tokenizer, or thinking on, sends no schema (`none`). Protocol: optional `schema` on `generate`, capability `schema` in `health`, result `schemaMode: "grammar"`; without a schema the output is byte-identical. A new helper hash re-validates ranker parity on every profile (F3 D13). | Decision 31a; the pinned stack has the hook and no grammar; Qwen3.5's cache is not trimmable, so only mask-before-sample works. |
| D25 | **Benchmark and runtime spike, record only (decision 26):** golden-small-f2's generative prompts replayed on M4B, M9B4, Qwen3.6-35B-A3B-4bit and Gemma 4 26B-A4B 4-bit; the spike (Q6) builds mlx-swift-lm 3.32.3 and node-llama-cpp 3.22.2 in a throwaway worktree and measures M9B4 and the two downloads with and without guided decoding. Results in `docs/spikes/local-writer-benchmark.md`; no catalog entry, preset, default or merge; then the test models and transients are deleted. | Decisions 25, 26; the slots are idle before the soak. |

### Surfaces

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D26 | **Event bus**: a typed in-process `AppEventBus` (publish after commit, coalesced per type and key in 250 ms windows), one preload channel `appEvents` with a Zod discriminated union (`job.progress` counts per lane and state with ≤50 changed ids, `inbox.changed`, `gardener.status`, `model.download`); `topicsChanged` and `relationsChanged` are bridged and keep their channels until F5. The `JobsView` 5 s, `RelationLabelsCard` 2 s and `LocalModelsView` 1 s polls go (ratchet 9 → 6). | Plan 4.5; onboarding shows downloads and must not poll. |
| D27 | **Status sentence**: `GardenerStatusService` composes jobs, blockers, lane snapshots, downloads and the budget into {class, reason, params, coverage, eta, action}; a pure `statusSentence()` renders `gardener.status.<class>.<reason>` with every variable part as a parameter; an exhaustive test covers every (class, reason) in 5 locales. Coverage = placed, matched and fresh-overview shares; ETA = per-kind p50 of the last 50 tasks × queue ahead ÷ workers, or the blocker's clear time; never call counts. | Plan 4.3 "Status". |
| D28 | **Activity**: a header pill and a non-modal drawer (now, waiting with reasons, needs you, done with Undo, budget: month spend vs cap; Codex "subscription, not metered in money" with the share of today's background allowance). The blocking `LocalEmbeddingLoadDialog` becomes a `download` blocker. | Plan 5; never block the reading surface. |
| D29 | **Inbox**: a read model over the stores (`backlog` and `budget` are `gardener_findings` kinds so dismissals persist): `review` (pending change-sets of the three stores), `quarantined`, `contradiction` (Divergences, suggested `contradicts`), `withdrawn` (NOT_RELATED vetoes), `duplicate`, `obsidian_conflict`, `budget`, `backlog`; ≤50 per page, ordered by risk then age; verbs through the existing writers; each verdict persists in its store (the label F6 reads). Keys `j`/`k`, `Enter`, `a`, `x`, `r`, `u`, `?`; single keys never fire in inputs or dialogs. | Plan 4.3, 5. |
| D30 | **Icicle diff**: a component on `buildIcicle` drawing a change-set's affected subtree before and after (≤200 nodes *(cal.)* from a bounded diff read, deeper levels summarized), with the table alternative and keyboard focus; F5's Map › Shape reuses it. | Plan 5 ("never raw UUIDs"); `ChangeCompare` is textual and capped at 50/50. |
| D31 | **Onboarding**: three steps in a full-window first-run view while the library is empty and `onboarding.v1` is unset: (1) interface and content languages; (2) AI mode with the hardware tier card (Local only on macOS arm64; Hybrid signs in to the writer first, then `applyPreset` and the class tests one by one; model progress from `model.download`; a failure never blocks: "relations wait for the ranker"); (3) the first source with the default plan and its estimate (T76); finishing opens the source. Pure controllers over existing IPC plus two reads. | Plan 5 "First run"; no router or Home before F5. |
| D32 | **Hardware probe and tier table**: platform, arch and Rosetta, CPU, RAM, Apple GPU cores and working-set limit (once, cached), free disk; Windows via PowerShell CIM behind fixture-only tests; profile in `userData/hardware/profile-v1.json` (allowlisted fields). A pure tier table recommends a preset and **only today's models** (decision 26), each row with a price and an informative monthly estimate; benchmark results are not shown. | Decision 25 under decision 26. |
| D33 | **Settings inventory and cut.** `docs/settings-inventory.md` lists every setting with reader, default and fate (keep, merge, move to Advanced, drop), the F3/F4 additions (workload classes and presets, Knowledge, automation) placed (T68); it feeds T98 and F5's Settings v2. E7's counting rule: a persisted value with its own control on a Settings screen outside an Advanced disclosure that changes what the app does by itself in the background; AI setup (preset, five classes, judge, Decisions opt-in) and integrations are setup, not automation. Cut: Settings › Knowledge holds the six controls; **the 17 matching controls and the two matching-preset lists → Advanced › Matching** (owner, Q4) at today's recommended values; summary minimum words, graph limits, keep-embedders-loaded and decider mode → Advanced; online lookup 2 → 1; Obsidian enabled + paused → one tri-state; `wikiTreeWidth` and every setting T68 marks dead dropped, with a static test that no stored key lacks a reader. A `settingsRegistry` feeds the static E7 test. | Decision 24; plan 4.3 "saving settings never invalidates coverage" (section "Advanced › Matching"). |

### Data, configuration, soak

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D34 | **Five F4 migrations (six from a 0058 head), one gate M.** In order, each taking the next free number when generated, one owner at a time; a late card never lets a later one take its number: **0060 jobs state (T74), 0061 budget (T76), 0062 change-sets (T77), 0063 legacy drop (T78), 0064 Ask text (T79)**; 0059 applies to any profile still at 0058. Gate M passes before any real or measurement profile starts with them (Gates). Fallbacks if a profile misses gate M's time bar: an index is built after start by a job running `CREATE INDEX CONCURRENTLY IF NOT EXISTS` with the definition `schema.ts` declares (the baseline keeps it, its verify script checks it); a column rewrite becomes a plain column filled by a trigger and a batched post-start backfill, the statement reading `coalesce(stored, computed)`. | F3 D44; migrations run inside a 30 s startup bound and the renderer gives up at 60 s. |
| D35 | **Legacy drop**: the 30 tables of `legacyWipeTables`, `legacy_insert_fence()`, `relation_decisions.accepted` and `.relation_type`, the orphan `atomic_note_evolution.run_id`; the guards in `jobRepository`, `source-deletion-service` and `backup-verifier` (its key list counts `wiki_pages`); the wipe machinery and detector; fixtures and verify scripts that insert legacy rows. A profile restored from a pre-wipe backup loses its legacy rows (F2 D37). | Plan F4 box; every backup verification would fail after the drop otherwise. |
| D36 | **Numbers in typed config** (`gardener-config.ts`, `price-table.ts`, `relations-config.ts`, `runtime-config.ts`), each with Zod and tests; rules hold only invariants and every rule line added is paid for in the same file (800/800). | `RULES.md` section 1. |
| D37 | **The 7-day soak** (section "The 7-day soak"): Hybrid on a clone of ENV-G, real Codex for every writer class and the judge, Decisions off; reduced intensity plus twice-daily near-zero-Codex contention bursts; zero-token fault injection in front of the real Codex adapter; control and blocker windows with ground truth; a product mid-run cap and a harness token cap, both by reservation; one money window on a priced loopback fake; expected spend and cap re-frozen in `plan.json` from gate S. | Owner 2026-10-19; plan F4 exit. |
| D38 | **Soak failure policy.** A stop check writes STOP; the orchestrator launches nothing new, lets running cards reach a safe point unmerged, diagnoses (Opus) with the load ledger to tell agent contention from a product defect, lands the fix on `f4-soak` (cherry-picked to `refactoring`), retags (helper 44d081e0 kept), re-runs gate S and restarts from hour 0 on a fresh clone with the same plan; spend so far is reported; a restart is paid only from Q13's allowance, otherwise the owner decides. A host interruption (sleep, power, OS update) restarts without counting as a product failure; a product crash is a failure. No resume code. | Decision 23; resume would be new risk in the measured code. |

**Migrations and verify scripts** (`rules/data.md` process: edit `schema.ts`, `db:generate`, hand SQL where Drizzle
cannot, `db:seed:sync`, `db:seed:verify`, apply and verify on a real PostgreSQL, journal `when` strictly increasing):

| No. | Card | Content | Verify |
| --- | --- | --- | --- |
| 0060 | T74 | `jobs` task columns with CHECKs, `jobs_running_scope_uidx`, `(type, status)`; `gardener_outcomes`; `note_match_state.input_hash` (null = match again); backfill of queued and running rows' scope and subject (never inline stage rows) and of `sourceItemId` into queued link and promote payloads | `db:gardener:verify` |
| 0061 | T76 | `ai_task_runs.budget_class` (null on old rows = unknown), `job_id` (no FK), partial index for the monthly ledger | `db:budget:verify` |
| 0062 | T77 | `relation_match_runs` titles, risk, review status, `undone_at`; `topic_overview_versions`; `topic_overviews.divergences`, `.version`; `gardener_findings` (incl. `duplicate`, `broken_link`, `backlog`, `budget`); view `change_sets` | `db:changes:verify` |
| 0063 | T78 | the legacy drop (D35) | `db:legacy-drop:verify` |
| 0064 | T79 | `chunks.search_tsv`, `atomic_notes.ask_tsv`, `atomic_notes(evidence_chunk_id)`; a GIN only with the prefilter; `maintenance_work_mem` set locally | `db:ask-text:verify` (ranks equal to 1e-9) |

Settings without SQL: `knowledge.controls.v1`, `onboarding.v1`, the Codex daily background counter; `app.preferences`
loses `wikiTreeWidth` and the dead fields from its update schema (the read schema strips unknown keys).

## Readings and corrections of the plan

- **4.3 states (D5):** queued, running, done, no change, failed, quarantined, blocked and skipped are derived from
  `jobs` columns without an enum change; blocked sets a task aside without burning an attempt.
- **4.4's P0 spill → F5:** a P0 call never spills to a remote lane in F4 either (F3 D33); it needs alternate routes
  and a privacy gate, and no F4 exit needs it.
- **C4's Local 24 h re-run is decision 31a's soak.** The F4 box says the soak's repair bar counts the local writer
  again; the 7-day soak is Hybrid and never calls the local writer, so the Local re-run on SOAK24B (T102, set-aside
  off) is that soak, and the 7-day soak's repair line covers the remote writer.
- **The Ask box's "GIN index" (D22):** the statement has no `@@`, so a GIN alone would serve no query; it is built only
  with a prefilter, taken only if C3 fails, with the scope counted separately so `total` and `coverage.limited` hold.
- **E6's clock** starts at app launch on an empty `userData` (app start and migrations included) and adds the live
  clean-install record's download time on the critical path (D); the plan's "+ model" is that term.
- **E7's "from 37+"** reads 35 controls by the strict rule, 17 of them matching (T68 verifies); "Settings › Knowledge
  with the three controls and tree shape" is its six controls (autonomy, monthly cap, pause, tree shape, only idle, only
  on AC). "~17 IPC pollers" (4.5) are 9 renderer `setInterval`s, 8 polling: F4 removes 3, F5 the rest.
- **Codex and the cap:** plan 4.3 keeps Codex outside the money cap; the price table's `subscription` entry and the
  daily background call cap (Q3) are the cap "respected within one call" for Codex (E4(b)); the money cap is exercised
  on a priced loopback fake; `rules/security-privacy.md` loses its *(target F4)* tag (T76).
- **Undo "retained ~90 days"** is D10's retention window; `RULES.md` drops "(target F2-F4)" (T100).
- **Gate M covers 0059:** it was committed after F3's gate M record, so a profile still at 0058 applies six migrations,
  0059's backfill included.
- **"Start by week 17":** the plan's weeks are nominal (program start 10-14); the soak starts 10-28, at the latest 11-02.
- **"Injected writer rejections, timeouts and a mid-run cap":** faults in front of the real Codex adapter at zero tokens
  (the stall excepted), bodies built as synthetic shapes and labelled so; the mid-run cap is the product's Codex daily
  background cap lowered at run time (DEV override).

## Advanced › Matching (Q4)

The 17 matching controls and the two matching-preset lists move, at today's recommended values, into a "Matching
settings" group inside Settings' Advanced disclosure (T98); E7's rule is unchanged (Advanced is outside the count).
T68 verifies the 17, the pair-key fields and each control's reader. Plan 4.3 ("saving settings never invalidates
coverage") holds this way:

- **A changed value applies to new decisions only.** It is read by the next decision that uses it (an import's stages,
  a MATCH task, a link job); saving enqueues nothing and rewrites no stored decision, relation, typing entry, identity
  key or `note_match_state` row (settings are provenance, D9). Coverage (D27's matched share) counts every stored
  decision whatever values it was made under; a key made under other values never marks a note or pair unmatched.
- **Re-matching is an optional backlog.** A saved change posts one `backlog` finding (T98, through T83's offer) with
  the count of notes and pairs decided under other values; accepting enqueues them at P3 under autonomy and the
  budget, dismissing keeps every stored decision (the backlog of D16). The owner's DEV library is not re-matched in F4
  (Q8).
- **Pair keys as D33 tests them.** The six request-shaping source-judge values stay in the source pair key (a stored
  decision names the request it answered). At today's values the keys are byte-equal before and after the move (T98's
  equality test on a fixture); a changed value keys only pairs judged after it, and a stored pair is judged again only
  when content brings it up (a new or re-imported root) or the user accepts the backlog. T98 also tests that saving a
  changed value enqueues no job and changes no stored decision or key.
- **A value away from the frozen calibration is shown.** The calibrated set is the recommended configuration
  (`recommendedMatchingConfiguration`, preset `recommended-v2`) under which F3's bars were measured. When any
  value differs, the group shows a notice ("These values differ from the calibrated set; relations found with them were
  not measured") with a "Restore calibrated values" action, each differing control shows the calibrated value beside
  its own in text (not colour alone), and the preset selector reads "Custom". Measurement runs keep pinning the
  calibrated set and record the settings hash. F5's generic "changed from default" markers are not built in F4.
- **Group sizes (reading of Q4 with D20, T67):** identity and relation-type groups are sized by locality in typed
  config (remote 24 / 24,000 for C1); the stored `confirmationBatchSize` and `confirmationMaxCharacters` (schema
  maxima 12 rows and 24,000 characters, defaults 12 / 12,000; both read today by `entity-identity-resolution.ts` and
  `relation-type-resolution.ts`) stay in Advanced › Matching and size the **local** groups only, never above D20's
  local 12 / 12,000 (a stored 24,000 characters still gives local groups of 12,000), so they keep a reader, their
  defaults equal D20's local values, and a stored 12 still leaves remote groups at 24 (T87's test). This replaces the
  spec's "the stored setting no longer sizes groups" (T87); the owner may change this reading before T87 merges.

## Decision 32 in F4: "close" and the remote check (pre-registered)

F4 first does all it can for the local bars within decision 26: D24's mask on all five contracts, D23's routing, local
identity groups of 12 (D20), F3's item-level repair. Decision 32 applies only where a miss is the local model's; a bar
that measures our code or the product's default path has no remote substitute and fails as any bar does.

| Bar | Decision 32 | "Close" |
| --- | --- | --- |
| **C4 soak repairs** ≤2% of non-injected structured calls, every local-writer row counted (the Local 24 h re-run, SOAK24B, MLX Qwen3.5-9B 4-bit under the mask) | applies: the remote check below | rate in (2.0%, 3.0%] **and** 0 local-writer structured rows in mode `none`, 0 parse failures on `grammar` rows (every repair over the bar is semantic: valid JSON failing the contract's refinements, graph salvage included), every other line of the re-run passed |
| The re-run's other lines: 0 rows in mode `none`; every X6 line (0 past deadline, stuck jobs, swap, P0 wait, breaker, helper restarts, remote deadlines) | does not apply: our code and runtime | none: a miss is a defect, fixed and re-run (25 h, $0 Codex; the close moves) |
| C4 replay: all five contracts in `grammar`, compile ≤100 ms p95, decode ≥0.85× the unconstrained tok/s | does not apply: it measures our mask, which a remote writer never runs | none: C4's owner path (report the split, the line stops until answered) |
| E6 first run ≤10:00 | does not apply: the writer is already remote; the default Hybrid path has no remote embedder, the Decisions decider is opt-in and still filters with the local ranker (decision 30), and the download has no substitute | none: gate X |
| E1-E5 and the 7-day soak's X6 lines; T102's ranker parity | does not apply: Gardener and runtime lines; parity of our helper | none: D38; F3 D13 |

C1, C2, C3, E7 and T72's probe carry no local model (a remote writer or judge, SQL, settings). "Close" is at most
1.5× the bar: the mask removes syntax failures (without it F3's local writer failed 8-19% of structured calls), so a
residue up to 3% made only of semantic repairs is the model's limit, not our code's.

**C4's remote check (the orchestrator runs it).** The same 24 h test with the remote models: a fresh clone of
SOAK24B's base after gate M, its plan, seed, fault schedule, windows, driver and report on final code, for 25 h;
`write-fast`, `write-quality` and the generative-decide `op:` routes on the Codex profile (T89's knob; its token
checked with one call first, as for SOAK7; that the base holds one is (unverified); faults on that lane injected at
zero tokens), the Decisions API decider opted in (its frozen band and daily cap), embedder and MLX ranker local, Ask
and explanations on their F3 fakes as in soak24; `report.ts` with the set-aside off. **Import cadence** (imports,
re-imports and typing-fault sources together) **at one third of soak24's** (≈27 a day, T67 reading): at soak24's own
cadence the run would cost ≈3.0M Codex (82 imports × 37.1k), more than the F4 cap leaves; the repair bar is a rate per
structured call and the X6 lines are per call or per 24 h, so the scaled cadence keeps them, and it is recorded beside
the result. Passes when repairs ≤2% of non-injected structured calls and every X6 line holds: C4 is met for F4 under
decision 32, and `docs/kpi-f4.md` records the local rate, its gap to 2% and the Local preset's limit; fails: the owner
decides. One run, no second (D3). It needs both slots for 25 h after T102 (the close moves about one day) and T89's
knob to admit the Decisions configuration for this run only (built dormant in T89 before the tag, or after the soak
with D1's behaviour-neutral proof, since it sits under `apps/desktop/src/main/**`). Public text only (golden library
and Wikipedia); `OPENAPI_KEY` read at run time, never logged. The key's standing owner rule allows the synthetic
fixture and the public pools the owner named in F3; sending these soak texts to the Decisions API reads decision 32 as
the owner's approval, which the orchestrator confirms with the owner before the run.

**Spend:** Codex expected ≈1.0-1.2M (≈27 imports a day × 37.1k on soak24's measured call mix, up to 40.8k with
complete graphs as on X7-REF, plus F4's own background on Codex, ≈50k a day [I]), harness cap **1.3M** by reservation
(1.1 × the range's top, as the soak's cap), from the F4 cap's unspent part: the run starts only if 6.3M − spent ≥
1.4M (its cap plus W4's reserve), otherwise the owner decides; Q13's restart allowance never pays for it. Decisions
API ≤ **US$1.00** (the product's daily cap of US$0.50 on each of two days; the run starts early enough in a day that
its 25 h touch only two). Above either, the owner decides. A rate over 3.0% is not close: C4's owner path.

## Owner questions (answered 2026-10-23)

| # | Question | Answer |
| --- | --- | --- |
| Q1 | Codex for F4 | Default: the full soak profile; pre-soak 1.23M planned, cap 1.5M; soak expected 3.2M (range 2.6-4.3M), cap ≤4.7M re-frozen from gate S; W4 reserve 0.1M; **F4 cap 6.3M** |
| Q2 | Ask and a long `Retry-After` | Default yes: wait and retry once within the Ask budget when the wait is ≤30 s and leaves ≥15 s, showing "Waiting for the provider" |
| Q3 | Control defaults | Default: autonomy Auto; monthly remote cap US$5 on priced routes; Codex not metered, daily background call cap 800 *(cal.)*; pause, only idle and only on AC off; tree shape Balanced |
| Q4 | E7's rule and the cut (D33) | **Owner: the 17 matching controls and the two matching-preset lists go to Advanced › Matching** (the default was typed config); the rest of D33 as stated |
| Q5 | E6's live record downloads the two first-run models into a scratch profile (deleted after) | Default yes: `Qwen3-Embedding-0.6B-Q8_0.gguf` (639,150,592 B, `Qwen/Qwen3-Embedding-0.6B-GGUF` rev `370f27d7`) and `Qwen/Qwen3-Reranker-0.6B` rev `e61197ed` (`model.safetensors` 1,191,588,280 B, `tokenizer.json` 11,422,654 B, `tokenizer_config.json` 9,706 B, `config.json` 727 B: 1,203,021,367 B); 1,842,171,959 B in all |
| Q6 | The runtime spike downloads mlx-swift-lm 3.32.3 (SwiftPM) and node-llama-cpp 3.22.2 (npm) into a throwaway worktree | Default yes; record only, deleted after |
| Q7 | A second Mac for the soak | Default no; D2's schedule |
| Q8 | Re-match the owner's DEV library in F4 | Default no; a backlog offer the owner starts after F5 |
| Q9 | Keep the `*-m2b` clones and F3's gate M cold copies | Default keep; decided at the close |
| Q10 | Soak week (10-27 → 11-04) | Default yes, with a notice 24 h before the start: no other Memora profile signs in to Codex; the owner's ChatGPT/Codex use shares the plan's limits; no macOS update; the Mac on AC and otherwise idle; Memora not used on this Mac |
| Q11 | The owner's DEV profile and F4 | Default: upgraded after the close on the owner's yes, with a fresh restore-verified backup, autonomy Suggest the first week and a Codex background cap of 200 calls a day that week; nobody starts DEV on F4 code before |
| Q12 | The US$0.50 Decisions ledger probe | **Owner: run it** (the default was drop): T76, 20 requests on the synthetic fixture, `OPENAPI_KEY` read at run time only, never logged; a `credit_balance_exhausted` or other refusal is recorded and reported once, never retried |
| Q13 | A soak restart | Default: one restart with the same profile pre-approved, up to the soak cap again (≤4.7M more; F4 worst case ≈11M); a second needs the owner |

## Gates

| Gate | When | Passes if | If it fails |
| --- | --- | --- | --- |
| **M. Migration safety** | T82, after T74, T76-T79 merge (about 10-25) | The runbook below: heads recorded; backups restore with equal counts; every verify script passes on the DEV clone (paused, remote blocked), ENV-C and `env-soak24` clones; each profile migrates from its head (0059 where due, then 0060-0064) in **≤15 s**, rewrites and indexes timed apart | Fix the migration or D34's fallbacks; nothing changes on a real profile |
| **S. Pre-soak** | T91, about 10-27 | The soak's gate S (section "The 7-day soak"); C1 and C2 measured with T87 and T88 merged (the soak runs their code); the `e2e-plos-f4` (E6REC) and golden non-regression replays green | Fix and re-run gate S; the soak never starts on a failing pre-soak; if C1 or C2 is not ready the start waits (latest 11-02) |
| **X. Exit** | T105, about 11-06 | E1-E7 and C1-C4 (Measurement), C4 possibly under decision 32; every F4 box ticked; the soak-subject diff proven (D1); the non-regression list green | Stop the line (plan section 8); a soak failure follows D38 |

**Gate M runbook (T82, the orchestrator).** Steps 2-3 run first, before any F4 migration reaches a profile (the cold
copies sit under `.cache/f4/gate-m/` since 10-23; step 2's restore-verified dump is recorded in the gate M record).
(1) Record each profile's migration head (DEV, `env-{g,f,c,soak24,g-local-m2b}`, the `golden-x7-f3` copy, the FIX,
GOLD and LIB2 profiles); a head at 0058 also applies 0059 and its backfill. (2) Stop DEV; APFS cold copy
`dev-database-pre-f4` of its `database/` and a restore-verified `pg_dump` of that copy in a scratch cluster with equal
key-table counts. (3) APFS cold copies `env-*-pre-f4` of every measurement profile F4 starts. (4) Rehearse on an APFS
clone of `dev-database-pre-f4`, headless, with `knowledge.controls.v1.paused = true` and every remote route blocked
(nothing of the owner's library leaves the Mac, no token spent): every verify script, the migration time, rollback by
restoring the dump. (5) Time from each head on clones of ENV-C (largest notes) and `env-soak24` (largest chunks), each
table rewrite and index apart: ≤15 s per profile, else D34's fallbacks before any real profile starts. (6) Confirm the
set applied from each head is exactly 0059 (where due) plus 0060-0064. (7) Only then may measurement profiles start;
the owner's DEV profile is not started on F4 code in F4 (Q11). Record: `.cache/f4/gate-m.md`.

## Measurement

### Datasets and profiles

| Name | Content | Used for |
| --- | --- | --- |
| SOAK7 | `env-soak7` = `cp -cR env-g` after gate M (10 golden roots, Codex profile present; T89 checks the token with one call) plus Wikipedia articles from `.cache/corpus/wikipedia/{en,pt}.jsonl` (800 articles, 411 within the driver's 2,500-40,000-character filter; about 40 needed; seed 20261028) | E1-E5, X6 lines |
| SOAK24B | a fresh clone of `env-g-local-m2b` after gate M, F3's `soak24` plan unchanged (Local preset, fakes) | C4 |
| SOAKDB | clones of `env-soak24` before and after 0064 | C3 |
| CORP | ENV-C clones (17,735 notes; chunks unverified, 25-30k expected) | C3 scale, gate M timing, TP-C200 |
| FIX, GOLD, X7-REF | as F3 (`docs/f3-decisions.md` Datasets) | C1, C2 |
| LIB2 | the second library's labelled nearest and second-nearest pairs (27 panel-positive) | C2 microbenchmark |
| FR2 | empty `userData` (clean install, no models) + two public sources (the E6 PLOS paper, one golden-small source), cassette `firstrun-hybrid-f4` | E6 |
| REPLAY | golden-small-f2's recorded generative prompts (~335 per arm) | D25 benchmark, C4 replay |

### Exit criteria E1-E7

| # | Data | Method | Bar | Who |
| --- | --- | --- | --- | --- |
| E1 blocked by another | SOAK7 per-minute samples of every non-terminal job (type, lane, scope, status, blocker, `run_after`, `locked_at`) and of each worker's state (executing / waiting in retry, AIMD pause, backoff or a lane permit / idle) | A task is blocked by another when, for ≥15 consecutive minutes, it is due, unblocked and no running task shares its scope, while every worker of its lane is idle (≥3 idle samples) or held by a non-executing task of another scope, or `pg_locks` shows it waiting on another scope's task. Contention exposure = lane-minutes with ≥2 due tasks of different scopes, raised by twice-daily bursts | **0** over 168 h with exposure **≥120 lane-minutes a day**; below the floor E1 reads "not exercised", not passed; same-scope and queue waits p50/p95 per lane reported apart | T92, T101 |
| E2 quarantine | SOAK7 jobs, `gardener_outcomes`, injection ledger | quarantined (kind, subject, fingerprint) inputs ÷ distinct inputs with ≥1 non-skipped attempt; inputs whose failures were all injected excluded from both | **≤1%** | T101 |
| E3 within 24 h | SOAK7 non-skipped jobs created in [warm-up end, end − 24 h] | completed = done or no change (a `pending_review` change-set included), or canceled by supersession (dedupe or source deletion), within 24 h; a deferred chain measured from its first creation; quarantined = not completed; skipped and legacy rows reported apart | **≥95%**, per kind and per blocker window reported | T101 |
| E4 cap within one call | (a) harness token cap; (b) the product's mid-run Codex cap; (c) the money window on a priced loopback fake and T76's sidecar test | (a) gate S's 20 min window lowers the harness cap to spent + 1.5 calls' estimate: max(cumulative) − cap; (b) background Codex admissions after the crossing; (c) spend − cap, the `cap.money_80` item, continue, then `cap.money_100` local-only | (a) ≤ the largest single call's tokens (in the soak reported; reaching it ends the run inconclusive); (b) **≤1** call; (c) ≤ one attempt's estimation error, both transitions shown | T91, T92, T101, T76 |
| E5 status coverage | SOAK7 per-minute `gardener.status` + the driver's ground-truth timeline | (i) samples with ≥1 non-running task whose sentence is a fallback; (ii) after a 2 min settle following every ground-truth transition, sentence class = the highest-precedence active ground truth | (i) **0**; (ii) **100%**; plus the exhaustive unit test of every (class, reason) in 5 locales | T86, T101 |
| E6 first run | FR2: T90's live clean-install record (real download, Q5), then `npm run firstrun:e2e` replays with recorded timing, models seeded from `MEMORA_LOCAL_MODEL_SEED_DIR` with real install checks and ranker validation | T0 = app launch on an empty `userData`; T1 = a note of the first source in a named topic with ≥1 shown relation (applied or suggested); D = the live record's download time on the critical path | live record T1 − T0 reported; gate: **each of two replays on final code + D ≤ 10:00** | T90, T103 |
| E7 settings | `settingsRegistry` + DEV screenshots of every Settings scope | static count of category `automation` outside Advanced; manual count by D33's rule | **≤6** (the six Knowledge controls); setup, integration and Advanced counts reported | T98, T104 |

**X6 lines kept in SOAK7** (stop checks): 0 calls past deadline; repairs ≤2% of non-injected structured calls (all
remote in Hybrid); 0 jobs past twice their class deadline and 0 stuck over 1 h; pageouts ≤50 MB per 24 h after warm-up;
P0 wait ≤ one bounded call; the breaker opens in the outage and closes ≤60 s after it; helper restarts equal injected
kills; remote deadline faults end at their bounds.

### Carried bars C1-C4

| # | Data | Method | Bar | Who |
| --- | --- | --- | --- | --- |
| C1 X7 | X7-REF: record-resume on a fresh copy of `golden-x7-f3` (extraction, summaries, notes served; new identity and relation-type prompts live), unpinned, Hybrid, serial lanes, after T88's judge decision (judge calls counted) | `calls-per-chapter.ts` ×30/66 by operation; merged-entity statistic M = rows of `entity_identity_keys` for the five roots − distinct `entity_id` among them, against T71's per-batch replay ($0); noise reference = one live per-batch identity run vs that replay; partition agreement and effective group sizes reported | **≤40.0** per chapter and **M within ±5%** (absolute value beside it); a miss smaller than the noise reference goes to the owner, never passes by itself; yield 2.712/chunk unchanged; a first run in [36, 40] gets D3's second run, both must pass | T87 (orchestrator runs) |
| C2 S1 two neighbours | LIB2, FIX S0 and S1 orders, GOLD M2 run, X3 shapes | the microbenchmark first; only if it passes, S1 time and quality (judge-only live, typing and ranking served, as S0N2) and X3 (recorded once live, then replayed with recorded timing), `discovery.neighbours = 2`, batched judge | LIB2 ≥12/27 accepted, ≤5 panel-negatives; **≤5.0 AI-call s and ≤2 calls per source**, 0 replayed; source layer ≥27/28 held-out, 0/35; tuning ≥25/26 at 0/25; golden pairs 3/3; order replay 0 forbidden and ≥27/28 in ≥95% of 2,000 orders; TP-F, TP-G, TP-C200 **≤4.0 min** | T88 (orchestrator runs) |
| C3 Ask p95 | SOAKDB and CORP clones before and after 0064; the 250 + 1,020 question/scope combinations rebuilt | 5 warm runs each, candidates statement only, EXPLAIN captured; ranked rows and signals equal to 1e-9 | SOAKDB **p95 ≤176 ms**, CORP **p95 ≤500 ms**, results identical, no content `to_tsvector(` in the plans | T79 |
| C4 repairs, local writer | REPLAY with and without the schema, then SOAK24B for 25 h on final code | replay: schema mode per contract, first-pass validity, repairs, failed items, tok/s, compile time; soak: `report.ts` with the set-aside **off** (`--count-local-writer`) | the replay gates the re-run: **all five contracts (identity, typing, notes, extraction, topic naming) in `grammar`**, compile ≤100 ms p95 per call, decode ≥0.85× the unconstrained tok/s per contract; soak **repairs ≤2%** of non-injected structured calls including every local-writer row, **0** local-writer structured rows in mode `none`, every X6 line as registered | T102 (orchestrator runs the soak) |

**C4's owner path:** if a contract cannot be expressed in the subset, or the replay misses a speed bar, or the
re-run's repair rate is not close (decision 32), the orchestrator reports the split and asks the owner, as F3 did;
the line stops until answered. A close miss takes decision 32's remote check.

### Non-regression and reported values

At the W1, W2, W3 and W4 closes the orchestrator runs the full `npm run check`, `npx electron-vite build` in
`apps/desktop`, `phase4:e2e`, `topics:e2e --synthetic`, `db:seed:verify` and the stage verifiers (per change only
`check:changed`); W3 closes before gate S (owner, 10-24). Before gate S also: the `e2e-plos-f4` replay (0 misses), the
`golden-small-f2` non-regression replay (G1 digests unchanged), `db:topics:verify`, `notes.page`/`objects.locate` p95
on SEED30K (≤5/≤50 ms), Ask during an import (0 timeouts), the 200-link page (≤2 IPC calls per cycle), an
explanation's second open (0 calls), the topic tree untouched by the cut (0 roots moved), ranker parity on every
profile after any helper rebuild. **Reported, not gating:** queue waits per lane, blocker minutes per class, overview
patch acceptance in Suggest windows, backfill vetoes, identity catalog retries, the benchmark record, the Windows
probe's fixture coverage. Gate X ticks a box only with its measurement's file under `.cache/f4/` and its line in
`docs/kpi-f4.md`.

## The 7-day soak (T89 harness, T91 gate S, T92 run, T101 report)

**Profile and routes.** SOAK7 with `applyPreset("hybrid")`: GGUF embedder and MLX ranker local; `write-fast`,
`write-quality`, `answer` and the generative-decide `op:` routes on the Codex profile (gpt-5.6-luna); Decisions off;
autonomy Auto at start. Public text only (golden-small, Wikipedia): every article goes to OpenAI by design. Wed 10-28
00:00 → Wed 11-04 00:30 (168 h + 30 min warm-up); `caffeinate -dimsu`; hourly watchdog `scripts/soak/watch-soak.sh`
(hard stop at 169 h).

**Harness (T89).** `MEMORA_SOAK_REAL_WRITER=<codex providerConfigId>` beside `MEMORA_SOAK`, honoured only unpackaged and
under the data root's `profiles/`, relaxes the three refusals for exactly that id and refuses every other real provider;
`MEMORA_SOAK_DATA_ROOT` (D1); token columns and `budget_class` in the records; a composed adapter decorator enforcing
the harness token cap by reservation, with a DEV command that lowers it; a DEV runtime override of the Codex daily
background cap; a DEV `fetch` wrapper on `OpenAiCodexAdapter` for zero-token injection (only the stall forwards; the
report asserts 0 bytes forwarded for every other injected exchange, each tagged `soak-injected`); a route rewrite that
sends explanation backfill to a priced loopback fake in the money window; driver actions for controls, windows, bursts
and topic opens; per-minute samples; the F4 report lines and `--count-local-writer`; a `soak7` profile in
`scripts/soak/plan.json` with `codex.expected` and `codex.cap`, without which the driver refuses to run.

**Cadence and expected Codex tokens per day** (unit costs: import 40.8k = X7-REF's 203,789 tokens over 5 roots,
cross-check 37.1k from soak24's call mix; explanation ≈1.0k; the rest [I]):

| Action | Cadence | Per day | Tokens each | Per day |
| --- | --- | ---: | ---: | ---: |
| Article import (real ingestion, user-started) | every 6 h; odd days one re-import, even days one typing-fault source | 4 | 40.8k | 163k |
| Ask (P0, real Codex `answer`) | every 3 h | 8 | 6.6k [I: range 3.5-12.5k] | 53k |
| Explanation open (P0) | every 1 h + a burst of 5 every 12 h | 34 | 1.0k | 34k |
| Topic open (P0 overview when stale; view history for REFRESH) | every 2 h, about 1 in 3 writes [I] | 4 writes | 9.5k [I] | 38k |
| REFRESH patches (P3) | as triggered [I] | 6 | 6.0k [I] | 36k |
| Explanation backfill (P3, cap 20/day) | as triggered | 20 | 1.0k | 20k |
| Human note edit → MATCH | every 3 h | 8 | 3.5k [I] | 28k |
| Gardener background on Codex (naming, Areas, drift renames, retype sweep, catalog headers) | as triggered; bounded by the 800-call cap | ≈15 [I] | 3.3k | 50k |
| Contention bursts at h 6 + 12k: AUDIT lints, 20 re-embeds, a re-placement batch, 6 edits across 6 roots in 10 min | 2 a day | 12 edits | 1.75k [I] | 21k |
| Token-burning stalls and retried partial calls | 2% [I] | | | 9k |
| **Total** | | | | **452k** |

452k × 7.02 days ≈ **3.2M expected, provisional** (range 2.6-4.3M); **cap 4.7M provisional** (1.1 × the range's top,
harness, by reservation). Gate S re-projects with its measured per-import, per-Ask, per-open and naming tokens and
freezes `codex.expected` and `codex.cap` (1.1 × the re-projected top, at most Q1's ceiling) in `plan.json`; if the
re-projected top exceeds Q1's ceiling, drop steps apply from hour 0 until it fits.

**Day-1 checkpoint and drop order:** the projection uses the plan's window-aware hourly profile scaled by measured ÷
planned over the last 24 h outside window hours; whenever spent + projection > cap at an hourly check, the next step
applies, never reverted: (1) explanation bursts off and opens every 2 h; (2) Ask every 6 h; (3) backfill cap 20 → 10
(never off); (4) topic opens every 4 h; (5) imports every 12 h. Never dropped: note edits, contention bursts, every
fault and window, the mid-run cap, the money window, ≥2 imports and ≥4 Asks a day. Past step 5 the orchestrator asks
the owner while the run continues at that floor; reaching the hard cap ends the remote leg and the run reads
inconclusive.

**Faults on the real Codex lane** (seed 20261028; zero tokens except the stall; bodies are synthetic shapes from our
parser's patterns, labelled so):

| Fault | Rate | Expected behaviour |
| --- | --- | --- |
| 429 with `Retry-After` 1-10 s | 2% | inline retry ≤5 s; longer → job backoff (Ask: Q2) |
| 503 | 1% | backoff and retry |
| First byte at 35 s (delay before the Response) | 0.5% | aborted at the 30 s bound, retried |
| 25 s stall after real deltas | 0.2% | aborted at the 20 s stall bound (tokens billed, counted) |
| Malformed SSE | 0.3% | parse failure → repair path; injected, set aside |
| 401 on one call | 0.1% | permanent, not retried; set aside |
| 400 context overflow | 0.1% | permanent; set aside |
| Local: MLX helper SIGKILL (ranker) every 6 h ± 30 min; GGUF abort in an embedding batch every 12 h | | restart, transient retry |

**Windows with ground truth** (hour from start; none overlap; a daily pause at h 10 + 24k for 30 min):

| Hour | Window | Expected class.reason |
| --- | --- | --- |
| 30 (2 h) | 429 `usage_limit_reached` on every Codex call, `resets_in_seconds` = remaining seconds capped at 3,600 | waiting.provider_rate_limit with the reset time |
| 44 (2 h) | autonomy Off | paused.autonomy_off (generative kinds); PLACE runs |
| 54 (15 min) | Codex connection refused | waiting.provider_unavailable (breaker opens, closes ≤60 s after) |
| 66 (6 h) | autonomy Suggest | proposals `pending_review`; nothing generative applied |
| 78 (20 min) | every remote request fails ENOTFOUND | offline.network_unreachable |
| 84 (12 h) | mid-run cap: the Codex background daily cap set to calls so far today + 10 | cap.subscription_daily; P0 Ask and user imports continue |
| 102 (10 min) | 401 on every Codex call | no_model.signin_required; recovers by the 5 min probe |
| 114 (30 min) | ranker validation invalidated (DEV hook) | no_model.no_decider; placement takes decision 19's path |
| 120 (10 min) | embedder marked verifying (DEV hook) | download.model_verifying |
| 132 (4 h) | only idle on; power override alternates 10 min active, 10 min idle | paused.only_idle_user_active in active blocks |
| 140 (1 h) | only on AC on, on battery | paused.only_ac_on_battery |
| 146 (6 h) | money window: backfill on a priced loopback fake, monthly cap = spend + 8 attempts' estimate, a 10-relation backfill pass, "continue" pressed 10 min after the 80% item | cap.money_80, then cap.money_100 (generative background waits; placement and deciding continue) |

**Collected every minute** into `.cache/f4/soak/<run>/`: `ai_task_runs` with tokens, lane, class, priority, budget class
and outcome; job samples and worker states; the status snapshot; ground truth; scheduler snapshots; helper RSS;
`vm_stat` pageouts; event-loop lag; pool waits; cumulative Codex tokens and reservations; the injection ledger; the
load ledger.

**Stop checks** (hourly; STOP, then D38): calls past deadline; jobs stuck or past twice their deadline; any E1 event;
swap; P0 wait; the breaker not closed 60 s after a window; helper restarts ≠ kills; remote deadline faults off their
bounds; projected tokens over the cap after drop step 5; the app gone. **Review within 4 h** (continue unless confirmed
a defect): an E2 or E3 daily projection off its bar; E1 exposure below its daily floor; any E5 mismatch; repairs above
2%.

**Gate S (T91, 5 h pre-soak, real Codex, calibration):** the same profile with every fault kind and every window once at
short durations (10-20 min; the mid-run cap and the money window 30 min each), one contention burst, the harness-cap
window (20 min, E4(a)), and a calibration set (≥2 imports, 2 Asks, 2 stale topic opens and the naming that follows,
each with its tokens). Passes when every stop check passes, each window's class is right after the settle, each
injected kind ends as expected, E4(a) holds and injected exchanges forward 0 bytes; its figures re-freeze the expected
spend and cap. Then T91 tags `f4-soak-start`, creates `f4-soak`, the outside worktree and the clone.

**Roles:** the orchestrator (Opus) prepares the worktree and clone, runs gate S, starts the soak, holds both slots and
reads the hourly watchdog and a daily digest (tokens vs plan, drop steps, E1-E5 projections, exposure, load ledger); a
Sonnet agent writes the report and a classified audit of 50 failures (T101).

## Budget

### Codex (gpt-5.6-luna, the owner's subscription)

Pre-soak lines are priced from F3's measured `costs.json`; the batched judge is assumed to save a third of judge
tokens [I, T88 measures it].

| Phase | Item | Formula | Tokens |
| --- | --- | --- | ---: |
| W1 | T72 strict typing probe | 20 calls × 3,332 | 67k |
| W2 | T83 MATCH proof | 10 edits × 3.5k | 35k |
| W2 | T84 REFRESH and backfill proof | 15 patches × 6.0k + 10 explanations × 1.0k | 100k |
| W2 | T87 C1 | grouped run 26 × 1,538 ≈ 40k; D3 second run 40k; live per-batch noise run 40k | 120k |
| W2 | T88 microbenchmark | ≈30 judge calls × 1,970 | 60k |
| W2 | T88 S1 judge-only at two neighbours (only if the microbenchmark passes) | S0 147k + S1 135k + GOLD 84k | 366k |
| W2 | T88 X3 recorded once live, then replayed | TP-G 50k + TP-C200 136k + TP-F 50k [I] | 236k |
| W2 | T90 first-run live record | 2 sources × 40.8k + naming and explanations ≈ 18k | 100k |
| W2 | T91 gate S | 2 imports 82k + 2 Asks 13k + 2 opens 19k + the rest ≈ 36k | 150k |
| | **Pre-soak planned** / reserve (a gate S re-run, D3 second runs) / **cap** (stop and ask before crossing) | | **1.23M** / 0.27M / **1.5M** |
| Soak | T92 expected, provisional, re-frozen at gate S / **cap** (harness, by reservation) | 452k × 7.02 | 3.2M / **4.7M** |
| W4 | reserve (a fix probe; replays and the Local re-run are $0) | | 0.1M |
| | **F4 cap** (without Q13's restart allowance) | | **6.3M** |

- **Pre-soak drop order at its cap:** (1) C1's live noise run (partition agreement stays the noise reference); (2) C1's
  second run unless the first lies in [36, 40]; (3) the MATCH proof (unit and sidecar tests stand). Never dropped: C2's
  microbenchmark, S1's and X3's first live runs, gate S, the first-run record. If the microbenchmark fails, S1 and X3
  are not run (−0.6M) and one neighbour stays.
- **Soak:** drop order and calibration above; a restart only from Q13's allowance; no Hybrid re-soak exists (D1).
- **Decision 32's remote check** (only if C4 is close): ≤1.3M from the F4 cap's unspent part (section "Decision 32 in
  F4").
- **Decisions API:** T76's ledger probe ≤US$0.50 on the synthetic fixture (Q12); decision 32's remote check ≤US$1.00;
  nothing else.
- Local inference (benchmark, replays, the Local re-run, rankers) costs no quota. Every run reports its live tokens;
  the orchestrator reports running totals at every wave close and daily during the soak.

### Claude (the owner's plan)

- **Units (calibrated 2026-10-20, `.cache/f4/usage/*.py`).** An agent-day is a nominal size point (a card's relative
  size as its author judged it), neither calendar time nor cost. Cost is measured in **points** (1% of the weekly
  limit): about **1.4 points per nominal agent-day all-in** (0.7 inside the card itself; per-card spread 0.1-2.2, live
  proofs and fix loops the costliest), and one point ≈ **US$39-46 of tokens weighted at API list prices** (three
  windows agreed). The weekly limit is shared with the owner's other projects, so the orchestrator reads the real
  total before every launch and re-measures each card's points from the transcripts at every wave close, re-planning
  the next wave with them.
- **Effort:** 39 cards, 65.5 agent-days of task work (Opus 26.5, Sonnet 38.25, Haiku 0.75) plus 3.5 Opus days of
  reviews (0.5 spent on the spec review): 69.0 nominal agent-days, **≈96 points still to spend (≈US$3.7-4.4k
  weighted)**. Opus only for the design-heavy cards; single Opus reviewers; T67 has no review agent; the soak's hourly
  checks are a shell watchdog, not an agent.

| Window | Work | Agent-days | Points |
| --- | --- | ---: | --- |
| Week A: 10-23 16:00 → 10-30 16:00 | T67, T72, W0 spill (T68-T71, T73), W1, T87, T88, T99, W2, reviews, T92 | ≈50.25 | ≈70 |
| Week A, after the soak starts | W3's T97, T93, T95, launched only while usage ≤78%; launches stop at 85%; parallel agents capped so no 5-hour window passes 85% | +5.5 | ≈77-79; ≥11 held for fix loops, a gate S re-run and soak diagnosis |
| Week B: 10-30 16:00 → 11-06 16:00 | rest of W3 with reviews (9.5), W4 (2.5), W5 (0.5), T92 (0.25), soak-failure diagnosis reserve (≈2.0) | 12.75-14.75 | ≈18-21 |
| Week C: from 11-06 16:00, only if F4 runs late | a soak restart (diagnosis, gate S, W4 again), a late start, or decision 32's remote check | 2-5.5 | ≈3-8 |

- **Pacing (owner rule):** ≤90% weekly use → several parallel agents; above 90% → one or two agents, single reviewers,
  no optional work, Sonnet preferred; above 99% on any window → pause at a safe point, report, resume only on the
  owner's request (even after a reset).

## Schedule

| Wave | When (UTC) | Cards | Ends with |
| --- | --- | --- | --- |
| 0 | folded into W1's start (10-23) | T67, T72 | this record |
| 1 | Fri 10-23 → Sun 10-25 | T68-T71, T73 (W0 spill), T74-T82; T87, T88, T99 start | **gate M** (T82); the benchmark if the slots allowed |
| 2 | Sat 10-24 → Tue 10-27 | T83-T91 | C1, C2 measured; **gate S** (T91); tag `f4-soak-start` |
| Soak | Wed 10-28 00:00 → Wed 11-04 00:30 | T92 | soak ends |
| 3 | before gate S (owner, 10-24) | T93-T98, T100; T99 if its proofs pass first, else after the soak | UI merged before the soak |
| 4 | Wed 11-04 → Fri 11-06 | T101-T104; W3's full check | C4 and E6 measured |
| 5 | Fri 11-06 | T105 | **gate X**, phase close |

**Merge order** (one owner per shared file; cards that share no file may merge in either order): W1 T72 → T74 → T81
→ T76 → T77 → T75 → T78 → T79 → T80; W2 T83 → T84 → T88 → T87, with T85, T86 → T89 and T90 outside that chain; W3
T93 → T95 → T94 → T97 → T96 → T98, then T99 and T100. `docs/plan.md` is owned T67 → T100 → T105.

Slack: the soak may start as late as Mon 11-02 (close about 11-10); a soak failure on day 6 moves the close to about
11-13 (Q13); decision 32's remote check adds about one day. If F4 runs past weeks 16-18, F5 and the owner's real use at
its end slip one for one; F5 design work may overlap the soak only after W3 merges and while week B keeps ≥10 points.

**Plan boxes → cards.** MATCH, REFRESH, AUDIT, fingerprints, outcome cache: T83, T84, T85, T74. Money cap, duty cycle,
autonomy, risk, change-sets with undo: T76, T75, T77 (+ T84 overview versions, T83 relation runs). Overview writer on
placed topics: T84. Event bus; Activity and status: T81; T86, T93. Inbox, icicle diffs, onboarding, Settings ›
Knowledge: T94, T95, T96 (+ T90, T103), T98. Hardware and setups: T97 (+ T69). Settings inventory: T68, T98. Legacy
drop: T78, T82. MLX constrained decoding: T72, T99, T102. Benchmark and runtime spike: T69, T70, T73. Two neighbours:
T71, T88. The 7-day soak: T89, T91, T92, T101. Identity grouping: T71, T87. Ask stored vectors: T79, T82. Ask cancel:
T80. T64r follow-ups: T87, T72, T80.

## Not in F4

The shell, rail, router, panel stack, Home, Cmd-K, `search.omni` and the complete objects layer; Settings v2 with
"changed from default" markers and search; Map › Shape (reuses T95) and Map › Relations with the Atlas spike (F5;
Atlas F6); Playwright-Electron journeys; the remaining 6 pollers and `object.changed`; a P0 spill to a remote lane;
per-row `ts_config`, `root_source_id`, `search_tsv` on wiki sections; removing the Jobs screen and the legacy Review
queue; an in-app "Verify on this Mac" benchmark (F5 or later). Adopting any benchmarked model, quantization or runtime
(after the program, decision 26); the MLX embedding adapter (F3 D40); recalibration from real Keep and Remove and X2
(F6); windowed ingestion, the design-system finish and the sigma 4 spike (F6); re-matching the owner's library (Q8);
upgrading the owner's DEV profile to F4 code (after the close, Q11); parallel calls inside one import (F5, owner).
