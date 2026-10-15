# Source relations ("Relações entre fontes"): performance plan (2026-10-15)

Outcome: the owner chose A+B in F1b, the E spike now and E in F3 (decision 17 in `docs/plan.md`). Supporting
scripts and raw outputs stayed in the session scratchpad (`srcrel/{cost,quality,sim,verify}`), not in the repository.

Route: `openai-codex` / `gpt-5.6-luna`, reasoning `low`. Contract: `source-relations-v4`. Preset: `recommended-v1` (30 candidates, 6 pairs, 2 chunks × 800 characters, importance ≥ 0.85, confidence ≥ 0.80).

## Answer in short

**Yes, the plan covers source relations, in two steps.**

**F1b, now and low risk:**
- Judge each source pair only once.
- Switch source matching to a short score-only answer, with no prose. The explanation is written when the owner opens a relation. This is decision 16, applied to sources.
- Predicted fixture time: 20.3 → about 14.9 s per source (range 10–17), roughly −26%.
- Predicted golden-library time: 15.3 → about 13.6 s per source.
- The quality bar does not change.

**F3, the large gain:**
- Stop sending each source's 6 candidate pairs to the model.
  - A pair of sources that already has an accepted note relation gets a source relation with no AI call.
  - The other pairs come from each source's nearest source, and each gets one short accept/reject call.
- Each source runs as soon as its notes are matched, without waiting for the rest of the batch.
- Predicted time: about 3.8 s per source (range 3.1–6.0), about −81%.
- In the simulation over recorded answers, held-out quality was 27, 27 and 28 of 28 expected pairs, with 0/35 forbidden.
- This depends on an assumption nobody has measured yet, so a short spike comes first.

**Why not do everything in F1b.** Most of the cost is the fixed cost per call plus reasoning, which together are 72% of the time. Only fewer calls removes that. Fewer calls means changing where source relations come from, which the rules tag as F3. It also depends on that unmeasured assumption.

## 1. Today

### 1.1 How it runs

**Batch barrier, then one source at a time.**
- Source matching starts only after every item in the batch has finished summaries, embeddings, notes and note matching (`job-supervisor.ts:943-968`).
- Sources then run one at a time, and each source's pairs run one at a time.
- On FIX1 this stage alone took 21.5 minutes of wall time after note matching.

**Per source:**
- The candidate shortlist is built from four signals: a trigram match across all text, unused note relations, shared concepts and vector search. They are combined by rank fusion, and note-linked and discovery candidates are interleaved.
- Up to 6 new pairs are kept. All 60 fixture sources hit that cap.
- Each pair gets one `sources.match` call. The prompt averages about 1,520 input tokens.
- The answer has 0–4 items with 15 fields each, including three prose fields (`sourceIdea`, `targetIdea`, `explanation`).
- A relation is kept only if it passes the floors: durable, grounded, importance ≥ 0.85, confidence ≥ 0.80, and a non-weak type.

**This conflicts with two current rules.** `rules/knowledge.md:68-69` and `:85-86` are not tagged with a target phase: "the decider writes no prose" and "explanations are written only when the owner opens a relation". Source matching writes all three prose fields for every proposal, in the background. Either the code changes or those rules must be narrowed to note relations.

### 1.2 Where the time goes

| | FIX1 (v8, every call live) | FIX3 (v8 final, timed as if live) | GOLD (timed as if live) |
| --- | --- | --- | --- |
| Sources (roots) / notes | 60 / 138 | 60 / 138 | 10 / 160 |
| Calls per source | 6.10 | 6.18 | 4.4 |
| **Seconds per source** (mean; p50 / p95) | **19.7** (21.2 counting one failed 90 s repair) | **20.25** (21.4 / 32.5) | **15.3** (18.7 / 22.1) |
| Seconds per note, source matching | 8.6 | 8.8 | 0.96 |
| Seconds per note, note matching (same run) | 2.94 (v8) | 2.96 (v8) | 2.75 (v9) |
| Seconds per call (p50 / p95) | 2.87 / 6.72 | 2.90 / 6.80 | 3.05 / 5.75 |
| Tokens per call: input / output / reasoning | 1,518 / 229 / 122 | 1,520 / 235 / 129 | 2,104 / 223 / 141 |
| Proposals → passed floors → saved | 182 → 115 → 104 | 180 → 110 → 99 | 16 → 1 → 1 |

- **The cost grows with the number of sources, not the number of notes.**
  - The fixture has 60 small sources. There, source matching is about 3× note matching per note, and about 75% of all matching time.
  - The golden library has 10 large sources. There, it is about one third of note matching per note.
  - A library of many short articles behaves like the fixture.

**Where the time goes, FIX3 (seconds per source).** This uses the per-call model 1.20 s + 5.27 ms per visible token + 8.91 ms per reasoning token.

| Part | Seconds | Share |
| --- | --- | --- |
| Fixed cost per call | 7.42 | 37% |
| Reasoning (about 800 tokens per source) | 7.13 | 35% |
| Prose (ideas and explanation) | 1.73 | 9% |
| JSON structure | 1.71 | 8% |
| Unexplained tail | 2.27 | 11% |

**Time by call outcome, FIX3.**

| Outcome | Calls | Time | Share |
| --- | --- | --- | --- |
| No relations returned | 223 | 503 s | 41% |
| Proposals, none passing the floors | 48 | 258 s | 21% |
| Repairs | 11 | 49 s | 4% |
| At least one proposal passing | 89 | 406 s | 33% |

- 39% of the prose characters are written for proposals that fail the floors (93% on golden).
- On golden, 44 calls (153 s) produce one relation.

**Some pairs are judged twice.** A note relation that one side cites as evidence drops out of the other side's pair key, so the reverse side judges the same pair again.
- FIX3: 35 of 360 judgments are repeats. FIX1: 37–38. Golden: 0.
- I checked the decision rows: in every one of these pairs, the first judgment had already saved a relation. The repeats add relations to pairs that are already linked; they never link a new pair.

### 1.3 What the source layer adds to quality

**Fixture results by run.** Each cell is expected pairs linked · forbidden pairs linked · unlabelled pairs ("bridges"). Held-out has 28 expected and 35 forbidden pairs; tuning has 26 and 25.

| Run | Source layer, held-out | Source layer, tuning | Note layer, held-out | Either layer, held-out | Source calls actually live |
| --- | --- | --- | --- | --- | --- |
| OLD (Sept, old pipeline) | 27 · 0 · 4 | 26 · 0 · 25 | 27 | 28 | all |
| FIX1 (v8, first run) | 27 · 0 · 6 | 25 · 0 · 10 | 24 | 27 | all |
| FIX3 (v8, final run) | 27 · 0 · 7 | 26 · 0 · 10 | 22 | 27 | 75 of 371 |
| v8, pinned notes | 27 · 0 · 8 | 26 · 0 · 10 | 24 | 27 | mostly replayed |
| v9 sample A | 27 · 0 · 8 | 25 · 0 · 10 | 24 | 27 | about 54 |
| v9 sample B | 27 · 0 · 7 | 26 · 0 · 10 | 23 | 27 | mostly replayed |

- **The v8 range for the source layer** is held-out 27/28 and 0/35, tuning 25–26/26 and 0/25, with 6–8 held-out bridges.
- **Only FIX1 and OLD are fully live samples** of today's source layer.

**Expected held-out pairs that only the source layer finds:**
- FIX3: 5 (F3/F5, L2/L5, M3/M5, W2/W5, W3/W5). FIX1: 3. OLD: 1 (P03/V01).
- In FIX3 and FIX1 the note decider had already scored every one of them related (0.65–0.90). The pass/fail check that combines the decider score with similarity scores rejected them (final score 0.47–0.59).
- Only the tuning pair P02/P03 is found by the source layer alone in all three libraries.

**Misses and precision:**
- Q3/Q5 is missed in every FIX run. It never reached either source's 6-pair shortlist, although it is each source's third-nearest neighbour by embedding.
- The source layer made no proposal on any forbidden pair it judged (24–29 per run).
- The note decider did score two forbidden lookalike pairs at 0.70–0.80 (P06/V05, W1/W4). The combined check stopped both.

**Bridges** (all partitions: FIX3 17, FIX1 16, OLD 29):
- They come from chunk analysis, with importance just above the floor (median 0.86).
- They join dissimilar sources: median source cosine 0.49, against 0.76 for expected pairs.

**On golden, the obvious pairs are rejected.**
- Three source pairs are joined by 11, 5 and 2 accepted note relations, with cosines 0.97, 0.88 and 0.88. Each was judged and rejected; its best proposal scored 0.80–0.82.
- The one relation kept is a bridge (cosine 0.51, importance 0.86).

**Where today's source relations come from**, by evidence origin:

| Library | Total | Note relations only | Chunk analysis only | Both |
| --- | --- | --- | --- | --- |
| FIX3 | 99 | 1 | 49 | 49 |
| FIX1 | 104 | 2 | 46 | 56 |
| OLD | 97 | 1 | 49 | 47 |

Half the relations have no note link, so promoting note relations alone cannot replace the source layer.

## 2. Options, ranked

Held-out is used only to validate; every choice was made on tuning. Cells are expected · forbidden · bridges for FIX3 / FIX1 / OLD.

| # | Option | Fixture s/source (golden) | Calls per source | Held-out | Tuning (expected · forbidden) | Meets the bar? | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | Today | 20.25 (15.3) | 6.2 | 27/27/27 · 0 · 7/6/4 | 26/25/26 · 0 | yes | measured |
| A | Judge each source pair once | ~18.3 (15.3; golden has no repeats) | ~5.6 | same as today at pair level | same | yes | high |
| B | Short score-only answer per pair; explanation on open | 16.5 (13.6); range 11–18.6 | ~6.0 | assumed same as today; not measured | assumed | to be measured | cost medium; quality low–medium |
| **A+B** | **F1b proposal** | **~14.9 (13.6); range 10–17** | ~5.4 | assumed same; not measured | assumed | to be measured | medium |
| C | One batched short call per source (all ~6 pairs) | 7.3 (7.2); range 5.4–10.2 | 1 | not simulated; pairs can sway each other (7–9% flips seen in spike A2) | — | unknown | low |
| **E** | **F3 proposal: promote accepted note relations + nearest-source discovery, per source** | **3.8–3.9 (3.4)**; range 3.1–4.4; 3.3–6.0 from measured call times | 1.3 (0–4) | 27/27/28 · 0/35 · 0/1/0 | 26/26/26 · 0/25 | yes (simulated) | recall medium; precision low; cost low–medium |
| E-b | E, one batched call per new source | 3.0 | ~1 | same as E | same | yes (simulated) | low–medium |
| E-2 | E with 2 nearest sources | 4.8 (4.3) | 1.7 | 27/27/28 · 0 · 3/3/0 | 26 · 0 | yes (simulated) | medium; fallback for denser libraries |
| E-s | E as a periodic pass over the whole library | 2.0 | 0.7 | 27/27/28 · 0 · 0/1/0 | 26 · 0 | yes (simulated) | medium; not per source, so it breaks the F3 rule |
| F | Similarity floor (source cosine ≥ 0.60) | 1.5 | 0.3–0.5 | 26/27/27 · 0 · 0 | 26 · 0 | **no**: loses F3/F5 and P03/V01 at 0.57–0.58 | rejected |
| D | Promote accepted note relations only | 0.1–0.3 | 0 | 22/24/27 · 0 · 0 | 21/20/23 | **no** | rejected |
| D2 | Promote only with ≥ 2 note relations (`docs/plan.md:148`) | 0.1–0.3 | 0 | 10/12/16 | 13/14/16 | **no** | rejected |
| G | E with the local MLX reranker as the discovery judge | not modelled | 1.3 pairs | not measured on source pairs | — | — | to be decided in the F3 bake-off |

**Notes on the table:**
- **B** gets about 1.7 s per source more if the request without a reasoning summary saves 0.3 s per call. That shape is already in HEAD (commit 550ac0d) but was not active in these baselines, and the 0.3 s is unverified.
- **E's quality** is with recorded `sources.match` answers standing in for the short answer. "Pooled" borrowing of answers between libraries would show 28/28 on FIX, but that is not supported, so the figure is 27/28.
- **G:** spike A measured 36 ms per 250–300-token note pair. A source-pair input is about 1.5–2k tokens.

### What each option needs

**A: judge each pair once**
- **Code:** the pair key uses every accepted note relation between the two sources, including ones already cited as evidence. The prompt still lists only the unused ones. Add tests.
- **Prompts, migrations, rules:** none.

**B: score-only answer**
- **Code:**
  - New contract `source-relations-v5`. Items are `[from, to, type, importance 0–100, confidence 0–100, [from chunks], [to chunks]]`, with 0–2 items per pair.
  - Durable and grounded become instructions instead of fields.
  - Valid items are kept and one repair is allowed, with same-root feedback (same as v9).
  - Floors become the integer divided by 100.
  - The relation's identity becomes (source, target, type) for v5 rows. Evidence merges on upsert. A relation the owner rejected is never brought back.
  - Every returned item is stored with its raw scores in `source_matching_decisions`, so floors can be re-tuned without new calls.
  - Source relation lists show source titles, type and evidence excerpts, with the explanation on open. They cover loading, empty, error and success states, and older rows with prose still display.
- **Prompts:**
  - New `sources.decide` and its repair prompt in the catalog. The existing-relations exclusion list is removed.
  - A source version of `relations.explain` that reads the two evidence excerpts, type and direction.
- **Migration:**
  - `source_relations.source_idea`, `target_idea` and `explanation` become nullable (or take placeholders, as note relations do today).
  - A new `source_relation_explanations` cache table, mirroring 0049.
  - Baseline and manifest updated, and the migration verified on a real PostgreSQL instance.
- **Rules:** no new text; B brings code in line with the two prose rules above. `docs/plan.md` gets decision 17, an F1b task line, and a `kpi-f1b` section.

**C: batched call per source**
- **Code:** B, plus batching and per-pair checkpoints for partial answers.
- **Rules:** none.

**E: F3 design**
- **Code:**
  - Promote every accepted cross-source note relation, using the most common note-relation type and the note evidence.
  - Compute a vector per source. F2's root vector (weighted mean of its notes, chunk centroid as fallback) can be reused, but the simulation used the stored source vectors, so this must be re-checked.
  - Find the nearest neighbour among sources that have notes, plus reverse neighbours, recomputed when each source arrives.
  - Judge each unordered pair once, with B's answer format.
  - Run matching per source with no barrier (job supervisor or the F4 matching task).
  - Remove the trigram self-join, the four-signal shortlist and the 6-pair cap.
  - Re-run on a fingerprint change, so a book whose chapters arrive later is handled.
- **Prompts:** B's `sources.decide`, unchanged, so the floors carry over.
- **Migration:** an index on source vectors (or reuse of the F2 centroid tables), and possibly an origin column. Evidence `origin` already exists.
- **Rules:** remove "(target F3)" from `knowledge.md:82-84`. In `docs/plan.md` 4.2, change "≥2 accepted note pairs" to every accepted relation, and "source-centroid ANN" to nearest plus reverse. Update `architecture.md` Background jobs if the trigger moves.

**G: local reranker**
- **Code:** the F2 reranker adapter, with `decide` validated on source pairs.
- **Prompts:** the reranker instruction.
- **Rules:** `rules/ai.md`, only if the decide route changes.

## 3. Recommendation and phase placement

### F1b, now: proposed decision 17, "source matching decides without prose"

1. **A: judge each source pair once.** Estimate ≤ 0.5 day. It cannot lose a linked pair.
2. **B: score-only answer `source-relations-v5`, explanations on open.** Estimate 2–3 days, including the migration and UI.
   - Keep the floors at 0.85 / 0.80. Re-tune them on tuning only, and only if tuning falls outside 25–26/26.
   - Keep the following unchanged so the measurement isolates the contract: candidates, the 6-pair cap, interleaving, the barrier, serial execution and note matching.
3. **Measure as in section 4** and record the results in `docs/kpi-f1b.md`.
4. **Spike for F3, about 60–80 live calls.** Run B's answer format on the pairs E would judge that have no recorded answer (19 / 18 / 17 per library). Add the 31–33 forbidden pairs that E can reach in random source orders, of which 10–11 have never been judged, plus golden's pairs. Then rerun the simulation on a fully recorded set of answers.

**Predicted F1b result:** about 14.9 s per source on the fixture (10–17) and about 13.6 on golden, with the quality bar unchanged.

**Why this is not throwaway work:** the contract, parser, explain-on-open path and migration become E's discovery judge in F3.

**What not to build in F1b:**
- **C (batched call per source):** E reduces the work to about 1.3 pairs per source, so batching would be thrown away, and it adds the risk of pairs swaying each other.
- **D and F:** they fail the quality bar.

### F3

1. **Promote every accepted note relation into a source relation.**
   - This depends on the F3 directed-note-relations task; today the direction of directed types is arbitrary.
2. **Discovery from each source's nearest source** (plus reverse neighbours), among sources that have notes.
   - Each pair is judged once with the F1b answer format.
   - Switch to 2 nearest sources if a second labelled library shows lower recall.
3. **Per-source runs with no barrier**, inside the AiScheduler lanes.
   - Remove the trigram join, the four-signal shortlist and the 6-pair cap.
4. **Local MLX reranker as the discovery judge**, if the bake-off passes on source pairs.
   - The short generative answer stays as the fallback.
   - Add about 30–50 source-pair labels to the planned ~300 owner-labelled pairs.

E needs neither the reranker nor the lanes, apart from removing the barrier. It could be pulled forward right after a passing spike, but only as an explicit owner decision.

## 4. Acceptance criteria and measurement protocol

### Protocol

**1. Pin the notes.**
- Copy `.cache/golden/cassettes/matching-fixture-v9-a` to a new folder for each sample.
- Delete every `sources.match` entry from the copy.
- Extraction and note matching are then served from the cassette, and only source matching calls the provider.
- Sample B starts from its own fresh copy of the same base, never from sample A's folder.

**2. Run two fixture samples** (A and B) in record mode, then evaluate each with `scripts/golden/evaluate-matching.ts`.
- The report must show:
  - source contract `source-relations-v5` × N;
  - 0 replayed source-matching calls;
  - 0 failed calls.
- If the evaluator does not report source-matching replays, add that first.
- The note layer must equal v9 sample A (24/28 held-out, 21/26 tuning). Any note call that misses the cassette is reported.

**3. Run the golden library once** from a stripped copy of `golden-small-v9-a`. Report:
- seconds and calls per source;
- whether the three note-linked pairs are linked.

**4. Tuning first.**
- Apply the floors to the stored raw answers of the 40 tuning sources before reading held-out.
- If they are re-tuned, freeze them in a `recommended-v2` preset, then read held-out and apply the preset unchanged to sample B and golden.

**5. Timing.**
- Seconds per source from live `ai_task_runs` durations, with p50/p95 per call and visible versus reasoning tokens.
- Baselines: FIX1 live 19.7 s (21.2 with the failed call), FIX3 timed as if live 20.25 s, golden 15.3 s.
- If a result is within 10% of its target, add a same-day control run of v4 on a stripped copy (371 calls, about 21 minutes).

**6. Explanations.**
- Open 10 source relations.
- Record explanation latency p50/p95.
- Check that a second open makes 0 calls.

### Quality bar (each fixture sample, both F1b and F3)

- Source layer held-out ≥ 27/28 and 0/35 forbidden.
- Source layer tuning within the v8 range: 25–26/26 and 0/25.
- Either layer held-out ≥ 27/28.
- Held-out bridges reported, with a soft ceiling of 8 (the v8 maximum).

### F1b exit for this work

- Fixture ≤ 16.2 s per source on both samples (≤ 80% of 20.25).
- Golden ≤ 13.8 s per source (≤ 90% of 15.3).
- 0 prose tokens in source matching output.
- Repairs ≤ 2% of calls, and 0 failed calls.
- `npm run check` green, the migration verified on PostgreSQL, and `db:seed:verify` passing.

### F3 exit for this work

- Fixture and golden ≤ 5 s per source (predicted 3.8 and 3.4), with ≤ 2 calls per source on average.
- The quality bar on two samples.
- Golden's three note-linked pairs linked.
- The spike's forbidden pairs all rejected.
- A 2,000-order random replay over fully recorded answers gives 0 forbidden in every order and ≥ 27/28 in at least 95% of orders.
- Matching for a source starts without waiting for its batch siblings, and a failing source does not delay them (e2e).
- Recall confirmed on a second labelled library before freezing "1 nearest source".

## 5. Risks

1. **The short answer may not give the same verdicts as today's `sources.match`.**
   - Importance scores cluster at 0.78–0.84, just under the 0.85 floor.
   - Today's answers already flip about 8% of the time between runs, though so far only on unlabelled pairs.
   - Mitigation: store raw answers, re-tune floors on tuning only, two samples, and the spike.
2. **E's 0/35 forbidden comes mostly from how the simulation is set up.**
   - Skipping sources that have no notes removes 27 of the 35 held-out forbidden pairs.
   - In random source orders, 31–33 forbidden pairs reach the model, and 10–11 of them have never been judged. If each of those were accepted, held-out would link 1–2 forbidden pairs in 3–9% of orders.
   - Mitigation: the spike, then the full random-order replay.
3. **The fixture flatters nearest-source ranking.**
   - Source similarity separates expected from forbidden almost perfectly here (AUC 0.996), and only 27 of the 54 expected pairs are a top-1 neighbour.
   - Real libraries are denser. 2 nearest sources (4.8 s per source) is the fallback, and a second labelled library is required.
4. **Recall rests on few pairs.** E's discovery adds only 1–5 held-out pairs over the note layer. The 28/28 figure that borrows answers from other libraries is not supported.
5. **Product change: fewer bridges.** E keeps 2–5 of today's 16–29. Some are useful (`docs/archive/matching-benchmark-report.md`). The owner should decide.
6. **Source relations change meaning.**
   - There will be about one relation per pair and type (FIX3 has 99 relations on 70 pairs), with no stored ideas.
   - Older rows keep their prose.
   - Owner accept or reject must survive the identity change.
   - Promoted relations inherit any note-layer error and the arbitrary direction of note relations until the F3 direction fix lands.
7. **The cost model is fitted on the same data it predicts.**
   - The 20.27 against 20.25 match is not a validation, and the short call has never been timed.
   - The 0.3 s per call saving from the no-summary request is unverified.
   - On this route `low` is the lowest reasoning level, so "off" will not cut reasoning.
   - The hour of day shifts latency, which is why the protocol has a same-day control run.
8. **Measurement can be quietly invalidated by replays.** FIX3 was 80% replayed. The protocol must strip `sources.match` entries and check that 0 source calls were replayed.
9. **Incremental matching edge cases.**
   - Books whose chapters arrive separately change the source vector and can repeat calls.
   - Reverse neighbours must be recomputed at each arrival.
   - Removing the barrier adds concurrency races. Mitigation: per-source exclusion and fingerprints.
10. **Local reranker on source pairs is untested.** Inputs are 5–7× longer than spike A's note pairs, and the 32% loss of reverse-only acceptances is still open. The short generative answer remains the fallback.
