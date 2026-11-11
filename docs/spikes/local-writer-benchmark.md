# Local-writer benchmark: five arms on the recorded prompts (record only, 2026-11-11)

Task T69 of F4 (`docs/f4-decisions.md` D25; plan decisions 25 and 26). This is a record of measurements. It adopts
nothing and recommends nothing: decision 26 keeps today's models, quantizations and runtimes in every phase, and the
owner decides on these numbers after F7. The tables in "Generated tables" are written by
`npm run bench:writer-report` and are never edited by hand. The prose around them is written by hand and quotes only
what the tables, `.cache/f4/bench/plan.json`, the run manifests, the run logs or `.cache/f4/RUN.md` say.

## What was measured

The generative calls recorded in the golden library cassette `golden-small-f2` were replayed, with their recorded
prompts, on local writers. The harness is `scripts/bench/writer-replay.ts`. It sends each prompt through the
product's adapter, validation, salvage and repair, and records for every item:

- whether the first answer was valid, how many repair calls followed, and whether the item ended with a usable answer;
- time to first text, prefill and decode speed, call time, helper memory and swap;
- the yield: how much of what the recorded Codex answer holds the local answer holds too.

The cassette holds 661 calls (`plan.json`, `census`). Of these, 562 items are replayed per arm: 41 summary, 28 notes,
242 graph, 215 confirmation, 28 topic-names and 8 overview. The recorded Codex answers used 624,235 input and 388,102
output tokens. 159 of the 562 recorded prompts differ from what the app's prompts would build today (137 graph, 22
topic-names, `plan.json` `census.drift`); the replay uses the recorded ones, as the "Prompts" column says.

**Machine and runtime.** Every arm ran on one Apple M4 Max with 16 CPUs and 64 GiB of memory, macOS 27.0.1, on AC power,
Node v24.18.0. The runtime is the MLX Swift helper, build sha256 `44d081e0...` in all five runs (F3's helper; no
change). It reports the capabilities `cancel`, `stream` and `unload`, not `schema`: no arm asked for an output schema
and none was applied, so the "Schema modes" column reads `none` everywhere. Each run used no seed (`Seed: none`).
Sampling is on, so a second run of the same arm would not give the same answers.

**The arms.** Names are the arm ids of the tables; the table "Runs" gives the full labels.

| Arm id | Model and quantization | Where the model comes from | Sampling parameters used | Run window (UTC, from the manifest) |
| --- | --- | --- | --- | --- |
| m4b | Qwen3-4B-Instruct-2507, 4-bit | installed small writer (catalog `mlx-qwen3-4b-instruct-2507-4bit`) | temperature 0.7, topP 0.8, topK 20, max tokens 16384 (the catalog's defaults) | 2026-10-23 23:09 to 10-24 00:55 |
| m9b4 | Qwen3.5-9B, 4-bit | installed large writer (catalog `mlx-qwen3.5-9b-4bit`) | temperature 0.7, topP 0.8, topK 20, presence penalty 1.5, max tokens 32768, reasoning off (the catalog's defaults) | 10-24 00:55 to 03:37 |
| q36-35b-a3b | Qwen3.6-35B-A3B, 4-bit | downloaded, mlx-community, rev `38740b84` | same as m9b4, taken from the 9B's non-reasoning recommendation; the 3.6 model card was not read (manifest) | 10-24 03:37 to 06:43, stopped and resumed (below) |
| gemma4-26b-a4b | Gemma 4 26B-A4B, 4-bit | downloaded, mlx-community, rev `0d77464e` | temperature 1, topP 0.95, topK 64, taken from the Gemma 4 family's catalog defaults (manifest) | 10-24 06:43 to 08:32 |
| custom (Gemma 4 12B) | Gemma 4 12B it, 4-bit | downloaded, mlx-community, `gemma-4-12B-it-4bit` rev `73bcf090`, 6,773,372,848 B, sha256 verified (`f4-decisions.md`) | temperature 1, topP 0.95, topK 64, passed with `--param` | 2026-11-11 04:29 to 08:37 |

The 12B arm shows as `custom` in the tables because it ran as `--arm custom` with its model directory given; its
label, "Gemma 4 12B it 4-bit (MG12)", is in the "Runs" table. The 26B and 12B Gemma arms use the same sampling
parameters. A sixth arm is pending (below). All arms are 4-bit builds.

## How the runs went

- **One run each, on a shared machine.** The arms ran one at a time, holding the local-model slot
  (`LOCAL_MODEL_BUSY`), but other agents ran tests on the same Mac. The orchestrator's log says so for the first run:
  "W2 agents were running tests beside it (CPU load; record-only numbers carry that caveat)". The load averages
  (1, 5, 15 minutes, 16 CPUs) the manifests recorded at each start are: m4b 9.10 7.35 6.39; m9b4 2.50 3.54 4.82;
  q36-35b-a3b 29.59 25.36 18.94; gemma4-26b-a4b 7.90 9.89 12.91; Gemma 4 12B 3.76 3.85 5.32. Nothing sampled the load
  during a run.
- **The Qwen3.6-35B-A3B run was split.** It was stopped at item 441 of 562 so the Codex proofs could use the
  window while the token was valid (`RUN.md`), and resumed with `--resume`; its log shows "441 already done" and
  "Replayed 121 items". The table row is the whole run.
- **The 12B arm is a re-run: its run id ends in `v2`.** The first attempt, `gemma4-12b-recorded`, left no result.
  Its log `gemma4-12b.log` ends after the start line, there is no run folder for it, and `driver.log` records "gemma4-12b
  exit 1" at 2026-10-24T06:15:57Z, the same second as two other arms' exits when the benchmark loop was stopped for
  the Codex proofs. The logs do not say why the second run got a new id. The commands differ in one visible way: the
  second passes `--param temperature=1 --param topP=0.95 --param topK=64`. It ran on 2026-11-11 and logged 562
  items, 0 already done.
- **The 12B run ran under agent load.** `RUN.md` notes "T69 arm 5 at 237/562 after 2.4 h (51 tok/s under agent
  load)", and an agent test run at load 29 in the same window. The run log's decode speed averages 45.2 tok/s over
  items 1 to 100, then 49.1, 51.1, 51.7 and 51.0 over each following hundred. The table gives 51.3 tok/s decode
  p50 for the arm.
- **An earlier report of the first four arms agrees.** `.cache/f4/bench/report-4arms.md`, written on 2026-10-24, has
  overall rows identical to those below.

## How to read each metric

Every figure is per arm; "all" is the whole arm and the other rows are one contract each. The Codex columns score the
recorded Codex answer through the same flow, so one set of Codex numbers serves every arm.

| Table column | What it is | Depends on machine load? |
| --- | --- | --- |
| No repair needed | Items whose first answer needed no repair call and ended usable. | No |
| Clean (nothing salvaged) | Items where every part of the first answer was valid, so nothing was dropped or fixed. | No |
| Repair calls, repair share of calls | Extra calls the product's repair step made; share is of all calls. | No |
| Final valid | Items that ended usable after validation, salvage and repair. A failed item is one the product would not accept. | No |
| Salvaged items | Valid parts the flow kept when other parts of a graph answer were invalid. | No |
| Call errors | Calls the runtime itself failed (not a bad answer). | Possibly: see the 12B notes calls below |
| Wall hours | Sum of call time, repairs included. | Yes |
| TTFT, prefill, decode, call p50 / p95 | Seconds to first text; prompt tokens per second until first text; output tokens per second after it; seconds per call. | Yes |
| Output tokens vs Codex | Local output tokens of first asks over the recorded answer's. | No |
| Peak helper footprint / RSS | Highest memory the helper held, with and without GPU buffers. | Little: it follows the model and the prompt, not other processes |
| Min memory level | Lowest reading of `kern.memorystatus_level`, the percentage of memory the system still calls available. | Yes: other processes use memory |
| Yield (recall, precision, agreement, overlap, ratio) | Agreement with the one recorded Codex answer, as a mean over items with a usable local answer. | No |

Two points on the yield. It measures agreement with one Codex answer, not correctness: another Codex answer to the same
prompt would also score below 100%. And an arm with more failed items has fewer items in its mean, so the yield rows are
over different sets of items. The "Against the spike's proposed bars" table sets each arm against the proposals of
`docs/spikes/hardware-tiers-and-models.md` section 7.4. They are proposals, shown to read the numbers against.

## Caveats that matter

1. **Speed figures depend on the load of the day.** Wall hours, TTFT, prefill, decode and call time were measured on a
   machine that other agents were using. The 12B arm's decode, 51.3 tok/s at p50, was recorded under agent load and
   understates what an idle machine gives; its wall time of 4.11 hours (the longest of the five, against 1.74 to 2.85
   for the others) does too. Treat these figures as a floor for each arm. The load at the five starts, listed above, runs from 2.50 to 29.59 at the one-minute mark, so
   every arm's speed rows carry the caveat, q36-35b-a3b's most visibly. Nothing here says by how much.
2. **Validity, repair and yield figures do not depend on load.** They depend on the model, the sampling and the
   prompt. They carry sampling noise instead (no seed, one run per arm); the record holds no repeat to size it.
3. **The m4b speed columns cannot be read.** Its decode p50 is 3541.4 tok/s, and its per-contract decode p50 runs from
   1172.2 to 51010.3 tok/s. Its TTFT is almost the call time (summary: 9.1 s TTFT p50, 9.2 s call p50), and its run log
   prints values such as "31036.5 tok/s". The first text of this arm's answers arrives at about the end of the call,
   so the split into prefill and decode in the table has no meaning for it. The log does not say why. Its wall hours
   (1.74), call times and token counts are usable. For a speed that is comparable across all five arms, this note
   computed output tokens over call time from `items.ndjson` (every answered call, repairs included, prefill included):
   m4b 603,870 tokens in 6,252 s, 96.6 tok/s; m9b4 608,679 in 9,663 s, 63.0; q36-35b-a3b 818,922 in 10,251 s, 79.9;
   gemma4-26b-a4b 476,006 in 6,468 s, 73.6; Gemma 4 12B 526,295 in 12,698 s, 41.4. These are not in the generated
   tables.
4. **The 12B arm's notes calls ran very long.** Its notes row shows output tokens 6.42 times Codex's and call p95 of
   347.3 s. In `items.ndjson` six notes calls ended at 16,383 or 16,384 output tokens after 338 to 350 s, one at 13,540
   tokens after 305 s, and five notes calls and one graph call ended with `MlxHelperError: errors.localModels.runtimeFailed`
   after about 350 s with no token count (6 call errors in the table). Five notes items and one graph item ended
   with that error. The record does not show whether the 350 s is a limit of the helper or of the harness.
5. **The Codex "no repair" figure and the cassette's repair calls differ.** The Codex columns read 99.6% no repair
   needed overall, because the recorded answers are re-scored through the replay's flow. The cassette itself holds 99
   repair calls among its 661 (97 graph, 1 notes, 1 topic-names, `plan.json`). Each counts something different; do
   not set one against the other.
6. **The summary length ratios are means pulled by a few items.** The table's `lengthRatio` is 17.97 (m4b), 10.02
   (m9b4), 5.08 (q36-35b-a3b), 0.72 (gemma4-26b-a4b) and 6.50 (12B). Computed from the items for this note, the medians
   are 1.58, 0.94, 0.75, 0.73 and 0.77, and the largest single ratios are 257, 138, 114, 1.9 and 81. Read the median
   when comparing summary length. The same note applies to other mean ratios.
7. **Parameters were borrowed, not tuned.** q36-35b-a3b used the 9B's non-reasoning parameters without reading the 3.6
   model card, and the two Gemma arms used the Gemma 4 family's defaults. A different sampling setting could change
   the validity figures. No arm was run with another setting, so the record cannot say by how much.
8. **Swap growth reads 0 MiB for all five, and the 12B run began with 461.06 MiB of swap in use** (manifest). The
   growth is the peak during the run over the start, floored at 0.
9. **No arm used an output schema.** Validity here is the unconstrained writer's, as the product would run it without
   the grammar mask of F4 D24. Runs of `m9b4` with the schema sit in other folders of `.cache/f4/bench/` and are
   not part of this record.

## What the tables show

All figures are in the generated tables below (overall rows unless a contract is named).

- **Speed.** Decode p50 is 74.4 tok/s (m9b4), 91.1 (q36-35b-a3b), 90.2 (gemma4-26b-a4b) and 51.3 (12B); m4b's is
  not readable (caveat 3). `plan.json` projected 40 tok/s for m9b4 before the run, an assumption near F3's soak24
  average; the run measured 74.4. Projected against measured wall hours: m4b 1.91 and 1.74, m9b4 3.35 and 2.68, q36-35b-a3b 1.67
  and 2.85, gemma4-26b-a4b 1.71 and 1.80. The projections were assumptions, and no projection was made for the 12B arm.
- **First-answer validity.** The share of items needing no repair is 76.9% (m4b), 86.8% (m9b4), 65.5% (q36-35b-a3b),
  72.6% (gemma4-26b-a4b) and 77.6% (12B), against 99.6% for the recorded Codex answers. The repair share of calls is
  18.8%, 11.6%, 25.7%, 21.5% and 18.2%. No arm is within the spike's proposed 2% bar.
- **Where the first answers fail differs by contract.** Confirmation: m4b needs no repair on 41.4% of items, m9b4 on
  70.7%, q36-35b-a3b on 87.9%, gemma4-26b-a4b on 94.9%, the 12B on 74.9%. Graph: q36-35b-a3b needs none on 31.0% and
  its repair share is 40.8%, while the other four are at 99.6%, 99.2%, 52.1% and 81.4% (m4b, m9b4, gemma4-26b-a4b, 12B).
  Notes: gemma4-26b-a4b 42.9% and the 12B 39.3%, against 82.1% to 96.4% for the Qwen arms.
- **Final validity.** Items ending usable: 96.8% (m4b), 95.9% (m9b4), 94.5% (q36-35b-a3b), 95.6% (gemma4-26b-a4b) and
  88.8% (12B). No arm reaches the proposed 100%. The 12B's lowest contracts are overview (4 of 8 items usable) and
  notes (78.6%) and confirmation (82.3%); gemma4-26b-a4b's is topic-names (78.6%, six items ending `naming_rejected`);
  q36-35b-a3b's is graph (88.4%, 28 items ending `knowledge_graph_output_invalid:nothing_valid`).
- **Yield on the graph contract.** Entity recall is 35.0% (m4b), 42.0% (m9b4), 40.2% (q36-35b-a3b), 41.9%
  (gemma4-26b-a4b) and 44.9% (12B); relation recall 22.7%, 22.8%, 23.2%, 24.5% and 21.1%; relation precision 14.5%,
  21.6%, 39.6%, 30.4% and 28.7%. Every arm is under the proposed 85% recall bar. The recall figures sit close to
  each other; the arms differ more in precision.
- **Memory.** Peak helper footprint is 6.0 GiB (m4b), 18.6 (m9b4), 32.9 (q36-35b-a3b), 16.6 (gemma4-26b-a4b) and 9.1
  (12B), on a 64 GiB machine. The lowest memory level reading was 75 (m4b), 68 (m9b4), 34 (q36-35b-a3b), 59
  (gemma4-26b-a4b) and 75 (12B).

<!-- Generated tables follow. Regenerate with:
npm run bench:writer-report -- <the five run folders by absolute path, in table order> --out docs/spikes/local-writer-benchmark.md
(the order is m4b-recorded, m9b4-recorded, q36-35b-a3b-recorded, gemma4-26b-a4b-recorded, gemma4-12b-recorded-v2,
all under .cache/f4/bench/ of the main checkout). Only the block between the markers changes. -->

## Generated tables

<!-- writer-report:begin (generated by scripts/bench/writer-report.ts; do not edit) -->

## Runs

| Arm | Run | Prompts | Schema (asked / runtime takes it) | Items | Wall hours | Load (s) | Seed | Helper |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Qwen3-4B-Instruct-2507 4-bit (installed small writer) | m4b-recorded | recorded | no / no | 562 of 562 | 1.74 | 0.5 | none | 44d081e0 |
| Qwen3.5-9B 4-bit (installed large writer) | m9b4-recorded | recorded | no / no | 562 of 562 | 2.68 | 1.1 | none | 44d081e0 |
| Qwen3.6-35B-A3B 4-bit (downloaded, mlx-community, rev 38740b84) | q36-35b-a3b-recorded | recorded | no / no | 562 of 562 | 2.85 | 4.4 | none | 44d081e0 |
| Gemma 4 26B-A4B 4-bit (downloaded, mlx-community, rev 0d77464e) | gemma4-26b-a4b-recorded | recorded | no / no | 562 of 562 | 1.80 | 3.3 | none | 44d081e0 |
| Gemma 4 12B it 4-bit (MG12) | gemma4-12b-recorded-v2 | recorded | no / no | 562 of 562 | 4.11 | 1.4 | none | 44d081e0 |

## Structure: first answer, repairs and final validity

| Arm | Contract | Items | No repair needed | Codex: no repair | Clean (nothing salvaged) | Codex: clean | Repair calls | Repair share of calls | Final valid | Salvaged items (Codex) | Call errors | Schema modes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| m4b | summary | 41 | 100.0% | 100.0% | 100.0% | 100.0% | 0 | 0.0% | 100.0% | 0 (0) | 0 | none 41 |
| m4b | notes | 28 | 96.4% | 96.4% | 96.4% | 96.4% | 1 | 3.4% | 100.0% | 0 (0) | 0 | none 29 |
| m4b | graph | 242 | 99.6% | 100.0% | 76.9% | 61.2% | 1 | 0.4% | 100.0% | 230 (523) | 0 | none 243 |
| m4b | confirmation | 215 | 41.4% | 100.0% | 41.4% | 100.0% | 126 | 37.0% | 91.6% | 0 (0) | 0 | none 341 |
| m4b | topic-names | 28 | 92.9% | 96.4% | 92.9% | 96.4% | 2 | 6.7% | 100.0% | 0 (0) | 0 | none 30 |
| m4b | overview | 8 | 100.0% | 100.0% | 100.0% | 100.0% | 0 | 0.0% | 100.0% | 0 (0) | 0 | none 8 |
| m4b | all | 562 | 76.9% | 99.6% | 67.1% | 82.9% | 130 | 18.8% (misses bar) | 96.8% | 230 (523) | 0 | none 692 |
| m9b4 | summary | 41 | 100.0% | 100.0% | 100.0% | 100.0% | 0 | 0.0% | 100.0% | 0 (0) | 0 | none 41 |
| m9b4 | notes | 28 | 82.1% | 96.4% | 82.1% | 96.4% | 5 | 15.2% | 89.3% | 0 (0) | 0 | none 33 |
| m9b4 | graph | 242 | 99.2% | 100.0% | 38.8% | 61.2% | 2 | 0.8% | 100.0% | 746 (523) | 0 | none 244 |
| m9b4 | confirmation | 215 | 70.7% | 100.0% | 70.7% | 100.0% | 63 | 22.7% | 90.7% | 0 (0) | 0 | none 278 |
| m9b4 | topic-names | 28 | 85.7% | 96.4% | 85.7% | 96.4% | 4 | 12.5% | 100.0% | 0 (0) | 0 | none 32 |
| m9b4 | overview | 8 | 100.0% | 100.0% | 100.0% | 100.0% | 0 | 0.0% | 100.0% | 0 (0) | 0 | none 8 |
| m9b4 | all | 562 | 86.8% | 99.6% | 60.9% | 82.9% | 74 | 11.6% (misses bar) | 95.9% | 746 (523) | 0 | none 636 |
| q36-35b-a3b | summary | 41 | 100.0% | 100.0% | 100.0% | 100.0% | 0 | 0.0% | 100.0% | 0 (0) | 0 | none 41 |
| q36-35b-a3b | notes | 28 | 96.4% | 96.4% | 96.4% | 96.4% | 1 | 3.4% | 100.0% | 0 (0) | 0 | none 29 |
| q36-35b-a3b | graph | 242 | 31.0% | 100.0% | 7.4% | 61.2% | 167 | 40.8% | 88.4% | 1135 (523) | 0 | none 409 |
| q36-35b-a3b | confirmation | 215 | 87.9% | 100.0% | 87.9% | 100.0% | 26 | 10.8% | 98.6% | 0 (0) | 0 | none 241 |
| q36-35b-a3b | topic-names | 28 | 100.0% | 96.4% | 100.0% | 96.4% | 0 | 0.0% | 100.0% | 0 (0) | 0 | none 28 |
| q36-35b-a3b | overview | 8 | 100.0% | 100.0% | 100.0% | 100.0% | 0 | 0.0% | 100.0% | 0 (0) | 0 | none 8 |
| q36-35b-a3b | all | 562 | 65.5% | 99.6% | 55.3% | 82.9% | 194 | 25.7% (misses bar) | 94.5% | 1135 (523) | 0 | none 756 |
| gemma4-26b-a4b | summary | 41 | 100.0% | 100.0% | 100.0% | 100.0% | 0 | 0.0% | 100.0% | 0 (0) | 0 | none 41 |
| gemma4-26b-a4b | notes | 28 | 42.9% | 96.4% | 42.9% | 96.4% | 16 | 36.4% | 96.4% | 0 (0) | 0 | none 44 |
| gemma4-26b-a4b | graph | 242 | 52.1% | 100.0% | 37.6% | 61.2% | 116 | 32.4% | 93.0% | 197 (523) | 0 | none 358 |
| gemma4-26b-a4b | confirmation | 215 | 94.9% | 100.0% | 94.9% | 100.0% | 11 | 4.9% | 99.5% | 0 (0) | 0 | none 226 |
| gemma4-26b-a4b | topic-names | 28 | 60.7% | 96.4% | 60.7% | 96.4% | 11 | 28.2% | 78.6% | 0 (0) | 0 | none 39 |
| gemma4-26b-a4b | overview | 8 | 100.0% | 100.0% | 100.0% | 100.0% | 0 | 0.0% | 100.0% | 0 (0) | 0 | none 8 |
| gemma4-26b-a4b | all | 562 | 72.6% | 99.6% | 66.4% | 82.9% | 154 | 21.5% (misses bar) | 95.6% | 197 (523) | 0 | none 716 |
| custom | summary | 41 | 100.0% | 100.0% | 100.0% | 100.0% | 0 | 0.0% | 100.0% | 0 (0) | 0 | none 41 |
| custom | notes | 28 | 39.3% | 96.4% | 39.3% | 96.4% | 12 | 30.0% | 78.6% | 0 (0) | 5 | none 35 |
| custom | graph | 242 | 81.4% | 100.0% | 43.0% | 61.2% | 45 | 15.7% | 93.8% | 341 (523) | 1 | none 286 |
| custom | confirmation | 215 | 74.9% | 100.0% | 74.9% | 100.0% | 58 | 21.2% | 82.3% | 0 (0) | 0 | none 273 |
| custom | topic-names | 28 | 85.7% | 96.4% | 85.7% | 96.4% | 4 | 12.5% | 100.0% | 0 (0) | 0 | none 32 |
| custom | overview | 8 | 25.0% | 100.0% | 25.0% | 100.0% | 6 | 42.9% | 50.0% | 0 (0) | 0 | none 14 |
| custom | all | 562 | 77.6% | 99.6% | 61.0% | 82.9% | 125 | 18.2% (misses bar) | 88.8% | 341 (523) | 6 | none 681 |

## Speed and memory

| Arm | Contract | TTFT p50 / p95 (s) | Prefill p50 (tok/s) | Decode p50 / slowest 5% (tok/s) | Call p50 / p95 (s) | Output tokens vs Codex | Peak helper footprint / RSS (GiB) | Min memory level |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| m4b | summary | 9.1 / 15.6 | 230 | 25354.9 / 110.7 | 9.2 / 16.1 | 1.72 | 6.0 / 2.3 | 77 |
| m4b | notes | 19.9 / 34.8 | 142 | 39005.8 / 10856.0 | 21.3 / 42.1 | 1.80 | 6.0 / 2.3 | 75 |
| m4b | graph | 21.1 / 35.0 | 66 | 51010.3 / 22594.0 | 21.1 / 35.0 | 1.68 | 6.0 / 2.3 | 77 |
| m4b | confirmation | 0.5 / 0.8 | 781 | 1172.2 / 756.3 | 0.5 / 0.8 | 0.10 | 6.0 / 2.3 | 79 |
| m4b | topic-names | 4.0 / 7.8 | 421 | 20913.2 / 6757.5 | 4.0 / 7.9 | 0.93 | 6.0 / 2.3 | 78 |
| m4b | overview | 8.0 / 12.0 | 559 | 24218.2 / 19445.0 | 8.0 / 12.1 | 1.40 | 6.0 / 2.3 | 78 |
| m4b | all | 1.1 / 30.9 | 616 | 3541.4 / 775.0 | 1.8 / 31.3 | 1.54 | 6.0 / 2.3 | 75 |
| m9b4 | summary | 3.8 / 5.9 | 555 | 76.3 / 71.3 | 11.1 / 14.4 | 1.10 | 18.6 / 5.7 | 74 |
| m9b4 | notes | 4.6 / 11.8 | 538 | 75.0 / 68.1 | 24.6 / 47.9 | 1.61 | 18.6 / 5.7 | 68 |
| m9b4 | graph | 2.5 / 3.5 | 539 | 75.2 / 62.9 | 32.4 / 49.6 | 1.70 | 18.6 / 5.7 | 74 |
| m9b4 | confirmation | 0.8 / 1.5 | 447 | 72.0 / 61.9 | 1.1 / 2.0 | 0.16 | 18.6 / 5.7 | 74 |
| m9b4 | topic-names | 2.9 / 4.8 | 471 | 61.1 / 52.0 | 10.7 / 21.4 | 1.38 | 18.6 / 5.7 | 78 |
| m9b4 | overview | 8.9 / 12.9 | 481 | 67.4 / 45.1 | 15.9 / 24.8 | 1.33 | 18.6 / 5.7 | 76 |
| m9b4 | all | 1.7 / 5.3 | 497 | 74.4 / 56.7 | 8.8 / 46.5 | 1.54 | 18.6 / 5.7 | 68 |
| q36-35b-a3b | summary | 2.0 / 3.4 | 1038 | 98.7 / 85.0 | 7.7 / 11.1 | 1.00 | 32.9 / 3.4 | 45 |
| q36-35b-a3b | notes | 2.6 / 6.0 | 1070 | 96.2 / 73.8 | 15.8 / 38.7 | 1.39 | 32.9 / 3.4 | 34 |
| q36-35b-a3b | graph | 1.9 / 5.2 | 948 | 95.3 / 76.7 | 21.5 / 36.7 | 1.73 | 32.9 / 15.4 | 38 |
| q36-35b-a3b | confirmation | 0.4 / 0.7 | 958 | 84.8 / 66.9 | 0.6 / 1.5 | 0.18 | 32.9 / 14.4 | 42 |
| q36-35b-a3b | topic-names | 1.1 / 2.0 | 1159 | 103.0 / 99.5 | 5.8 / 8.8 | 1.09 | 24.8 / 14.4 | 49 |
| q36-35b-a3b | overview | 3.9 / 5.8 | 1068 | 99.7 / 97.6 | 10.1 / 13.0 | 1.78 | 27.6 / 14.4 | 48 |
| q36-35b-a3b | all | 1.3 / 4.9 | 973 | 91.1 / 71.3 | 12.5 / 34.2 | 1.53 | 32.9 / 15.4 | 34 |
| gemma4-26b-a4b | summary | 2.4 / 3.7 | 886 | 89.4 / 75.0 | 8.5 / 11.5 | 0.93 | 16.6 / 14.6 | 59 |
| gemma4-26b-a4b | notes | 2.6 / 6.6 | 871 | 87.9 / 65.1 | 17.1 / 33.3 | 1.33 | 16.6 / 14.6 | 59 |
| gemma4-26b-a4b | graph | 1.6 / 3.3 | 903 | 92.1 / 76.9 | 13.6 / 20.8 | 0.86 | 16.6 / 14.6 | 59 |
| gemma4-26b-a4b | confirmation | 0.4 / 0.8 | 848 | 85.8 / 77.7 | 0.7 / 1.3 | 0.18 | 16.6 / 14.6 | 60 |
| gemma4-26b-a4b | topic-names | 1.7 / 4.2 | 802 | 93.0 / 86.1 | 6.8 / 12.3 | 1.12 | 16.6 / 14.6 | 60 |
| gemma4-26b-a4b | overview | 5.1 / 7.5 | 833 | 82.6 / 80.1 | 11.7 / 14.9 | 1.55 | 16.6 / 14.6 | 60 |
| gemma4-26b-a4b | all | 1.4 / 3.5 | 877 | 90.2 / 76.9 | 9.7 / 20.5 | 0.85 | 16.6 / 14.6 | 59 |
| custom | summary | 4.8 / 8.9 | 398 | 51.5 / 42.8 | 13.4 / 20.8 | 0.84 | 9.1 / 6.6 | 76 |
| custom | notes | 4.8 / 38.8 | 431 | 49.7 / 45.1 | 31.4 / 347.3 | 6.42 | 9.1 / 6.6 | 75 |
| custom | graph | 3.2 / 6.4 | 431 | 51.4 / 45.5 | 26.5 / 47.3 | 1.04 | 9.1 / 6.6 | 75 |
| custom | confirmation | 1.0 / 1.8 | 362 | 50.9 / 44.6 | 1.5 / 2.7 | 0.20 | 9.1 / 6.6 | 76 |
| custom | topic-names | 3.7 / 5.2 | 410 | 51.6 / 51.1 | 11.7 / 19.5 | 1.08 | 9.1 / 6.6 | 78 |
| custom | overview | 9.6 / 14.1 | 439 | 50.6 / 49.8 | 19.6 / 25.3 | 1.34 | 9.1 / 6.6 | 78 |
| custom | all | 2.5 / 7.7 | 404 | 51.3 / 45.4 | 12.6 / 45.4 | 1.21 | 9.1 / 6.6 | 75 |

## Yield against the recorded Codex answer

Means over the items with a usable local answer and a readable recorded one; each metric is a share of what the Codex answer holds unless it says ratio.

| Arm | Contract | Metrics |
| --- | --- | --- |
| m4b | summary | lengthRatio 17.97; conceptRatio 1.10 |
| m4b | notes | countRatio 1.26; titleOverlap 27.8%; evidenceCoverage 88.9% |
| m4b | graph | entityRecall 35.0%; entityPrecision 26.5%; relationRecall 22.7%; relationPrecision 14.5%; predicateAgreement 73.4%; entityCountRatio 0.96 |
| m4b | confirmation | agreement 67.6%; overMergeRate 20.8%; underMergeRate 8.0%; decidedRatio 1.00 |
| m4b | topic-names | namedShare 100.0%; exactTitle 16.5%; titleOverlap 38.3% |
| m4b | overview | paragraphRatio 0.90; evidenceOverlap 79.2% |
| m9b4 | summary | lengthRatio 10.02; conceptRatio 1.07 |
| m9b4 | notes | countRatio 1.29; titleOverlap 32.4%; evidenceCoverage 90.9% |
| m9b4 | graph | entityRecall 42.0%; entityPrecision 38.6%; relationRecall 22.8%; relationPrecision 21.6%; predicateAgreement 69.6%; entityCountRatio 0.88 |
| m9b4 | confirmation | agreement 66.7%; overMergeRate 18.6%; underMergeRate 8.3%; decidedRatio 1.00 |
| m9b4 | topic-names | namedShare 100.0%; exactTitle 6.2%; titleOverlap 38.0% |
| m9b4 | overview | paragraphRatio 1.32; evidenceOverlap 78.6% |
| q36-35b-a3b | summary | lengthRatio 5.08; conceptRatio 1.08 |
| q36-35b-a3b | notes | countRatio 1.00; titleOverlap 35.8%; evidenceCoverage 90.0% |
| q36-35b-a3b | graph | entityRecall 40.2%; entityPrecision 45.2%; relationRecall 23.2%; relationPrecision 39.6%; predicateAgreement 70.8%; entityCountRatio 0.77 |
| q36-35b-a3b | confirmation | agreement 59.5%; overMergeRate 19.2%; underMergeRate 17.4%; decidedRatio 1.00 |
| q36-35b-a3b | topic-names | namedShare 100.0%; exactTitle 9.2%; titleOverlap 40.0% |
| q36-35b-a3b | overview | paragraphRatio 1.31; evidenceOverlap 87.1% |
| gemma4-26b-a4b | summary | lengthRatio 0.72; conceptRatio 0.93 |
| gemma4-26b-a4b | notes | countRatio 1.28; titleOverlap 32.8%; evidenceCoverage 90.8% |
| gemma4-26b-a4b | graph | entityRecall 41.9%; entityPrecision 52.4%; relationRecall 24.5%; relationPrecision 30.4%; predicateAgreement 63.4%; entityCountRatio 0.66 |
| gemma4-26b-a4b | confirmation | agreement 72.0%; overMergeRate 16.7%; underMergeRate 9.1%; decidedRatio 1.00 |
| gemma4-26b-a4b | topic-names | namedShare 78.6%; exactTitle 4.5%; titleOverlap 28.2% |
| gemma4-26b-a4b | overview | paragraphRatio 1.08; evidenceOverlap 95.4% |
| custom | summary | lengthRatio 6.50; conceptRatio 0.88 |
| custom | notes | countRatio 1.06; titleOverlap 35.7%; evidenceCoverage 88.9% |
| custom | graph | entityRecall 44.9%; entityPrecision 42.4%; relationRecall 21.1%; relationPrecision 28.7%; predicateAgreement 72.2%; entityCountRatio 0.87 |
| custom | confirmation | agreement 77.0%; overMergeRate 20.1%; underMergeRate 0.0%; decidedRatio 1.00 |
| custom | topic-names | namedShare 100.0%; exactTitle 16.8%; titleOverlap 38.2% |
| custom | overview | paragraphRatio 1.06; evidenceOverlap 96.4% |

## Against the spike's proposed bars (record only)

| Arm | Decode p50 | Repairs | Final valid | Swap growth | Recall of Codex entities and relations |
| --- | --- | --- | --- | --- | --- |
| m4b | 3541.4 tok/s (meets bar) (background 8, answer 15) | 18.8% (misses bar) | 96.8% (misses bar) | 0 MiB (meets bar) | 22.7% (misses bar) |
| m9b4 | 74.4 tok/s (meets bar) (background 8, answer 15) | 11.6% (misses bar) | 95.9% (misses bar) | 0 MiB (meets bar) | 22.8% (misses bar) |
| q36-35b-a3b | 91.1 tok/s (meets bar) (background 8, answer 15) | 25.7% (misses bar) | 94.5% (misses bar) | 0 MiB (meets bar) | 23.2% (misses bar) |
| gemma4-26b-a4b | 90.2 tok/s (meets bar) (background 8, answer 15) | 21.5% (misses bar) | 95.6% (misses bar) | 0 MiB (meets bar) | 24.5% (misses bar) |
| custom | 51.3 tok/s (meets bar) (background 8, answer 15) | 18.2% (misses bar) | 88.8% (misses bar) | 0 MiB (meets bar) | 21.1% (misses bar) |

<!-- writer-report:end -->

## Pending

- **Arm 6, Gemma 4 31B QAT: not run.** The owner approved the download on 2026-10-25: the MLX 4-bit QAT build
  `bambocher/gemma-4-31B-it-qat-mlx` @ `dd353c98`, mixed precision. It is scheduled after the 24 h soak and the E1 run,
  in free slots (`f4-decisions.md`, slot plan; `RUN.md`). Its column is left out of the tables until it has run. When
  it has, add its run folder as a sixth argument and regenerate; the prose above needs a line for it.
- **T70, the runtime-upgrade spike** (mlx-swift-lm 3.32.3 and node-llama-cpp 3.22.2, with and without guided
  decoding), is not run. It is record only and is dropped if no night is free (`f4-decisions.md`, slot plan). Its
  results will get their own record.
- **T73** deletes the test models and the benchmark transients after the benchmark. Until then the run folders under
  `.cache/f4/bench/` are the source of the tables.

## What this record does not decide

Decision 26 (2026-10-18): every phase keeps today's models (the writer `gpt-5.6-luna` on the Codex route,
Qwen3-Embedding-0.6B and Qwen3-Reranker-0.6B), quantizations and runtimes. The benchmark and any runtime spike are
measured and recorded only. The owner decides on them after F7, with the findings of the owner trial (decision 34).

This record therefore does not:

- recommend, rank or choose any arm, or call any model a candidate for the Local preset or for a hardware tier;
- change a catalog entry, preset, default, tier suggestion or the installed models; the tier table in the app keeps
  suggesting today's models only;
- say that a local writer could replace the Codex writer: all five arms are below the recorded Codex answers on
  first-answer validity, and the yield measures agreement with one Codex answer, not quality;
- say how an arm would run on an idle machine, on another Mac or with the grammar mask of F4 D24 on (caveats 1, 3 and
  9);
- settle sampling parameters for any arm (caveat 7), or size run-to-run variation (no seed, one run each).

For a later owner decision the record gives these inputs: the five arms' validity, repair and yield on the same 562
items; the repair share that every arm shows without the mask; the memory each needs on a 64 GiB Mac; and a floor for
each arm's speed. The decision itself, and any run that it needs on an idle machine, are open.
