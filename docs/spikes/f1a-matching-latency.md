# Note-matching latency on the golden library: recommendation (2026-10-15)

Outcome: the owner chose the decide-only compact contract with explanations written on demand (decision 16 in
`docs/plan.md`).

**Bottom line.** No change inside F1a's current rules gets the golden library to 3.47 s/note or less with high confidence.

- **If decider prose stays (today's rule):** the best low-risk option is A2+D at about 3.55 s/note.
- **Smallest change predicted to reach the target:** C+D, a v9 contract where the decider writes no prose and returns compact output. It is predicted at 3.29 s/note, but confidence is only medium (about 60-70%).
- **What C+D needs:** the owner's approval, because it removes the decider's explanations. That is F3's "explain later" work. Until then, relations would show the generic text, or the F3 task would have to be pulled forward.
- **Recommendation:** treat the F1a exit as met on the fixture (2.96 s/note). Either let F3 close the golden gap, or approve C+D with the generic text and measure it with section 4.

## Scope and method

- **Data.** Golden F1a run `.cache/golden/runs/2026-10-15T00-47-40-446Z`: 160 notes, 151 note-matching calls, contract `atomic-note-matching-v8`. Route: `openai-codex` / `gpt-5.6-luna`, reasoning `low`, reasoning summary `auto`. Fixture: 138 notes, 116 calls (`matching-fixture-f1a-pinned`). v6 baseline: 10.4 s/note.
- **KPI.** Seconds per note = sum of note-matching call durations / notes (`scripts/golden/matching-evaluation.ts:501`).
  - Target: 3.47 s/note.
  - Measured: 4.29 on golden, 2.96 on the fixture.
- **Token counts are exact.** They come from the provider's attribution items. On all 442 calls, outputTokens = visible + reasoning.
- **Time model.** Robust fit on the 267 F1a calls: duration = 1.20 s + 5.27 ms per visible token + 8.91 ms per reasoning token.
  - Three other fits give a = 1.24-1.32 s, b = 5.27-5.61 ms and c = 7.76-8.24 ms. Every prediction below gives the range over these fits.
  - Input size has no measurable effect (-0.36 ± 0.35 ms per token).
  - Cached input was 0 on every call.
  - Calls ran strictly one at a time.
- **Code checked** on branch `refactoring` at 981b53a (the F1a KPI docs are in 7fe658c).
- **Verified code facts:**
  - The decide default `reasoningLevel: "off"` (`ai-task-parameters.ts:31`) is overridden by the profile's `low`, which is spread after it (`:62-63`).
  - The lowest level luna accepts is `low` (`packages/ai/src/reasoning.ts:149-154`).
  - The adapter adds `summary: "auto"` whenever effort is not `none` (`openai-codex.ts:294-301`). The summary is only used as watchdog progress (`:205-213`).
  - `max_output_tokens` is not sent on this route.
  - The decide-class deadline is 45 s total and 20 s stall (`packages/ai/src/remote-execution.ts`).

## 1. Where the 4.29 s/note goes

| Component | Golden s/note | Share | Range over fits | Fixture s/note | What drives it |
| --- | --- | --- | --- | --- | --- |
| Fixed cost per call | 1.14 | 27% | 1.14-1.25 | 1.01 | 151 calls (0.94 per note) at 1.20-1.32 s each; the fastest real calls take 1.32-1.44 s |
| Reasoning tokens | 1.38 | 32% | 1.20-1.38 | 0.93 | 24,749 tokens, 164 per call, about 68 + 11.9 per candidate. `low` is luna's floor. |
| Explanation text | 0.52 | 12% | 0.52-0.56 | 0.43 | 562 explanations (every score ≥ 0.5), 15,853 tokens. 270 of them (47.6% of the tokens) are on verdicts that can never be accepted; at most 105 reach a persisted relation. |
| Explanation key and quotes | 0.07 | 2% | 0.07-0.08 | 0.06 | 2,248 tokens |
| Decision keys, quotes, decimal scores | 0.40 | 9% | 0.40-0.42 | 0.22 | 12,051 tokens. A keyed object costs 17.7 tokens per candidate against 7.6 for `[1,55,"extends"]`; `0.55` is 3 tokens and `55` is 1. |
| Decision values and envelope | 0.33 | 8% | 0.33-0.35 | 0.20 | 1,190 candidates, 7.9 per call (fixture 5.0) |
| Unexplained tail | 0.45 | 10% | 0.36-0.60 | 0.11 | Backend variance, roughly a fixed amount per call; includes one 23.6 s call. The worst of the four v8 runs (the others: 0.03-0.15 s/note). |
| **Total** | **4.29** | | | **2.96** | |

- **Fixed cost and reasoning: 59%.** They depend on the number of calls and on the reasoning level, not on the output format.
- **Visible output: 1.32 s/note.** Explanations take 0.60 and JSON structure 0.40. These are the only levers that need no change of route or call pattern.
- **Golden vs fixture.** Golden is slower because it has more candidates per call (7.9 vs 5.0), more calls per note (0.94 vs 0.84) and a worse tail. The per-token rates are the same.
- **Outside the KPI.**
  - Non-AI work between calls totals 9.8 s (0.06 s/note, median gap 64 ms).
  - The stage wall time is 695.4 s, against 685.6 s of call time.

## 2. Ranked fixes

Predictions keep golden's own tail of 0.45 s/note and assume no change in reasoning tokens unless stated otherwise.

| Rank | Fix | Golden s/note | Fixture s/note | ≤ 3.47? | Quality risk | Phase and rule status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **C+D**: v9 decide-only contract with compact positional output; prose written later | **3.29** (3.18-3.30) | 2.25 (2.17-2.25) | Yes, medium confidence (60-70%) | Medium | Removes decider prose: F3 "explain later", or the generic text until F3. Rule rewrite in the same change. |
| 2 | **Summary off** on decide calls | 3.72-4.29 alone; **2.73-3.29 on C+D** | 2.58-2.96; 1.87-2.25 | Not alone | None | F1a-compatible, adapter only; needs one probe |
| 3 | **E2**: two source notes per decide call | On C+D: 2.61-2.73, or 2.35-2.46 if reasoning is shared. On A2+D: 2.92-3.02. On D: 3.20-3.29. | 1.65-1.74 (1.41-1.50) on C+D | Yes | High, unmeasured | New multi-source contract; fits F3 per-source matching |
| 4 | **A2+D**: compact output; eager prose only on acceptable verdicts (≥ 0.65, non-weak type) | 3.54-3.59 | 2.56-2.58 | No (misses by 0.07-0.12) | Low-medium | Rule wording holds while minRerankScore ≥ 0.65 |
| 5 | **C alone** (decide-only, keyed objects) | 3.62-3.69 | 2.42-2.47 | No | Medium | As C+D |
| 6 | **D alone** (compact; eager prose at ≥ 0.5 kept) | 3.82-3.85 | 2.69-2.70 | No | Low-medium (score scale) | No rule change |
| 7 | **A / A2**: explanation threshold 0.65 | 4.00-4.03 | 2.82-2.84 | No | Low-medium | As A2+D |
| 8 | **E1**: list only candidates ≥ 0.5 (on C+D) | 3.02-3.16 | 2.11-2.20 | Yes | Medium | Conflicts with the raw-score rule; rejected |
| 9 | **Reasoning effort none** | 2.91-3.47 alone; 1.91-2.48 on C+D | 2.03-2.41 | Unknown | High | Not offered for luna; decider choice is the F3 bake-off |
| 10 | **B**: decide-only plus a separate explain call per note | 4.78 (4.03-5.86) | 3.67 | No | Low | Worse than today; it is the F3 explain path paid eagerly |

**Not levers for this KPI:**

- **Hedging slow calls with a duplicate request:** saves 0.07-0.11 s/note and costs about 21 duplicate calls per run.
- **Prompt trimming or prompt caching:** under 0.05 s/note. Input tokens have no measurable cost, and the 470-token prefix is below the 1,024-token caching minimum.
- **Non-AI work:** at most 0.06 s/note.
- **Two concurrent Codex calls:** wall time drops to about 2.2 s/note, but the KPI sums call durations. Bounded remote concurrency is also an F3 target.
- **Capping candidates per call:** loses relations. The top 8 aliases hold only 84.6% of the acceptable verdicts, which breaks the lossless-filter rule.

### Rank 1: C+D, a decide-only compact contract (`atomic-note-matching-v9`)

**What changes.**

- The decider returns `{"results":[[1,55,"extends"],[2,0,"related"]]}`: a numeric alias, an integer score from 0 to 100 (stored as n/100) and the type, once for every candidate.
- No member holds prose. On golden this removes 30,152 visible tokens: 18,101 of explanations and 12,051 of structure. That leaves 7.56 tokens per candidate.

**Sensitivity.** Golden s/note under the two unknowns:

| Reasoning change per removed explanation | Quiet run (tail 0.03-0.15) | Golden F1a tail (0.45) | Golden tail + one 20 s stall |
| --- | --- | --- | --- |
| -3 | 2.78-2.90 | 3.20 | 3.32 |
| 0 | 2.87-2.99 | 3.29 | 3.42 |
| +3 | 2.96-3.08 | 3.39 | 3.51 |
| +10 | 3.18-3.30 | 3.61 | 3.73 |
| +20 | 3.50-3.62 | 3.92 | 4.04 |

- **The reasoning response is not identified.** Within v8, the -3 ± 1.6 tokens per explained item reflects how hard a note is, not a cause. Across contracts, v6 used about half the reasoning the v8 model predicts for it. The direction is unknown.
- **Break-even.** About +6 reasoning tokens per removed explanation under golden's tail, and about +19 in a quiet run.
- **Run-to-run tail noise** (0.2-0.4 s/note) is larger than the 0.18 s margin.

**Quality risk: medium.**

- **No systematic score shift is expected.**
  - The score comes before the explanation in every item, so an item's own explanation cannot affect its score.
  - From v6 to v8 the mean score moved by only -0.017.
  - Spike A2 found typed answers identical to predicate-only ones.
- **Expect a contract-change level of re-drawing.**
  - About 15% of pairs cross 0.65, against 7-11% between two runs of the same contract.
  - Types agree on only 70-74% of pairs between v8 runs.
- **The 0-100 scale may change rounding at the threshold.** Today scores pile up at 0.6 (117 items) and 0.7 (117), with only 20 at 0.65, which is the acceptance threshold.
- **One run cannot detect a small loss.** The persisted golden relation count (105) moves by about ±7 between runs, so a loss of 10 or fewer is invisible. Judge with paired comparisons (section 4).
- **Fallback if the integer scale is rejected:** a numeric alias with a decimal score gives 3.37 s/note; a string alias with a decimal score gives 3.41 / 2.31, which leaves no margin.

**Product impact.**

- Relations accepted under v9 store the existing localized fallback `knowledge.relations.explanations.reranked` ("The notes passed the hybrid similarity threshold after batch reranking."). This is already used for relations accepted from a reverse verdict (`knowledge-service.ts:1906-1913`).
- The text stays until `relation.explain` exists.
- Writing prose later costs about 1.2 s plus about 40 visible and about 50 reasoning tokens per explanation. That is about 190 s to view all 105 golden relations, off the matching path and outside the KPI.

**Rule implications.**

- **Untagged rule to rewrite.** `rules/knowledge.md` (Relations), first bullet: "The decider explains only candidates it scores at a fixed threshold that could be accepted". It is true today, and C changes it. RULES.md section 1 requires the rewrite in the same change, for example: "The decider writes no prose; explanations are written later and only for persisted relations".
- **F3 work.** The F3-tagged bullet ("type, direction and explanation are assigned only to accepted pairs") and plan 4.2 step 5 ("Explain later") already describe the target. Lazy `relation.explain` is the F3 task "Decide → type (batched per source) → explain later … streaming `relation.explain` with cache". `rules/index.md` forbids building `(target F3)` behavior outside its phase task, so the owner must either pull that task forward or accept the generic text until F3.
- **`rules/ai.md`.** The tuple is validated with Zod. Aliases are still resolved by the backend. The prompt changes as a new `notes.match` revision in the catalog.
- **Cache.** The decider key includes the prompt fingerprint, so every cached decision is judged again once.

**Files to change.**

- `apps/desktop/src/main/services/knowledge-processing.ts`: `atomicNoteMatchingVersion` → v9, `batchRerankDecisionSchema` → tuple, `parseBatchRerankOutput`. Remove `rerankExplanationMinScore`, `maxRerankExplanationCharacters` and `safeRerankExplanation` from the decide path. Repair only missing or malformed items.
- `packages/domain/src/prompt-defaults.ts`: `notes.match` template and contract; drop `explanation_min_score`.
- `packages/domain/src/prompt-definitions.ts`: keys and sample values.
- `packages/i18n/src/locales/*.json`: prompt-variable labels.
- `apps/desktop/src/main/services/knowledge-service.ts`: persist the fallback key; drop the explanation-repair condition.
- `apps/desktop/src/main/services/prompt-samples.ts`.
- Tests: `knowledge-processing.test.ts`, `atomic-note-matching.test.ts`, `prompt-determinism.test.ts`, `automatic-wiki-prompts.test.ts`.
- `rules/knowledge.md`.
- F3 part (lazy prose): a relation-explanation service, its IPC, and the renderer (`KnowledgeGraphDashboard.tsx`, Note page).

**Confidence.** High for the token arithmetic (savings of 0.97-1.06 s/note under every fit). Medium (60-70%) that one golden re-record lands at 3.47 or less.

### Rank 2: drop the reasoning summary on decide calls

**What changes.** For the `decide` workload class, send `reasoning: {effort}` without `summary: "auto"`. Optionally also drop `include: ["reasoning.encrypted_content"]`, since the call has a single turn and `store: false`.

**Hypothesis.** Reasoning tokens cost 8.2-8.9 ms against 5.3 ms for visible tokens in every dataset, and the summary may cause the gap. Upper bound: 24,749 tokens × 3.6 ms ≈ -0.56 s/note on golden. The lower bound is 0.

**Quality risk: none for decisions.** Only the progress signal before the answer is lost. The stall limit (20 s) and the answer-start limit (30 s) still bound the wait.

**Rule implications.**

- `rules/ai.md` still holds: only progress keeps a stream alive, and a non-high-reasoning request must start answering within the bound.
- The audit must record the effective parameters, including the summary setting.
- The backend must be probed once to confirm it accepts the request without the summary.

**Files to change.** `packages/ai/src/openai-codex.ts` (`codexGenerationParameters` takes the workload class) and `openai-codex.test.ts`.

**Confidence.** Low for the size (0 to -0.56 s/note), but it is cheap and has no quality risk. Measure it in the same campaign as C+D.

### Rank 3: E2, two source notes per decide call

**What changes.**

- Group the notes of one source item in document order, two per call. Golden calls drop from 151 to 76, the fixture from 116 to 58.
- Each merged call saves the fixed cost (1.20-1.32 s). It may also share the reasoning intercept (68 tokens, about 0.6 s).
- This is the only way below 3.47 that keeps eager prose (D+E2 3.20-3.29; A2+D+E2 2.92-3.02).

**Quality risk: high and unmeasured.**

- Judgments can leak between the two sources. Spike A2 shows request makeup alone flips 7-9% of decisions.
- One failed call loses two notes.
- Larger outputs raise the p95.

**Rule implications.**

- "A generative decider judges each unordered pair once": deduplicate mutual pairs inside a group (and handle `findReverseVerdicts`).
- "A required decider that fails … fails the note visibly, before its checkpoint": a failed group fails both notes, so checkpoint per group.
- `rules/ai.md`: groups and their order follow document position.
- Grouping per source is the shape of F3's per-source matching.

**Files to change.**

- `knowledge-service.ts` `matchAtomicNotes`: group loop, deduplication, checkpoints.
- `knowledge-processing.ts`: multi-source prompt and parser keyed by source and candidate alias.
- `prompt-defaults.ts` and `prompt-definitions.ts`.
- `scripts/golden/matching-evaluation.ts` and `-db.ts`: attribute a two-note call to both notes.
- Tests.

**Confidence.** Medium for the fixed-cost saving; low for shared reasoning and for quality. Do not build it on the Codex route before the F3 bake-off: if the local reranker becomes the default, this route is only the fallback.

### Rank 4: A2+D, the fallback if decider prose must stay

**What changes.** Positional integer arrays. A fourth element holds the explanation only when the score is ≥ 0.65 and the type is not weak (292 verdicts on golden).

**Quality risk: low-medium.**

- The model may score 0.6 instead of 0.65 to avoid writing an explanation. Golden already has 117 items at 0.6 against 20 at 0.65.
- The scale risk of D also applies.

**Rule implications.**

- "Explains only candidates it scores at a fixed threshold that could be accepted" stays true only while `minRerankScore` ≥ 0.65. That is the default and the presets, but the setting allows 0-1.
- The code comment at `knowledge-processing.ts:813-817` keeps the explanation threshold apart from calibration on purpose. A2 ties the two together in practice.

**Files to change.** `knowledge-processing.ts`, `prompt-defaults.ts`, `prompt-definitions.ts`, tests.

**Result.** It misses under every fit (3.51-3.59). With the summary dropped it gives 3.02-3.59, which reaches 3.47 only if rank 2 turns out large.

### Ranks 5-10, briefly

- **C alone (3.62-3.69) and D alone (3.82-3.85).** Each misses on its own; together they make rank 1.
- **A / A2 (4.00-4.03).** Saves only 0.25-0.29 s/note and carries the 0.6-vs-0.65 risk.
- **E1, sparse list.** An omitted candidate cannot be told apart from a 0 or from truncation. Storing 0 would invent a raw score that the decider never produced ("Decisions keep each direction's raw score"). It also breaks "Return every candidate exactly once". Rejected.
- **Reasoning effort none.** `openAiCodexSupportedReasoningLevels` lists luna from `low` only, and whether the backend accepts `none` is untested. A different decide model changes the calibration and needs the full fixture benchmark again. `rules/ai.md` requires a validated capability first, and choosing the decider is the F3 bake-off.
- **B, separate explain call.** Each extra call pays the 1.2-1.3 s fixed cost, so B cannot beat C.

## 3. Can ≤ 3.47 s/note be reached with high confidence in F1a?

**No, not without F3 work.**

**Keeping decider prose (today's rule).**

- The best low-risk combination is A2+D at 3.54-3.59 golden (2.56-2.58 fixture), about 34-35% of v6.
- Dropping the summary could bring it to 3.0-3.6, but that effect is an unmeasured hypothesis whose lower bound is zero.
- The only way below 3.47 is batching notes (E2). That needs a new multi-source contract with high, unmeasured quality risk, which is not a small change.

**Smallest change predicted to reach the target: C+D.**

- **Prediction:** 3.29 s/note (3.18-3.30 across fits). It is one contract bump, v9.
- **Owner decision first:** C+D removes decider prose, which is F3's "explain later". The owner must approve either the generic text until F3 or pulling the `relation.explain` task forward. The rule changes in the same commit.
- **Medium confidence only (60-70%):**
  - The reasoning response is unidentified. About +6 tokens per removed explanation already breaks even under golden's tail.
  - One run's tail varies by 0.2-0.4 s/note, more than the 0.18 s margin.

**High confidence needs a margin of about 0.5 s/note.** That takes C+D plus fewer calls (E2: 2.35-2.73) or less reasoning (the summary drop proven large, or effort `none` on a validated decide model). Both are F3-class work: workload classes, the AiScheduler, the decider bake-off and per-source batching.

**Realistic floors.**

| Scope | Golden s/note | Fixture s/note |
| --- | --- | --- |
| F1a, prose kept, low risk (A2+D) | about 3.55 (34% of v6) | about 2.56 |
| C+D (prose deferred) | 3.29 at golden F1a's tail; 2.9-3.4 likely | about 2.25 |
| C+D + summary off, if the hypothesis holds | 2.7-3.3 | 1.9-2.3 |
| Codex luna, fixed cost alone at one call per note | 1.1-1.25 | 1.0-1.1 |
| C+D + E2 | 2.35-2.73 | 1.41-1.74 |
| F3 default local decider (MLX Qwen3-Reranker) | about 0.4 for the decide step | n/a |

The local decider figure comes from Spike A: 200 notes × 8 candidates scored both ways in 1.40 min. The batched type call per source comes on top.

**Recommendation.**

1. **The F1a exit is already met on the fixture** (2.96 s/note, 0/35, 27/28; decision 15). Record golden 4.29 and this breakdown as the known gap that F3 closes. F3 brings explain later, 0 prose tokens for rejected candidates, and the local decider, which turns this route into the fallback.
2. **If the owner wants the golden number in F1a:** approve C+D (v9) with the generic explanation text, add the summary-off change behind a probe, and measure with section 4.
   - Expect about 3.3 s/note, with a likely range of 2.9-3.4.
   - Accept up front that a single run can land at 3.4-3.6.
   - C+D is not throwaway: F3's generative fallback is decision-only too.
3. **Do not pursue E1, B, candidate caps, hedging, prompt trimming or concurrency for this KPI.** Do not build E2 on the Codex route before the F3 bake-off.

## 4. How to measure (live matching only, extraction served from cassettes)

**How the cassette serves extraction.** In record mode a cassette folder serves every call it already holds and calls the provider only for new keys. Summaries, notes, embeddings and the knowledge graph have unchanged prompts, so a copy of the F1a cassette serves them. The v9 note-matching prompts are new keys, so only matching runs live. Source matching also runs live if its prompt changes; it is excluded from the KPI.

- Use a **fresh copy per sample**. Recording into a folder that already holds a v9 run would serve that run instead of asking again.
- After each run, check `summary.json`: `cassette.byTask` should show recordings only under `reranking`, and `misses` should be 0.
- Leave `MEMORA_GOLDEN_EXIT=1` out on fixture runs and evaluate while DEV PostgreSQL is up, or evaluate the next run's pre-run backup.

**M0. Probe (summary off only).** A 3-root fixture dry run (`MEMORA_GOLDEN_ONLY=mf-p01,mf-p02,mf-p03`) on a fresh cassette copy. It confirms the backend accepts the request and still reports reasoning tokens.

**M1. Fixture, pinned notes (quality gate and fixture s/note). Two v9 samples.**

```sh
cp -R .cache/golden/cassettes/matching-fixture-f1a-pinned .cache/golden/cassettes/matching-fixture-v9-a
MEMORA_AI_CASSETTE=record MEMORA_AI_CASSETTE_DIR=.cache/golden/cassettes/matching-fixture-v9-a \
MEMORA_GOLDEN_RUN=.cache/golden/matching-fixture/manifest.json MEMORA_GOLDEN_RESET=1 \
MEMORA_GOLDEN_RESET_ALSO=scripts/golden/manifest.json MEMORA_GOLDEN_MAX_TOKENS=400000 \
MEMORA_DEV_BACKGROUND=1 npm run dev -w @app/desktop
npx tsx scripts/golden/evaluate-matching.ts --db <dev-connection.json> --label "v9 fixture a" \
  --out .cache/golden/matching-v9a.md --json .cache/golden/matching-v9a.json --check
```

Repeat with `matching-fixture-v9-b`. Compare with the three v8 runs: held-out note layer 24 / 22 / 22 of 28, notes or sources 27/28, and 0/35 forbidden.

**M2. Golden (the KPI).**

```sh
cp -R .cache/golden/cassettes/golden-small-f1a .cache/golden/cassettes/golden-small-v9-a
MEMORA_AI_CASSETTE=record MEMORA_AI_CASSETTE_DIR=.cache/golden/cassettes/golden-small-v9-a \
MEMORA_GOLDEN_RUN=scripts/golden/manifest.json MEMORA_GOLDEN_RESET=1 \
MEMORA_GOLDEN_RESET_ALSO=.cache/golden/matching-fixture/manifest.json MEMORA_GOLDEN_MAX_TOKENS=500000 \
MEMORA_GOLDEN_EXIT=1 MEMORA_DEV_BACKGROUND=1 npm run dev -w @app/desktop
```

- **KPI:** sum of `durationMs` of the note-matching responses recorded in this run / 160.
- **Also report:**
  - p50 and p95 call time;
  - input, visible and reasoning tokens per call;
  - repairs;
  - persisted note relations;
  - the score histogram around 65.

**M3. Same-day v8 control.** The backend tail varies by 0.03-0.45 s/note between runs, which is more than the margin.

- Run the v8 build (a worktree at 981b53a) back to back with M2.
- Use a copy of `golden-small-f1a` without the note-matching entries recorded on 2026-10-15: taskType `reranking`, input containing "Decide whether the source atomic note".
- On the same 151 source notes, this gives:
  - the same-day v8 s/note;
  - **paired reasoning tokens per source note**, v8 against v9, which is the main unknown;
  - paired score agreement: the share crossing 0.65, type agreement and overlap of the accepted sets;
  - the v8-against-v8 noise floor against the F1a run.

**Acceptance (fix these before running; report every run, never only the best).**

- **Latency:**
  - golden v9 ≤ 3.47 s/note;
  - the fixture does not get slower than 2.96;
  - repairs ≤ 2%.
- **Fixture quality, in both samples:**
  - 0/35 forbidden;
  - ≥ 27/28 expected on notes or sources;
  - held-out note layer within the v8 range (22-24/28).
- **Golden quality:**
  - persisted note relations within about 10 of the same-day v8 control;
  - paired v8-to-v9 crossing rate at 0.65 no more than 5 points above the v8-to-v8 floor;
  - the decider's P(score ≥ 0.65) within 3 points of v8;
  - no new pile-up just under 65.
- **If v9 misses 3.47:**
  - Read M3 first. If reasoning rose by more than about 6 tokens per removed explanation, C does not pay on this route.
  - If the v8 control is also slow, report both runs and the value adjusted by the per-call model, instead of re-running until one passes.
- **Summary off:** compare the robust per-call cost of a reasoning token (ms per token) between runs with and without the summary, not s/note, because the tail dominates s/note. Two fixture runs are enough.

## Evidence

Analysis scripts and raw outputs were kept in the session scratchpad (`latency/`), not in the repository:

- `cassette-model/results.txt`: composition and time model.
- `overhead/oh_output.txt`: request body, prompt size, gaps between calls.
- `verify/results.txt` and `verify/out_*.txt`: independent reproduction, corrections, run tails, reasoning response, paired score agreement.
- `final/final.py` and `final/out_final.txt`: the attribution table, the D, D+E2 and A2+D+E2 combinations, and the C+D sensitivity grid in this document.
