> **Owner correction (2026-10-18):** gpt-6-luna is NOT available on the Codex (ChatGPT plan) route; it is a paid
> API model only. Every line below that offers it "via Codex" or "on the plan" is superseded: the Codex route stays
> on gpt-5.6-luna, and gpt-6-luna is the paid-API option (about $0.40 per typical month).

# Hardware tiers and recommended AI setups

Date: 2026-10-18. Status: **final recommendation for the owner's review** (decision 25, `docs/plan.md:104` [R6]). It
revises `recommendations-draft.md` with every correction in `fact-check.md` [F]; section 0.1 lists them. Nothing here
is implemented; no tracked file was edited and no model weights were downloaded. Model sizes, revisions and licence
tags were re-read from Hugging Face API metadata on 2026-10-18 [S23]; OpenAI, Gemini, Anthropic and Codex prices were
re-fetched on the same day [S1][S2][S3][S7][S9], and the gpt-6-luna model page was read once more for this revision [S2].

Inputs: the five research reports in this folder: `mac-writers.md` [H1], `embed-rerank.md` [H2], `windows.md` [H3],
`detection.md` [H4], `cloud.md` [H5]. Where they disagree, section 11 states which reading this document keeps and why.

Evidence tags: **[M]** measured on the owner's Mac; **[P]** primary page (vendor, model card, source code);
**[V]** vendor-reported benchmark; **[C]** community measurement (oMLX database, llama.cpp scoreboards; unvetted);
**[S]** secondary article; **[D]** derived from cited anchors with a stated formula; **[I]** my inference.
Keys: `[R#]` repository files, `[H#]` the five reports, `[F]` / `[F n]` the fact-check (its section n), `[S#]` web
sources (section 12). A dagger (†) marks a community figure that rests on H1's 2026-10-17 fetch and could not be
re-read on 2026-10-18 [F 6].

Planning workload, used in every speed figure [I, from H1 and H5]: a writer call is 2,500 prompt + 1,000 output tokens;
a 30-chunk reference chapter is 44 local calls (3,500-character graph batches, D36 [R10]); a typical month is 250 new
notes, 60 Ask questions and 60 relation explanations. On local presets the writer sees about 2.6K input + 1.4K output
tokens per note (the golden-small run minus the matching calls, which go to the local ranker) [R12][I].

---

## 0. Decisions in brief

1. **One rule for every platform: a local writer is the default only when its quality class is good enough.** Today
   that means a 26B-35B-class model (Qwen3.6-35B-A3B, Gemma 4 26B-A4B, Qwen3.8-27B). The 9B-12B class becomes a default
   only if it passes the owner's bake-off (section 7); 4B-class models are never the default writer [H1][H3][I].
2. **Cloud writer = gpt-6-luna at reasoning `low`**: $0.10 in / $0.01 cached / $0.50 out per 1M tokens, cache writes
   $0.125; prompts over 272K input tokens pay double input and cache rates and 1.5x output. Strict Structured Outputs,
   1.05M context, server default reasoning `medium` [S1][S2]. A typical month costs about **$0.39-0.40** on the API
   ($0.19 on Batch/Flex), and $0 extra on a ChatGPT Plus/Pro plan through Codex sign-in (about 10 credits at
   2.5 / 12.5 credits per 1M) [S3][H5][F 1].
3. **Mac answer:** 8 GB and 16 GB Macs get **Hybrid** (local embedding + reranker, cloud writer). A 16 GB Mac has **no
   useful all-local default**. A 24 GB Mac **can** run a usable all-local setup (Qwen3.5-9B), but it is offered as a
   one-click "private mode", not the default, until the 9B passes the bake-off. Local is the default from 32-36 GB
   (MoE writer, verified on the device), and clearly from 48 GB up [H1][H4][I].
4. **Owner's Mac (M4 Max 40-core GPU, 64 GB, GPU working set 51.84 GiB measured)**: Local with
   Qwen3.6-35B-A3B 8-bit MLX (37.72 GB), about 94 tok/s decode and about 9 minutes per chapter expected, and the
   0.6B embedding/reranker pair unchanged. The speed comes from a community row of an 8-bit fine-tune with the same
   architecture; no official 8-bit row is published [F 6]. Hybrid with gpt-6-luna is the alternative and the quality
   reference (section 5).
5. **Windows:** llama.cpp through node-llama-cpp (GGUF) for all three roles, Vulkan as the default GPU backend, CUDA only
   when the toolkit DLLs are present, NPUs display-only. Local is the default only on 24 GB+ VRAM or 64-128 GB
   unified x86 (Strix Halo). Everything below is Hybrid, with Local offered where it fits [H3].
6. **Embedding and reranker stay Qwen3-Embedding-0.6B Q8_0 GGUF + Qwen3-Reranker-0.6B on every tier.** Detection never
   changes the embedding model, because a new model means a new vector space (full re-embed, tree rebuild,
   recalibration). Qwen3-Embedding-4B is an explicit opt-in upgrade on 32 GB+ after a bake-off [H2].
7. **Detection reads the real limits and never assumes them:** the Metal working set, free VRAM from the backend that
   will really load, and `process.availableMemory()`. The working-set share varies with RAM and OS: 81.0% measured
   here (64 GB, macOS 27), 66.7% at 16 GB, about 74% at 24 GB (macOS 26), about 75% on a 96 GB M3 Ultra under mlx
   [M][S29][S28][S36]. Detection never changes `iogpu.wired_limit_mb`, never blocks, keeps a swap and pressure guard
   even at default settings, and keeps the profile on the device only [H4][F 0].
8. **Before any of this ships:** upgrade evaluation of mlx-swift-lm 3.31.4 -> 3.32.3 (adds `MLXGuidedGeneration`)
   and node-llama-cpp 3.19.0 -> 3.22.2, `gpt-6` entries in `reasoning.ts`, and a GGUF writer in the catalog for
   Windows [S31][S37][H5][R1][R2].

### 0.1 What changed after the fact-check

The tier verdicts, the owner's recommendation, the cloud writer and the embedding/reranker policy are unchanged. These
claims were corrected, re-labelled or marked; "Where" names the sections that now carry the fix [F].

| # | Draft claim | Final text | Where | Source |
| --- | --- | --- | --- | --- |
| 1 | M35-8 has the best SOB structured-output result among open models (0.801 / 0.969) | Qwen3.6-35B-A3B was not tested. 0.801 / 0.969 belong to the predecessor Qwen3.5-35B, second overall behind GLM-4.7 (0.804) | 5, 10 | [S25] |
| 2 | KLD 0.113 (M27-4) and about 0.03 (M27-6) | Both measured on the predecessor Qwen3.6-27B; no Qwen3.8-27B KLD is published | 4 | [S27] |
| 3 | M35-4 is "4-bit DWQ" | DWQ with mixed precision: 240 expert modules at 4-bit, 272 modules at 8-bit; the README is a 6-line stub | 2.1, 4, 8, 11 | [S23] |
| 4 | G9B revision `38852198` | `3885219b` | 4 | [S23] |
| 5 | Strix Halo G35 about 60 tok/s | About 50-55 tok/s, scaled by file size; the cited page has no UD-Q4_K_M row | 3.1 | [S45] |
| 6 | gpt-6.1-sol for `answer` adds $1.44/month | Adds about $1.37: $1.44 is the whole Sol bill for 60 questions, and gpt-6-luna's is $0.07 | 5, 9.1 | [S1] |
| 7 | node-llama-cpp: Vulkan fixes in 3.20/3.21, Windows-arm64 build fix in 3.22.0 | 3.20.0 has no Vulkan item; 3.21.0 aligns Vulkan device reading; 3.22.0 has arm64 Windows build optimizations (not a fix) | 3.1, 3.3 | [S37] |
| 8 | Issue #554 is "Vulkan device lost" | #554 is a SIGSEGV on Linux x64 in the CPU fallback after an incompatible Vulkan prebuilt | 3.3 | [S39] |
| 9 | Linux: Vulkan + CPU prebuilts only | node-llama-cpp also ships `linux-x64-cuda(-ext)`; Vulkan + CPU is a packaging choice; no ROCm prebuilt | 3.3 | [S37] |
| 10 | 81% "not the 75% folklore" | 81% here; 75% is a real value on a 96 GB M3 Ultra under mlx; the share varies | 0, 2.1 | [M][S36] |
| 11 | Never change `iogpu.wired_limit_mb` | Kept, plus: a panic was reproduced at default settings on macOS 26.4, so the swap and pressure guard is needed anyway | 6.4, 10 | [S36][S28] |
| 12 | 16 GB M1/M2 9B: 43-92 min per chapter, 5-11 h per month | About 53-92 min and 6.5-11 h; 43 min is the M4 16 GB row | 2.2 | [S24][D] |
| 13 | gpt-6-luna at `medium`: 5.28 s TTFT | Unverifiable: Artificial Analysis lists no `medium` figure today | 9.3 | [S11] |
| 14 | gpt-6-luna prices | Cache writes ($0.125) and the over-272K surcharge added; monthly totals unchanged | 0, 9.1 | [S2] |
| 15 | Owner's 94 tok/s comes from an "8-bit, same-architecture row" | The row is an abliterated distillation fine-tune; no official 8-bit row exists | 0, 2.1, 5 | [S24] |
| 16 | M5 Max 128 GB: 126 tok/s, prefill 3,717 | A 1k-context row; at 4k another conversion shows 149 tok/s and 2,274 prefill | 2.1 | [S24] |
| 17 | MG26 111.7 tok/s | Measured on a QAT conversion; the plain 4-bit shows 79.5 on an M4 Max 32c 36 GB; QAT arm MG26q added | 4, 5, 7.3, 8 | [S24][S23] |
| 18 | M1 and M6 community rows | Not re-readable today; marked † | 2.1, 2.2 | [F 6] |
| 19 | Prosa: "a 4B" and "a 30B-class Qwen" | Qwen3-4B and Qwen3-30B, the 2025 generation; the proxy may understate current models | 2.2, 5 | [S26] |
| 20 | R4B: mxfp8 support unverified | Present in the pinned MLX Swift 0.31.6 and mlx-swift-lm 3.31.4 sources; untested at run time | 4 | [S56] |
| 21 | Gemma QAT files mentioned only in passing | Google's QAT Q4_0 GGUFs (12B 6.98 GB, 26B-A4B 14.44 GB) added as A/B options | 3.2, 4, 8 | [S23] |
| 22 | Harrier GGUF | Its `base_model` is a third-party mirror; compare tensors with Microsoft's first | 8 | [S23] |
| 23 | `batchSize: 1024` for llama.cpp #27237 | The issue was closed as stale, not fixed; the workaround stays | 3.3 | [S41] |
| 24 | Sign in with ChatGPT: commercial or hosted apps must apply | An open-source / locally hosted app flow is now documented | 9.3, 10 | [S5][S57] |
| 25 | 24 GB+ VRAM share 5.5% | 5.5% at 24 GB plus 1.4% at 32 GB | 3.2 | [S43] |
| 26 | gemini-embedding-001 at $0.15 | Unverifiable: not on Google's pricing page | 9.1 | [S7] |
| 27 | Priority-3 total 48.9 GB | 49.0 GB (48.95); totals recomputed with the added QAT arms | 8 | [S23] |

---

## 1. The policy behind every row

Three gates, evaluated in order. The machine must pass all three for **Local** to be the recommended preset [H4][I]:

| Gate | Question | Rule (constants are *(cal.)* until the owner's benchmark) | Source |
| --- | --- | --- | --- |
| Capacity | Does the writer fit next to the resident embedder + reranker and the host? | `footprint x margin <= writerBudget`; margin 1.25 for derived footprints, 1.10 once a footprint is measured (or computed exactly by `GgufInsights`) | [H4] 5.1-5.2 |
| Speed | Is it fast enough? | low-estimate decode >= 8 tok/s for background work, >= 15 tok/s for interactive Ask; CPU-only and shared-memory backends also need measured prefill >= 100 tok/s | [H4] 6.1, 7; [H3] 9 |
| Quality | Is the output good enough for the user's library? | the writer's quality class: **S** (<= 5B) never default; **M** (9-12B) default only after a passed bake-off; **L** (26-35B) default, verified on the device | [H1] 0.3, 6; [I] |

Consequences:

- **"Cloud" whenever local quality would hurt the user.** If the quality gate fails, the writer goes to the cloud
  (the **Hybrid** preset: local embedding and reranker, remote writer). The **Cloud** preset (remote writer and
  generative decide) is recommended only where the local reranker is too slow (> 150 ms per pair, the repo's GO rule
  [R8]) or nothing local can run.
- **Embedding stays local and sticky in all presets.** The Cloud preset's `provider-embedding` target already falls
  back to the local model, and the Codex route has no embeddings endpoint [R1][H5]. This document proposes that the Cloud
  preset keep the local embedding by default and treat a provider embedding as an explicit, disclosed space change [H2].
- **One local writer serves all three write classes** (C6, `ai-presets.ts:18` [R1]) and only one local job runs at a
  time. So a tier gets one writer. Two resident writers only appear in the 128 GB note.
- **Thinking off and guided JSON on** for every local writer: Qwen3.5/3.6/3.8 need `enable_thinking: false`; Gemma 4
  still emits an empty thought block when thinking is off [H1 7.6][S21][S22]. MLX JSON-schema masking needs
  mlx-swift-lm 3.32.x [S31]; GGUF already uses a grammar (`createGrammarForJsonSchema`, D35) [R10][H3].

---

## 2. macOS on Apple Silicon

### 2.1 Tier table

Model codes are defined in section 4 (repository, file, quantization, size, licence, runtime, revision). "E+R" is the
default pair **E06** (Qwen3-Embedding-0.6B Q8_0, GGUF) + **R06m** (Qwen3-Reranker-0.6B bf16, MLX), about 2.0 GiB
resident [R15][H4]. "Resident" = writer weights + KV at 16k + about 1 GiB working set + E+R, in GiB [H1 2.3][I].
Speeds are 4-bit community measurements unless stated [C via H1 5]; chapter and month times use the planning
workload above [I]. GPU cap = default `recommendedMaxWorkingSetSize` [H1 2.2].

| Tier (typical chips; GPU cap) | Recommended preset (-> alternatives) | Local writer | Embed / rerank | Resident (GiB) | Speed (decode; chapter; typical month) | Cloud instead |
| --- | --- | --- | --- | --- | --- | --- |
| **8 GB** (M1-M3 base; cap about 5.3 [I]) | **Hybrid** (writer: Cloud) -> Cloud | none by default; offline opt-in **M4B** for short outputs only (topic names, tags) | E+R | 2.0; +4.3 with M4B (6.3 of 8 GB: too tight) | M4B: 18.5-28 tok/s (M1† to M2), prefill 145-184; about 50 min/chapter; about 6 h/month | gpt-6-luna low: **$0.39/month** typical; $0 extra on ChatGPT Plus/Pro |
| **16 GB** (M1-M6 base; cap 10.67, 66.7% [P S29]) | **Hybrid** -> Local (private/offline, lower quality), Cloud | opt-in **M4B** (safe) or **M9B4** (tight, verify swap) | E+R | M4B 6.3; M9B4 9.0 (leaves about 7 GiB for macOS, Electron, PostgreSQL) | M9B4: 8-12 tok/s (M1†) to 28.5 (M6†), prefill 68-1,101; 27-92 min/chapter (M1/M2 53-92, M4 43); 3.5-11 h/month | same |
| **24 GB** (M2-M5 base, M4 Pro; cap 17.76, about 74% on macOS 26 [S28]) | **Hybrid** -> Local one click ("private mode"), Cloud. Flip to Local default if class M passes the bake-off | **M9B6** on Pro/M5 chips, **M9B4** on base chips; A/B **MG12** | E+R | M9B6 11.1; M9B4 9.0 | M9B4: 47-49 tok/s M4 Pro, 23-26 M5; 21-32 min/chapter; 2.5-4 h/month. M9B6 about 30-40 tok/s on M4 Pro [I] | same |
| **32 GB / 36 GB** (M1/M2 Pro-Max 32, M4/M5/M6 base 32 at 120-170 GB/s; M3 Pro, M3-M5 Max 36; cap about 21-24 / 24-27 [I]) | **Local, suggested until verified** (MoE writer) -> Hybrid if the capacity check or the benchmark fails | **MG26** (Gemma 4 26B-A4B 4-bit); **M35-4** when the read budget allows it (most 36 GB Max machines [I]); dense **M27-4** only on >= 300 GB/s chips | E+R | MG26 17.8; M35-4 22.5 | MG26 46-50 tok/s (M6 32 GB†); M35-4 66 (M6 32 GB†), 118 (M4 Max 32c 36 GB); 7-17 min/chapter; 1-2 h/month. Dense 27B on M6: 9.8 tok/s†, too slow for bulk | same |
| **48 GB** (M4/M5 Pro 48, M3 Max 48; cap about 36 [I]) | **Local** (verify) -> Hybrid, Cloud | **M35-4** (DWQ, mixed 4/8-bit); **M35-6** once its footprint is measured; quality A/B **M27-6** | E+R; E4B opt-in after bake-off | M35-4 22.5; M35-6 30.3 | M35-4 on M4 Pro 48: 90 tok/s, prefill about 1,045; about 10 min/chapter; about 1.2 h/month | same |
| **64 GB** (M1/M2 Max, M3-M5 Max 64, M4/M5 Pro 64; cap 51.84, 81% [M]) | **Local** (verify) -> Hybrid, Cloud | **M35-8** (or M35-6); quality alt **M27-8**; A/B MG26, MG31-6 | E+R; E4B / R4B optional after bake-off | M35-8 38.3 | M4 Max 40c: about 94 tok/s, prefill about 2,100 (community row of an abliterated 8-bit fine-tune of the same architecture; no official 8-bit row) [C]; about 9 min/chapter; about 1.1 h/month. M4 Pro 64: dense 27B 14-15 tok/s | same |
| **96 GB** (M2/M3 Max 96, M3 Ultra 96; cap about 72-78 [I]; one mlx report wires about 72 GB, 75% [S36]) | **Local** | as 64 GB (**M35-8**), headroom for 128k context and batching; Qwen3.5-122B-A10B 4-bit (69.59 GB) optional, no measured gain | E+R; E4B opt-in | about 38 | M3 Ultra (4-bit): 111 tok/s, prefill 2,518; about 7 min/chapter | same |
| **128 GB+** (M4/M5 Max 128, Ultras up to 512 GB; cap about 96-104 at 128 [I]) | **Local** | as 64 GB; room for two resident writers (M35-8 + M27-8, about 67 GB) if C6 is ever relaxed; gpt-oss-120b only for English speed | E+R; E4B / Qwen3-Embedding-8B as experiments | about 38 | M5 Max 128 at 4k context: 149 tok/s, prefill 2,274 (a 4-bit `MLX-Serve` conversion); about 6 min/chapter. The often-quoted 126 tok/s and 3,717 prefill is a 1k-context row [C][F 6] | same |

Row sources: caps [H1 2.2][M][P S29][S28]; footprints from `config.json` KV and HF sizes [H1 2.3, 3][S23]; speeds
[C S24 via H1 5, re-read at 4k context in F 6]; quality verdicts [H1 0, 4, 6]; the 32 GB MoE choice and the 48 GB
quant are this document's reconciliation (section 11).

### 2.2 The explicit answers for 16 GB and 24 GB

**16 GB: no, not as a default.** Three independent reasons:
- *Memory.* Qwen3.5-9B 4-bit needs about 7.0 GiB of the 10.67 GiB GPU cap [H1 6], and 9.0 GiB with the resident
  embedder and reranker. That leaves about 7 GiB for macOS (4.4-4.7 GiB wired measured on the owner's Mac [H4 2]),
  Electron and PostgreSQL. The budget model gives a 16 GB Mac 5.0 GiB for the writer, so only the 4B fits with margin
  [H4 6.3].
- *Quality.* Before schema output and salvage, the repo's 9B run failed 8 knowledge-graph jobs and 1 note job on
  invalid JSON, and the 4B run failed 7 (`docs/kpi-f2.md:196-198` [R7]). Guided decoding fixes structure, not content
  [S25][H1 2.5]. On the Prosa pt-BR rubric Qwen3-4B (the 2025 generation; no Qwen3.5 figure is published) scores
  64.6 against 84.8 for GPT-5 Mini, so the proxy may understate the current 4B [S26][F 7].
- *Speed.* Base M1/M2 prefill of 68-131 tok/s puts a 9B at about 53-92 minutes per chapter and about 6.5-11 hours of
  local writer time per typical month. An M4 16 GB is faster: 43 minutes per chapter at prefill 242 [C via H1 5; M1
  rows †][D: chapter = 44 x (2500/PP + 1000/TG) s; month = 250 notes x (2.6K/PP + 1.4K/TG) s][F 0 #12].

What a 16 GB owner can still do: keep Hybrid (cloud writer about $0.39/month, or $0 extra on a ChatGPT plan), and
turn on Local as an offline/private mode with the 4B (safe) or the 9B (tight; the on-device check must show no swap
growth).

**24 GB: yes it can, but Hybrid stays the default for now.**
- *It fits.* Qwen3.5-9B 6-bit needs about 9.1 GiB (11.1 GiB with E+R) against a 17.76 GiB cap and a writer budget of
  about 12.7-13 GiB [H1 6][H4 6.3].
- *It is usable.* About 21 minutes per chapter on an M4 Pro, 31 on an M5, 2.5-4 hours of local writer time per month
  [C][I].
- *Quality is the open question.* It is the same 9B class as the 16 GB row, so Local is offered as a one-click
  "private mode" and becomes the default automatically if the class M bake-off passes (section 7.4).
- *Do not go bigger.* Qwen3.8-27B 4-bit does **not** fit safely: it needs about 17.0 GiB against the 17.76 GiB cap,
  and a 24 GB M4 Pro report (macOS 26) shows three kernel panics with a 27B Q4_K_M GGUF (19.6 GB peak), worse after
  raising the wired limit, and about 2 tok/s with constant swapping for Gemma 4 26B-A4B on Ollama (quantization not
  stated) [S28].

### 2.3 Notes that change a row's behaviour

- The tier is computed from the **read** cap and budget, not from the RAM label. A 32 GB machine whose cap reads
  below about 23 GiB gets MG26 or Hybrid, never M35-4 [H4 5.1][I].
- Base M1/M2 prefill (70-130 tok/s) is the real bottleneck for 2.5k-token prompts. M5-class prefill is 3.3-4.1x faster
  than M4 for the same memory (Apple, macOS 26.2+) [S33][H1 2.4].
- Fanless MacBook Airs, battery and Low Power Mode change **when** local writer jobs run (default: wait for AC), not
  the tier [H4 3.2, 6.2].
- The current code picks the writer from total RAM (`9B if >= 24 GiB`, `ai-presets.ts:51,87-95` [R1]) and gates
  compatibility on `totalmem()` (`local-adapters.ts:343`, `local-model-service.ts:734-737, 853-856` [R3][R4]). Both
  move to the budget model in section 6.

---

## 3. Windows (and later Linux)

All rows use GGUF through node-llama-cpp: Vulkan by default, CUDA only if `cudart`/`cublas`/`cublasLt` DLLs are found,
CPU otherwise [R17][S38][H3 3.3]. Speeds are **derived** from llama.cpp scoreboard anchors with
`tg = 0.85 x effective bandwidth / file size` and are not measured [D H3 7]. "Min/source" uses H3's per-source budget
(about 9k input + 5k output tokens including matching) [H3 2]. The Windows embed/rerank pair is **E06** + **R06g**
(the same 0.6B models as GGUF). On GPUs with <= 12 GB, embedder and reranker run on the CPU (`gpuLayers: 0`) so the
writer keeps the VRAM [H3 8][I].

**Today Local is refused on Windows** (`local_requires_apple_silicon`, MLX-only writers in the catalog [R1][R2]).
Every "Local" below needs a GGUF writer catalog entry and the preset change first.

### 3.1 No discrete GPU (CPU-only or integrated GPU), by RAM

| Tier | Recommended preset (-> alternatives) | Local writer | Embed / rerank | Memory | Speed [D] | Cloud instead |
| --- | --- | --- | --- | --- | --- | --- |
| **CPU-only, <= 8 GB RAM** | **Cloud** with the local embedding kept -> Hybrid only if the reranker benchmark passes | none (Qwen3.5-2B **G2B** opt-in is too weak) | E06 on CPU (12-18 notes/s); reranker 0.3-0.4 s/pair on CPU is above the 150 ms GO rule, so decide runs on gpt-6-luna | about 1 GB | - | writer + generative decide on gpt-6-luna: about $0.39 + $0.06 = **$0.45/month** |
| **CPU-only x86, 16 GB** | **Hybrid** (ranker on CPU only if <= 150 ms/pair, else generative decide) | opt-in overnight **G4B** Q4_0 | E06 CPU; R06g CPU if it passes | 4B: about 4 GB | 4B: 8-12 tok/s, 7-12 min/source | $0.39-0.45/month |
| **Modern iGPU, 16-32 GB** (Ryzen AI 300, Core Ultra 200V/H, Panther Lake) | **Hybrid** -> Local offered | **G4B** Q4_K_M (2.74 GB) via Vulkan; **G9B** on 32 GB "if patient" | E06/R06g on iGPU: 56-63 notes/s, 80-90 ms/pair | read `getVramState()`: AMD VGM defaults to 512 MB, Intel to 57% of RAM | 4B 20-27 tok/s (3.5 min/source); 9B 10-14 (about 7) | $0.39/month |
| **Windows on Arm** (Snapdragon X, 16-32 GB) | **Hybrid** -> Local on 32 GB | **G4B** / **G9B** at Q4_0, CPU only (no Vulkan prebuilt for win-arm64); prefer node-llama-cpp >= 3.22.0 (arm64 Windows build optimizations) [S37] | E06/R06g CPU: about 21 notes/s, about 240 ms/pair (decide on cloud) | RAM | 4B 29 tok/s (3.7 min/source); 9B 14 (7.5) | $0.39-0.45/month |
| **Unified x86, 64-128 GB** (Ryzen AI Max+ / Strix Halo) | **Local** (verify) -> Hybrid | **G35** (Qwen3.6-35B-A3B UD-Q4_K_M, 22.13 GB) | E06/R06g on iGPU | up to about 75% of RAM via VGM | about 50-55 tok/s [D: scaled by file size from S45's 63 tok/s for UD-IQ4_XS (about 17 GB, Vulkan) and 54.5 tok/s for Q4_K_M (23.9 GB, Ollama)], about 1.6-1.8 min/source | $0.39/month |

### 3.2 Discrete GPU, by VRAM

| VRAM (examples; Steam share [S43]) | Recommended preset (-> alternatives) | Local writer | Embed / rerank | VRAM use (file + KV 8k + 0.5 GB) | Speed [D] | Cloud instead |
| --- | --- | --- | --- | --- | --- | --- |
| **4 GB** (GTX 1650, MX, laptop 3050 4 GB; 5.1%) | **Hybrid** | none (2B/4B at Q3-IQ4 only, quality risk) | GPU or CPU | - | - | $0.39/month |
| **6 GB** (RTX 3050 6 GB, 2060, laptop 4050; 5.1%) | **Hybrid** -> Local (4B, private mode) | **G4B** Q5_K_M 3.14 GB / Q6_K 3.53 GB | CPU | about 4.0 GiB | 34-44 tok/s, 2.0-2.6 min/source | $0.39/month |
| **8 GB** (RTX 4060/5060/3070, RX 7600/9060 XT; 26.7%) | **Hybrid** -> Local one click; becomes the default if class M passes | **G9B** Q4_K_M 5.68 GB at <= 8k context: **edge fit**, needs a load test (else **G4B** Q6_K) | CPU | about 6.0 GiB of about 7.2 free | 33-38 tok/s, 2.6-2.8 min/source | $0.39/month |
| **12 GB** (RTX 3060 12 GB, 4070/5070, Arc B580; 13.1%) | **Hybrid** -> Local one click; default if class M passes | **GG12** Q4_K_M 7.12 GB or **G9B** Q6_K 7.46 GB; A/B **GG12q** (Google's QAT Q4_0, 6.98 GB) | CPU | about 7.6-7.7 GiB | 33-43 tok/s, 2.1-2.7 min/source | $0.39/month |
| **16 GB** (4060 Ti/5060 Ti 16, 5070 Ti/5080, RX 7800 XT/9070; 27.2%) | **Hybrid** -> Local one click; default if class M passes | **GG12** Q6_K 9.79 GB (Q8_0 does not fit with margin) | GPU | about 10.1 GiB | 29-54 tok/s (12B Q4), about 2-3 min/source | $0.39/month |
| **24 GB+** (3090/4090/5090, 7900 XTX; 5.5% at 24 GB, 1.4% more at 32 GB) | **Local** (verify) -> Hybrid | **G27** Qwen3.8-27B UD-Q4_K_M 16.46 GB, or **GG26** Gemma 4 26B-A4B UD-Q4_K_M 16.95 GB (MoE, faster; A/B **GG26q**, Google's QAT Q4_0, 14.44 GB); on 32 GB: **G35** 22.13 GB | GPU | about 16.3-16.6 GiB (fits a 19.7 GiB budget with margin 1.10) | 27B about 37 tok/s on a 4090, about 2.3 min/source; MoE faster | $0.39/month |

Sources: tiers, speeds and pitfalls [H3 7-10]; budgets and margins [H4 5-6]; VRAM share [S43]; file sizes [S23]
[F 2, 5]. On 16 GB VRAM, GG26q (14.44 GB) fits only with partial CPU offload of the MoE experts, which is untested [I].

### 3.3 Conditions before any Windows Local is worth testing [H3 1, 10]

1. node-llama-cpp 3.19.0 -> 3.22.2 (npm `latest`, published 2026-10-17) [S37]. What the releases contain:
   - 3.20.0 (2026-08-11): no Vulkan item;
   - 3.21.0 (2026-09-12): Vulkan device reading aligned with `llama.cpp`, model and context `memoryUsage`, and a fix
     for Metal 4 tensor API issues on M5 Macs;
   - 3.22.0 (2026-09-27): arm64 Windows build optimizations and "structured decisions with any model";
   - 3.22.2: adapts to breaking llama.cpp changes [S37][F 0 #7].
2. Authenticode-sign every unpacked `.node`/`.dll`: Smart App Control blocks the unsigned `llama-addon.node`
   (issue #676, open, "error 4551") [S39][S42].
3. Run GGUF inference in a utility/child process with a watchdog, because native crashes kill the main process. One
   example is issue #554 (open): a SIGSEGV on Linux x64 during the CPU fallback after an incompatible Vulkan prebuilt
   [S39].
4. `batchSize: 1024` for the `qwen35` architecture on Vulkan. Garbage output at batch 512 was reported on an
   RX 7900 XTX (Windows 11, Qwen3.5-27B). The issue was closed on 2026-10-03 as stale, not fixed, so the workaround
   stays [S41]. Keep Gemma 4 as the audited alternate writer.
5. Never trust iGPU memory from spec sheets: Intel Arc `getVramState()` can underflow to 0 (issue #653, open) [S39].
   Probe by loading a tiny model.
6. Linux (3.05% of Steam [S43]): ship the Vulkan + CPU prebuilts and an AppArmor profile on Ubuntu 24.04. Shipping
   only those is a packaging choice: node-llama-cpp 3.22.2 also publishes `linux-x64-cuda` and `-cuda-ext`. No ROCm
   prebuilt exists [S37][H3 1.10].

---

## 4. Model reference (codes used in the tables)

Sizes are bytes of weight files from the HF API on 2026-10-18 (GB = 10^9 B) [S23]. "Inst." = already installed on the
owner's Mac (`~/Library/Application Support/@app/desktop/local-models` or `.cache/models`) [M].

| Code | Repository / file | Quant | Size | Licence | Runtime | Revision | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **E06** | `Qwen/Qwen3-Embedding-0.6B-GGUF` / `Qwen3-Embedding-0.6B-Q8_0.gguf` | Q8_0 | 639,150,592 B | Apache-2.0 | GGUF | `370f27d7` | catalog default, 1024-d; inst. [R2] |
| E4B | `Qwen/Qwen3-Embedding-4B-GGUF` / `Qwen3-Embedding-4B-Q8_0.gguf` (or Q4_K_M 2.50 GB) | Q8_0 | 4.28 GB | Apache-2.0 | GGUF | `f4602530` | +5.1 MTEB Multilingual v2 over E06; new space [H2][S17] |
| **R06m** | `Qwen/Qwen3-Reranker-0.6B` / `model.safetensors` | bf16 | 1,191,588,280 B | Apache-2.0 | MLX | `e61197ed` | catalog default on macOS; inst. [R2] |
| **R06g** | `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` | Q8_0 | 639,153,184 B | Apache-2.0 | GGUF | `a02f48bb` | catalog default elsewhere; inst. [R2] |
| R4B | `mlx-community/Qwen3-Reranker-4B-mxfp8` / `model.safetensors` | mxfp8 | 4.15 GB | Apache-2.0 | MLX | `25f203a2` | mxfp8 is in the pinned sources (MLX Swift 0.31.6 `QuantizationMode.mxfp8`; mlx-swift-lm 3.31.4 `ModelConversion.swift`); untested at run time with this reranker [S56] |
| M4B-old | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | 4-bit | 2.26 GB | Apache-2.0 | MLX | `50d42775` | current small writer; inst.; superseded by M4B [R2] |
| **M4B** | `mlx-community/Qwen3.5-4B-MLX-4bit` | 4-bit | 3.03 GB | Apache-2.0 | MLX | `32f3e8ec` | thinking on by default: disable |
| **M9B4** | `mlx-community/Qwen3.5-9B-4bit` | 4-bit | 5.95 GB | Apache-2.0 | MLX | `8b2b98c0` | current large writer; inst. [R2] |
| **M9B6** | `mlx-community/Qwen3.5-9B-6bit` | 6-bit | 8.19 GB | Apache-2.0 | MLX | `76fe4065` | |
| **MG12** | `mlx-community/gemma-4-12B-it-4bit` | 4-bit | 6.74 GB | Apache-2.0 upstream; catalog says "Gemma" | MLX (`gemma4_unified`) | `73bcf090` | in catalog, not installed; no licence tag on the conversion. Google's QAT Q4_0 GGUF is GG12q; the MLX QAT 4-bit (10.99 GB) does not fit 16 GB |
| **MG26** | `mlx-community/gemma-4-26b-a4b-it-4bit` | 4-bit | 15.34 GB | Apache-2.0 | MLX (`gemma4`) | `0d77464e` | MoE, 3.8B active; MMMLU 86.3 [V S22]; QAT A/B arm: MG26q |
| MG26q | `mlx-community/gemma-4-26B-A4B-it-qat-4bit` | QAT 4-bit (affine, group 64) | 15.61 GB | no licence tag on the conversion (upstream Apache-2.0) | MLX (`gemma4`) | `0e3cbab3` | the 111.7 tok/s anchor on the owner's chip class is a QAT conversion (row `gemma-4-26B-A4B-it-QAT-MLX-4bit`, not necessarily this upload) [C S24] |
| MG31-6 | `mlx-community/gemma-4-31b-it-6bit` | 6-bit | 26.09 GB | Apache-2.0 | MLX | `7d13b589` | pt-BR prose A/B; Gemma dense KV is large |
| **M27-4** | `mlx-community/Qwen3.8-27B-4bit` | 4-bit RTN | 16.05 GB | Apache-2.0 | MLX (`qwen3_5`) | `10c35caa` | no KLD published for Qwen3.8-27B; the predecessor Qwen3.6-27B 4-bit measured 0.113 vs bf16 [S27] |
| M27-6 | `mlx-community/Qwen3.8-27B-oQ6` | oQ6 | 23.30 GB | no licence tag on the conversion (base Apache-2.0) | MLX | `1886f315` | oMLX mixed precision (6-bit default, 34 modules at 8-bit); no Qwen3.8 KLD (a Qwen3.6-27B oQ6 from another uploader measured 0.030) [S27] |
| **M27-8** | `mlx-community/Qwen3.8-27B-8bit` | 8-bit | 29.50 GB | Apache-2.0 | MLX | `815b83c0` | quality option, slow |
| **M35-4** | `mlx-community/Qwen3.6-35B-A3B-4bit-DWQ` | DWQ, mixed: 240 expert modules 4-bit, 272 modules 8-bit (HF tag `8-bit`) | 20.66 GB | no licence tag on the conversion (base Apache-2.0); the README is a 6-line stub with no `base_model` | MLX (`qwen3_5_moe`) | `73c707af` | KLD 0.027 vs 8-bit; plain RTN 4-bit is 0.074 [S27]; check provenance by hand [F 0 #3] |
| **M35-6** | `mlx-community/Qwen3.6-35B-A3B-6bit` | 6-bit | 29.06 GB | Apache-2.0 | MLX | `cb7e092e` | KLD 0.012 vs 8-bit [S27] |
| **M35-8** | `mlx-community/Qwen3.6-35B-A3B-8bit` | 8-bit | 37.72 GB | Apache-2.0 | MLX | `e06a74e6` | owner's primary candidate; Qwen has released no newer small MoE [F 2] |
| G2B | `unsloth/Qwen3.5-2B-GGUF` / `Qwen3.5-2B-Q4_K_M.gguf` | Q4_K_M | 1.28 GB | Apache-2.0 | GGUF | `f6d5376b` | floor only |
| **G4B** | `unsloth/Qwen3.5-4B-GGUF` / `Qwen3.5-4B-Q4_K_M.gguf` (Q4_0 2.58, Q5_K_M 3.14, Q6_K 3.53) | Q4_K_M | 2.74 GB | Apache-2.0 | GGUF | `e87f1764` | |
| **G9B** | `unsloth/Qwen3.5-9B-GGUF` / `Qwen3.5-9B-Q4_K_M.gguf` (Q4_0 5.38, Q6_K 7.46, Q8_0 9.53) | Q4_K_M | 5.68 GB | Apache-2.0 | GGUF | `3885219b` | |
| **GG12** | `unsloth/gemma-4-12b-it-GGUF` / `gemma-4-12b-it-Q4_K_M.gguf` (Q6_K 9.79, Q8_0 12.67) | Q4_K_M | 7.12 GB | Apache-2.0 | GGUF | `fc034cff` | MTP draft 0.47 GB exists; same-size A/B: GG12q |
| **G27** | `unsloth/Qwen3.8-27B-GGUF` / `Qwen3.8-27B-UD-Q4_K_M.gguf` | UD-Q4_K_M | 16.46 GB | Apache-2.0 | GGUF | `4ca72078` | MTP draft `MTP/mtp-Qwen3.8-27B-Q4_0.gguf` (1.37 GB) in the same repo |
| **GG26** | `unsloth/gemma-4-26B-A4B-it-GGUF` / `gemma-4-26B-A4B-it-UD-Q4_K_M.gguf` | UD-Q4_K_M | 16.95 GB | Apache-2.0 | GGUF | `c099eb48` | Google's QAT Q4_0 file (GG26q) is 2.5 GB smaller |
| GG12q | `google/gemma-4-12B-it-qat-q4_0-gguf` / `gemma-4-12b-it-qat-q4_0.gguf` | QAT Q4_0 | 6.98 GB | Apache-2.0 | GGUF | `29d09777` | Google's own QAT file; A/B for GG12 |
| GG26q | `google/gemma-4-26B-A4B-it-qat-q4_0-gguf` / `gemma-4-26B_q4_0-it.gguf` | QAT Q4_0 | 14.44 GB | Apache-2.0 | GGUF | `d1c082be` | Google's own QAT file; A/B for GG26 on 24 GB VRAM |
| **G35** | `unsloth/Qwen3.6-35B-A3B-GGUF` / `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf` | UD-Q4_K_M | 22.13 GB | Apache-2.0 | GGUF | `a483e9e6` | |

All of these model types are in the mlx-swift-lm registry of both the pinned 3.31.4 and the 3.32.3 tags (`qwen3_5`,
`qwen3_5_moe`, `gemma4`, `gemma4_unified`), or supported by node-llama-cpp 3.19.0 (Qwen 3.5 since 3.18.0, Gemma 4
since 3.19.0) [S32][S37][F 2]. The Qwen3.8 MLX conversions declare `qwen3_5`; `qwen3_8` and `qwen3_8_moe` exist only on
the unreleased `main` [S32].

Rejected for the writer:
- gpt-oss: weaker multilingual (20b MMMLU 69.7 vs Qwen3.5-9B 81.2; JSON pass 0.845), and OpenAI has released no newer
  gpt-oss [V S21][S25][S23].
- Qwen3.8-Flash-Next: model type `qwen4_exp` is absent from the registry, its bf16 weights are 360 GB and its licence
  tag is `other` [S32][S23].
- Mistral Small 4 (119B total, 6.5B active [S14]) and DeepSeek V4: no model type in the Swift registry (H1; not
  re-checked) [S32].
- Sub-4B models.
- Jina models: CC-BY-NC, rejected by `rules/security-privacy.md` [R16][H2].

---

## 5. The owner's machine: M4 Max (16 CPU / 40 GPU cores), 64 GB, 546 GB/s

Measured [M H1][M H4]: GPU working set 55,662,788,608 B = 51.84 GiB (81.0%); `iogpu.wired_limit_mb` = 0 (default);
node-llama-cpp `getVramState().total` returns the same bytes; writer budget 48.2 GiB under the section 6 formula;
`process.availableMemory()` 33.7 GiB at H4's probe and 32.4 GiB at the fact-check probe, with 4.25-4.36 GiB of swap
already in use (both dynamic) [F 4].

**Recommendation: Local preset**, shown as "suggested" until the section 7 bake-off passes.

| Role | Model | Download | Resident | Expected speed | Why |
| --- | --- | --- | --- | --- | --- |
| Writer (all classes) | **M35-8** Qwen3.6-35B-A3B 8-bit | 37.72 GB | about 36.4 GiB | about 94 tok/s decode, about 2,100 tok/s prefill (row `Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated-mlx-8bit`: a fine-tune with the same architecture and bits; no official 8-bit row is listed); about 12 s/call, 9 min/chapter, about 1.1 h of writer time per typical month [C][D] | Best public structured-output signal in this family: the predecessor Qwen3.5-35B came second overall in SOB (value accuracy 0.801, JSON pass 0.969), behind GLM-4.7 (0.804) and ahead of GPT-4.1 (0.783 / 0.969); Qwen3.6-35B-A3B itself was not tested [S25][F 0 #1]; MoE speed; fits with margin 1.32 under the 48.2 GiB budget [H4][I] |
| Writer, lighter variant | M35-6 (6-bit) | 29.06 GB | about 28.4 GiB | slightly faster than 8-bit | KLD 0.012 against the 8-bit; leaves about 8 GB more for the owner's development load (Docker, IDE) [S27][I]. Pick it if the bake-off shows a tie |
| Writer, quality alternative | M27-8 Qwen3.8-27B 8-bit | 29.50 GB | about 29.5 GiB | 16.5 tok/s, prefill 260 (same chip class) [C]; about 51 min/chapter | dense; for `write-quality`/`answer` A/B only: 5-6x slower for bulk graph work |
| A/B for pt-BR prose | MG26 (15.34 GB) and its QAT twin MG26q (15.61 GB): a QAT conversion runs at 111.7 tok/s on this chip class, the plain 4-bit at 79.5 on an M4 Max 32c 36 GB [C]; MG31-6 (26.09 GB) | | | | Gemma 4 leads MMMLU per size (26B-A4B 86.3, 31B 88.4) [V S22] |
| Embedding | **E06** (unchanged) | installed | 0.6 GiB | 105 notes/s measured [R7] | calibrated space; E4B only after the E-A bake-off |
| Reranker | **R06m** (unchanged) | installed | 1.2-1.3 GiB | 25-36 ms/pair measured [R8] | validated decider; R4B only as gray-zone escalation after the E-B rerun |
| Total resident | | | **about 38.3 GiB** of 51.84 GiB cap; about 25 GiB of RAM left for macOS and apps | | |

Alternatives shown next to it:
- **Hybrid with gpt-6-luna** (low reasoning) via the owner's Codex sign-in: $0 extra on the plan, about 10 credits in a
  typical month; also the quality reference for the bake-off [S3][H5].
- **Hybrid with a higher-quality answer model**: gpt-6.1-sol for `answer` only adds about **$1.37/month** for 60 Ask
  questions on the API. The Sol bill for those questions is $1.44, against $0.07 on gpt-6-luna [S1][D].

What the owner gets with Local: privacy and offline use at about the same per-call speed as a serial cloud call
(gpt-6-luna: about 119 tok/s and 2.2 s TTFT at low [S11]). Quality against gpt-6-luna on pt-BR prose is unknown. The
public proxies place Qwen3-30B, the 2025 generation, near GPT-4.1 and well below GPT-5 Mini on pt-BR (Prosa 73.9 vs
74.8 vs 84.8). No Qwen3.6 figure is published, so the proxy may understate the current model [S26][F 7]. If the bake-off shows a material pt-BR gap, the recommendation becomes Local for `write-fast`/`write-quality`
and gpt-6-luna for `answer` (a Custom route), or plain Hybrid.

---

## 6. Detection design

### 6.1 Signals per OS (all local; the profile never leaves the device)

| Signal | macOS (Apple Silicon) | Windows | Linux | Source |
| --- | --- | --- | --- | --- |
| CPU, real arch, translation | `sysctl machdep.cpu.brand_string`, `hw.optional.arm64`, `sysctl.proc_translated`; Electron `app.runningUnderARM64Translation` (an x64 build under Rosetta must not disable MLX) | `os.cpus()`, `process.arch`, `os.machine()`; CIM `Win32_Processor` for physical cores | `/proc/cpuinfo`, `llama.systemInfo` | [H4 3][S46][S52] |
| RAM total / available | `os.totalmem()`; `process.availableMemory()` (free + inactive + purgeable; 33.7 vs `os.freemem()` 11.6 GiB here) | same | same (`MemAvailable`, cgroup-aware; `process.constrainedMemory()`) | [M H4][S47] |
| Accelerator memory | Metal working set = node-llama-cpp `getVramState().total` / `unifiedSize` (identical to the Swift query) | node-llama-cpp `getVramState().free`; registry `HardwareInformation.qwMemorySize` (64-bit); `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version`; DXCore `QueryState(AdapterMemoryBudget)` as a live budget; never `AdapterRAM` (uint32, 4 GB cap; Msinfo32 misreports from 2 GB up) | `getVramState()`; amdgpu sysfs `mem_info_vram_total`; `nvidia-smi` | [M H4][S48][S50][S51][S53] |
| Backend actually usable | Metal (MLX helper + GGUF) | `getLlamaGpuTypes("supported")`, then `getLlama({build:"never"})` -> `llama.gpu` (CUDA only with toolkit DLLs, else Vulkan, else CPU) | same; Vulkan needs `libvulkan.so.1` | [R17][S38] |
| GPU class / bandwidth | `system_profiler SPDisplaysDataType -json` `sppci_cores` (M4 Max 32c = 410 GB/s, 40c = 546) + chip table | small name -> GB/s table; else measured | same | [H4 3.2][S33][S55] |
| Pressure, swap | `kern.memorystatus_level`, `vm.swapusage` growth | `getSwapState()` (page file) | `MemAvailable`, swap | [M H4] |
| Power, thermal | `powerMonitor.isOnBatteryPower()`, `getCurrentThermalState()`, Low Power Mode via `pmset -g` | `isOnBatteryPower()`, `speed-limit-change` | battery only | [S46] |
| NPU | Neural Engine (informational) | DXCore NPU attribute / PnP compute-accelerator class (informational only; no runtime uses it) | - | [S51][S54] |
| Free disk | `fs.statfs` on the models volume | same | same | [S47] |

Command hygiene: `execFile` with absolute paths (`/usr/sbin/sysctl`, `/usr/sbin/system_profiler`,
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive`), fixed arguments, no shell,
5 s timeout, 1 MB output cap, Zod-validated output. Windows uses PowerShell CIM because WMIC is removed from current
Windows 11: it was removed in the August 2026 preview update for 24H2/25H2 and the September 2026 update for 26H1,
while Windows 10 and Server keep it [S49]. `system_profiler` costs 80-280 ms (0.23 s measured) and stays off the hot
path [M H4][F 4].

### 6.2 Algorithm

```
profile   = probe()                                   // static, cached (6.3)
snapshot  = dynamic()                                 // availableMemory, pressure, swap, power, thermal, disk
acc       = backend that will really load             // Metal | CUDA | Vulkan | CPU
workingSet= apple: getVramState().total | dGPU: getVramState().free | shared: min(shared, 0.5 x RAM) | cpu: availableMemory
gpuPad    = min(8% of workingSet, 1.6 GiB)            // node-llama-cpp's own padding
resident  = 2.0 GiB                                   // E06 + R06m/R06g peak
hostReserve = 9 GiB on unified memory (cal.)          // macOS wired 4.4-4.7 GiB + D39 headroom
budget    = apple:    min(workingSet - gpuPad, RAM - hostReserve) - resident
            discrete: workingSet - gpuPad - 0.5 GiB - (resident on GPU ? 1.2 : 0)
            cpu:      availableMemory - 6 GiB - resident
for writer in catalog (largest first, per platform):
    fits   = writer.footprint(ctx 8k) x margin <= budget      // ctx pinned per class (D36 local calls fit 8k); margin 1.25 derived, 1.10 measured/GgufInsights
    speed  = 0.5 x bandwidth / writer.activeBytes             // low estimate; unknown bandwidth = "unverified"
    ok     = fits && speed >= 8 tok/s && (acc is GPU || prefill measured >= 100 tok/s)
pick      = first ok writer
preset    = !embedderRuns          -> Cloud (disclosed provider embedding)
            rankerBench > 150 ms   -> Cloud with local embedding (generative decide on the cloud writer)
            !pick                  -> Hybrid
            pick.class == "S"      -> Hybrid (Local offered as private/offline mode)
            pick.class == "M"      -> classVerified("M") ? Local : Hybrid (Local offered)
            pick.class == "L"      -> Local (shown "suggested" until the device check passes)
```

- `footprint` and `activeBytes` become catalog fields: measured peak at the pinned context (from section 7), and
  active bytes per token for MoE. `minimumMemoryBytes` stays as the display value [H4 6.4].
- `classify` and `recommend` are pure functions in `packages/domain`, table-tested on recorded profiles (Rosetta,
  unknown chip, VRAM unknown, Windows arm64, 8 GB and 512 GB Macs) [H4 8].
- Dynamic modifiers never change the tier; they set a run policy. On battery, at thermal `serious`, or in Low Power
  Mode, local writer jobs wait while Ask still runs. If `availableMemory < footprint + 1 GiB`, the writer is
  `blocked: memory` (D39) [H4 6.2][R10].
- The selection ladder for Macs, as this document reconciles it (L-class thresholds use H1's 16k-context footprints,
  so they are conservative by 0.1-0.5 GiB): budget < 4.5 GiB -> no local writer; S class M4B from about 4.5 GiB
  (8k); M class M9B4 from about 8.8 (M9B6 from about 11.4); L class MG26 from about 19.8 GiB (17.4 once measured),
  M35-4 from about 25.6 (22.6 measured), M35-6 from about 35.5 (31.2), M35-8 from about 45.5 (40). Owner: 48.2 ->
  M35-8 [H1 6][H4][I].

### 6.3 Caching and refresh

- Static profile: a JSON file under `userData` (`hardware/profile-v1.json`), **not in PostgreSQL**. A restored backup
  must not carry another machine's profile (`RULES.md` section 2: PostgreSQL is canonical; derived data never defines
  identity). The accepted preset stays a database setting [H4 4].
- Fingerprint = sha256 of `{platform, os.release, nativeArch, totalBytes, cpu.brand, accelerator names, driver versions}`.
  Cheap fields are recomputed at every start in under 5 ms. A full re-probe runs on a fingerprint change, when the
  profile is 30 days old, after an out-of-memory model load, after a runtime build change (the same trigger that
  re-validates rankers), or on "Re-detect" [H4 4][R15].
- Benchmark results are keyed by `fingerprint + model revision + runtime version` and feed back measured bandwidth
  (`decode tok/s x active bytes`), so future chips self-calibrate [H4 7].
- Dynamic values (available memory, pressure, swap, battery, thermal, disk) are read at admission time, never cached.

### 6.4 Privacy

- Allowlist, not denylist: `system_profiler SPHardwareDataType` returns `serial_number`, `platform_UUID` and
  `provisioning_UDID` [M H4]. Use `sysctl` and `SPDisplaysDataType`, parse only `chip_type` if needed, and drop
  everything else in the same function. A contract test asserts that no persisted or IPC field matches serial, UUID,
  UDID, hostname, user name, MAC, IP, volume label or path patterns [H4 3.7].
- The profile is never sent to a provider, never put in prompts, and never logged at `info` or exported. The optional
  cloud latency probe is a separate consent and sends a synthetic 50-token request with no user data [H4 7].
- Never change `iogpu.wired_limit_mb`: it needs sudo, it does not persist, and on a 24 GB M4 Pro raising it made the
  kernel panics worse [S28]. Show the cap, and offer the sysctl line only as an expert note with the warning [H1 7.5].
- The sysctl is not the only risk. The mlx-lm #883 kernel panic came from mlx's own `set_wired_limit` at about 75% of
  a 96 GB M3 Ultra, and one commenter reproduced it with default settings on macOS 26.4 [S36]. So the swap-growth and
  memory-pressure guard (`blocked: memory` in 6.2, swap delta in 7.4) applies at default settings too [F 0 #11].

### 6.5 First run (F4) and Settings v2 (F5)

Principles: **one recommended choice, alternatives one click away, never blocking**, with sizes and costs stated
before anything is downloaded or spent (decision 25 [R6]; `rules/security-privacy.md` remote AI disclosure [R16]).

First run, after the embedding model is installed (every preset needs it):

```
This Mac: Apple M4 Max, 64 GB. About 48 GB usable for AI models.
Recommended: Local, private (your notes stay on this Mac)
  Writer   Qwen3.6-35B-A3B 8-bit   37.7 GB download   about 9 min per 30-page chapter
  Search   Qwen3-Embedding-0.6B    installed
  Relations Qwen3-Reranker-0.6B    installed
  [Use Local]   [Verify on this Mac first, about 90 s]
Other choices
  Hybrid  local search and relations, writer gpt-6-luna   about $0.39/month (API) or included in ChatGPT Plus/Pro
  Cloud   everything that can run remotely                about $0.45/month
  [Decide later]   (the app works with search only)
```

- On a 16 GB Mac, the card leads with Hybrid and says why in one sentence ("A local writer on this Mac would be slow
  and noticeably less accurate on knowledge-graph and Portuguese text"). Local remains a visible alternative labelled
  "private, offline, lower quality".
- "Verify on this Mac" runs the opt-in benchmark of H4 section 7: embed 128 texts, rank 64 pairs x 3, and, only if the
  writer is installed or approved, 1 decode probe plus 6 structured calls. It runs at background priority, can be
  cancelled, refuses on battery below 50% or at thermal `serious`, and never downloads silently. If it fails, the
  recommendation steps down **one** tier; if marginal, the recommendation stays and the reason and the alternative are
  shown [H4 7].
- Cloud choices disclose what is sent and each provider's retention at the moment of choice. Costs come from the
  versioned price table, and the monthly cap applies [R16].

Settings v2 (decision 24 inventory [R6]): one "AI on this device" panel holds:
- tier name;
- the budget in plain words;
- the backend (Metal, Vulkan, CUDA or CPU, plus "CUDA not installed, using Vulkan" where it applies);
- the verified state with date;
- the GPU cap as an expert detail;
- Re-detect and Verify actions;
- the preset selector with a "Recommended for this device" badge, each option's download size and monthly estimate, and
  the per-provider privacy line.

New stored state is minimal: the profile file, the last benchmark result, and the accepted preset (already a setting).

### 6.6 Code seams (for the F4 task, not done here) [H4 6.4][R1][R3][R4]

1. `PresetMachine` gains `nativeArch`, `translated`, `writerBudgetBytes`, `tier`, `qualityClass`. The old three
   fields stay, so existing tests hold; `largeLocalWriterMinimumMemoryBytes` becomes a derived expectation.
2. `machineRunsMlx` uses `nativeArch`.
3. `detectLocalRuntimeCompatibility` takes `budgetBytes` (and `availableBytes` at admission) and returns
   `insufficient_budget`.
4. The catalog gains `footprintBytes`, `activeBytesPerToken` and `qualityClass`, plus GGUF writer entries for Windows.
5. `planAiPreset` returns `no_local_writer_for_platform` instead of `local_requires_apple_silicon` once GGUF writers
   exist.

---

## 7. On-device validation plan (owner's 64 GB Mac)

### 7.1 Preconditions

- Owner approval for the downloads in section 8 (stage them: the home volume has 155.2 GiB free [M H4][F 3]).
- A spike branch for the runtime upgrades (mlx-swift-lm 3.32.3 for `MLXGuidedGeneration`, node-llama-cpp 3.22.2).
  Both are `STACK.md` changes that need build, packaging and ranker re-validation [S31][S37][R15]. Every candidate is
  measured **with and without** guided decoding, so the result stands even if the upgrade waits.
- One local model job at a time; the proof-slot rule D45 applies (the DEV app and a local model holder) [R10].
- Electron, PostgreSQL and the resident E06/R06m are running during the measurement (realistic memory), on AC power,
  with thermal state `nominal` at the start.

### 7.2 Two harness levels

| Level | What | Reference | Cost |
| --- | --- | --- | --- |
| **L1 prompt replay** | Feed every recorded generative prompt of the golden-small cassette (`.cache/golden/cassettes/golden-small-f2`: summaries, atomic notes, knowledge graph, identity/relation typing; recorded on `openai-codex` / `gpt-5.6-luna`, reasoning low) to each candidate writer, using the same contract and schema | The recorded Codex answers in the same entries; same inputs, so the comparison is exact | $0; about 335 generative calls per arm (41 + 29 + 226 + topic names) at 10-70 s each: about 1-6 h per arm [R12][I] |
| **L2 end-to-end** | Full golden-small run (30 sources, 197 chunks, 160 notes) with the local route recorded into a new cassette, then `scripts/golden/compare.ts` against the Codex run `2026-10-16T22-31-26-329Z` | Stage outcomes, note counts, relations, `calls-per-chapter.ts`, `graph-salvage-share.ts` | $0; hours per arm; only for the 2 finalists [R11][R12] |
| Cloud reference | One live golden-small run on **gpt-6-luna** at `low` (and `none` for decide-only calls) | New cloud baseline for "Hybrid" | about $0.19 on the API or about 4.8 plan credits per run [H5] |

### 7.3 Candidates and order

| Step | Arms | Purpose |
| --- | --- | --- |
| 0 (no download) | Detection prototype + caps; E06 notes/s, R06m ms/pair; installed **M4B-old** and **M9B4** on L1 | Baseline: how far today's local writers are from Codex |
| 1 | **M35-8**, **M35-4**, **MG26** | L-class MoE: owner default and the 32-48 GB tier picks |
| 2 | **M27-4**, **M27-8** | Dense L class: 32 GB quality option and owner quality alternative |
| 3 | **M9B6**, **M4B**, **MG12** | M and S classes: decides the 16/24 GB and 8-16 GB VRAM defaults |
| 4 (optional) | M35-6, MG26q (QAT), MG31-6, M27-6 | Quant and pt-BR prose A/B |
| 5 (GGUF on Metal) | **G9B**, **G4B**, **GG12**, **G27** (optional: GG26, GG12q, GG26q) through node-llama-cpp with the grammar | Pre-validates Windows writer **quality** and the GGUF JSON path; speed is not representative of Windows |
| 6 (optional) | E-A: E4B at 1024-d MRL and 2560-d; E-B: R4B on the Spike A pairs; E-C: E06 cosine Metal vs CPU (`gpu: false`) | Embedding/reranker upgrades and a first cross-backend parity check [H2 7.3] |

### 7.4 Metrics and proposed bars (pre-register before the runs; all *(cal.)*)

| Axis | Metric | Bar for "Local default allowed" |
| --- | --- | --- |
| Memory | peak resident (MLX `Memory` peak / RSS; `getLlamaMemoryUsage` for GGUF), the read GPU cap, swap delta (`vm.swapusage`), minimum `kern.memorystatus_level` | swap growth <= 256 MiB per run; measured peak becomes the catalog `footprintBytes` [H4 7] |
| Speed | TTFT, prefill and decode tok/s at 1k/4k/8k context, seconds per call, minutes per chapter, thermal at end | decode >= 15 tok/s for `answer`, >= 8 for background; chapter <= 30 min [H4 7][I] |
| Structure | first-pass schema validity per contract, repairs, schema fallbacks, salvaged items | repairs <= 2% (D35 accounting) and post-salvage 100% [R10] |
| Graph quality | entity and relation yield versus the Codex answer for the same prompt (normalized-name match); precision on a hand-checked sample of 30 pairs; dropped relations | yield >= 85% of the reference with precision no more than 5 points lower [I, proposal] |
| Notes and summaries | atomic-note count per source vs reference; summary faithfulness and pt-BR fluency by the owner's blind A/B on 20 pt-BR + 20 en items (D20 style) | not worse than the reference on >= 60% of blind pairs [I, proposal] |
| Topic names | the 13 pt-BR topic names of the E6 baseline, owner rubric | no regression [H1 8] |
| End to end (L2) | `compare.ts` stage outcomes, calls per chapter, failed stages | 0 failed stages |

A class passes when its best candidate meets every bar. Class M passing flips the 24 GB Mac and the 8-16 GB VRAM rows
to Local default. Class L failing on the owner's Mac flips the owner's recommendation to Hybrid.

### 7.5 What can only be validated elsewhere

On other Macs (no port needed): the default GPU cap at 8, 16, 32, 36, 48, 96 and 128 GB (one-line Swift probe), and
the 16/24 GB swap behaviour under the real app. These figures are inferred today [H1 9].

Only after the Windows port [H3 12][H4 9]:
- Vulkan, CUDA and CPU writer speed per vendor (all Windows speeds are derived);
- iGPU heap sizing (AMD VGM, Intel override, the 3.5 GB report);
- Smart App Control with signed natives;
- crash isolation in a utility process;
- the Qwen3.5 Vulkan batch-512 bug on AMD;
- the PowerShell/registry VRAM chain and NPU detection;
- embedding cosine and reranker score parity CPU vs Vulkan vs CUDA vs Metal;
- non-ASCII user paths (`C:\Users\João`);
- Windows on Arm CPU speed with Q4_0;
- Strix Halo and RTX Spark;
- installer size with the CUDA pack;
- Linux AppArmor.

---

## 8. Download list for the benchmark (for the owner's approval)

Nothing below has been downloaded. Already installed and needing no download: E06, R06m (`.cache/models`), R06g,
M4B-old, M9B4 [M]. Sizes, revisions, licences and shard counts are from the HF API, 2026-10-18 [S23][F 3]. Download a whole MLX repository
(weights + tokenizer + config); for GGUF, only the named file.

| Pri. | Code | Repository | Files | Size | Licence | Revision |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | M35-8 | `mlx-community/Qwen3.6-35B-A3B-8bit` | 8 safetensors shards + config/tokenizer | 37.72 GB | Apache-2.0 | `e06a74e6236a60c8367e1a3214e83d8b61b637b0` |
| 1 | M35-4 | `mlx-community/Qwen3.6-35B-A3B-4bit-DWQ` (DWQ, mixed 4/8-bit) | 4 shards + config/tokenizer | 20.66 GB | no tag on the conversion, and the README is a 6-line stub with no licence or `base_model`; base `Qwen/Qwen3.6-35B-A3B` is Apache-2.0 (check provenance by hand) | `73c707af4243243b18193444467872d20cff9399` |
| 1 | MG26 | `mlx-community/gemma-4-26b-a4b-it-4bit` | 3 shards + config/tokenizer | 15.34 GB | Apache-2.0 | `0d77464eeb233a2da68ebf9d7dc4edaac7db956d` |
| 1 | M27-8 | `mlx-community/Qwen3.8-27B-8bit` | 6 shards + config/tokenizer | 29.50 GB | Apache-2.0 | `815b83c0df8ffd1d1b5244cf75fd6ef14fca9ef9` |
| 1 | M27-4 | `mlx-community/Qwen3.8-27B-4bit` | 3 shards + config/tokenizer | 16.05 GB | Apache-2.0 | `10c35caafbb80f7dc6a7a432cdd11af10a6d4818` |
| 1 | M9B6 | `mlx-community/Qwen3.5-9B-6bit` | 2 shards + config/tokenizer | 8.19 GB | Apache-2.0 | `76fe4065e622cf34990d3c13ef80ec8531c9a0f7` |
| 1 | M4B | `mlx-community/Qwen3.5-4B-MLX-4bit` | 1 file + config/tokenizer | 3.03 GB | Apache-2.0 | `32f3e8ecf65426fc3306969496342d504bfa13f3` |
| 1 | MG12 | `mlx-community/gemma-4-12B-it-4bit` (catalog pin) | 2 shards + config/tokenizer | 6.74 GB | Apache-2.0 upstream (no tag on the conversion) | `73bcf09092aa277861d5a191b989b666f7f32e8f` |
| 2 | M35-6 | `mlx-community/Qwen3.6-35B-A3B-6bit` | 6 shards | 29.06 GB | Apache-2.0 | `cb7e092ef8efe540bc3672c8929c4adbe5f4f759` |
| 2 | MG31-6 | `mlx-community/gemma-4-31b-it-6bit` | 5 shards | 26.09 GB | Apache-2.0 | `7d13b589b7260ba361377b41693a6fdb82b1e06f` |
| 2 | M27-6 | `mlx-community/Qwen3.8-27B-oQ6` | 5 shards | 23.30 GB | no tag (base Apache-2.0; verify) | `1886f315c877be3e6b614ac84c765e356ffb9f00` |
| 2 | MG26q | `mlx-community/gemma-4-26B-A4B-it-qat-4bit` | 3 shards + config/tokenizer | 15.61 GB | no tag on the conversion (upstream Apache-2.0) | `0e3cbab38ce568cf6e23543010d08d03b731910c` |
| 3 | G9B | `unsloth/Qwen3.5-9B-GGUF` | `Qwen3.5-9B-Q4_K_M.gguf` | 5.68 GB | Apache-2.0 | `3885219b6810b007914f3a7950a8d1b469d598a5` |
| 3 | G4B | `unsloth/Qwen3.5-4B-GGUF` | `Qwen3.5-4B-Q4_K_M.gguf` | 2.74 GB | Apache-2.0 | `e87f176479d0855a907a41277aca2f8ee7a09523` |
| 3 | GG12 | `unsloth/gemma-4-12b-it-GGUF` | `gemma-4-12b-it-Q4_K_M.gguf` | 7.12 GB | Apache-2.0 | `fc034cfff751157913579611efad8462ac1be606` |
| 3 | G27 | `unsloth/Qwen3.8-27B-GGUF` | `Qwen3.8-27B-UD-Q4_K_M.gguf` | 16.46 GB | Apache-2.0 | `4ca720788d1e01f1bff70c033e0d0028fd02e502` |
| 3 | GG26 (opt.) | `unsloth/gemma-4-26B-A4B-it-GGUF` | `gemma-4-26B-A4B-it-UD-Q4_K_M.gguf` | 16.95 GB | Apache-2.0 | `c099eb48e663fd284577b04978a94ffccb261841` |
| 3 | GG26q (opt.) | `google/gemma-4-26B-A4B-it-qat-q4_0-gguf` | `gemma-4-26B_q4_0-it.gguf` (not the `mmproj` file) | 14.44 GB | Apache-2.0 | `d1c082be9cf3c8a514acf63b8761f4b41935842e` |
| 3 | GG12q (opt.) | `google/gemma-4-12B-it-qat-q4_0-gguf` | `gemma-4-12b-it-qat-q4_0.gguf` (not the `mmproj` file) | 6.98 GB | Apache-2.0 | `29d097773436b69ff9feafd636ab4cf873786537` |
| 4 | E4B | `Qwen/Qwen3-Embedding-4B-GGUF` | `Qwen3-Embedding-4B-Q8_0.gguf` (sha256 `b60ae5ce…949d`) | 4.28 GB | Apache-2.0 | `f4602530db1d980e16da9d7d3a70294cf5c190be` |
| 4 | R4B | `mlx-community/Qwen3-Reranker-4B-mxfp8` | `model.safetensors` + config/tokenizer | 4.15 GB | Apache-2.0 | `25f203a237b822a90f38763843562b93a5baf82f` |
| 4 | Harrier (opt.) | `mradermacher/harrier-oss-v1-0.6b-GGUF` (community; its `base_model` is the third-party mirror `calculatortamer/harrier-oss-v1-0.6b`, not `microsoft/harrier-oss-v1-0.6b`, so compare tensors before use) | `harrier-oss-v1-0.6b.Q8_0.gguf` | 0.64 GB | MIT | `d79decec1ab9442e969e79804515b9c31683d30e` |

Totals [S23][F 3]:
- priority 1 = 137.2 GB;
- priority 2 = 94.1 GB (78.5 GB without MG26q);
- priority 3 = 32.0 GB required, 49.0 GB with GG26, 70.4 GB with every optional file;
- priority 4 = 9.1 GB;
- all = about 311 GB: the draft's 274 GB plus the three QAT arms added after the fact-check.

**This does not fit at once** on the home volume (155.2 GiB free [M H4][F 3]). Suggested staging, in the section 7.3
order:
- batch A: M35-8, M35-4, MG26 (73.7 GB);
- batch B: M27-8, M27-4 (45.6 GB);
- batch C: M9B6, M4B, MG12 (18.0 GB);
- batch D: GGUF writers (32.0 GB; up to 70.4 GB with GG26, GG26q and GG12q);
- batch E: priority 2 and 4, only if wanted (up to 103.1 GB).

The owner removes each batch's files before the next one; nothing is deleted on the owner's behalf. Licence check before
adding anything to the catalog: the conversions without a licence tag (M35-4, M27-6, MG12, MG26q), and the Gemma
catalog entries, which record "Gemma" + `requiresLicenseAcceptance` while every Google Gemma 4 repository checked
(12B, 26B-A4B, 31B, E4B and both QAT GGUFs) says Apache-2.0 [H1 7.1][S22][S23][F 3].

---

## 9. Cloud

### 9.1 Per role: cheapest good enough, and one higher-quality option

Typical month = 1.52M input + 0.47M output tokens for all writing (light 0.42M/0.12M, heavy 5.70M/1.86M, one-off
5,000-note backlog 19.3M/8.2M) [H5 3]. Prices are per 1M tokens, re-fetched 2026-10-18.

| Role (classes) | Cheapest good enough | Price in / cached / out | Typical month | Higher quality | Price | Typical month | App support today |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Bulk writing (`write-fast`: summaries, metadata; `write-quality`: atomic notes, knowledge graph) | **gpt-6-luna**, reasoning `low` | $0.10 / $0.01 / $0.50; cache writes $0.125; over 272K input: input and cache x2, output x1.5 [S1][S2] | about $0.30 of the $0.39 total; backlog $6.03 ($3.01 Batch/Flex) | gpt-6.1-sol | $2.00 / $0.10 / $10.00 [S1] | all writing on Sol about $7.74 | yes: OpenAI API key (strict `json_schema`) and Codex OAuth (slug works; no `gpt-6` capability entry) [H5 6] |
| Ask answers (`answer`) | gpt-6-luna | same | about $0.07 for 60 questions (8K in + 800 out each) | **gpt-6.1-sol** for `answer` only | same | **+$1.37/month** (Sol bill $1.44 minus $0.07 on Luna) | yes (as above) |
| Generative decide (Cloud preset, or no local ranker) | gpt-6-luna, `none` or `low` after a test | same | about $0.06 for 250 notes (1,050 in + 240 out per note) | local Qwen3-Reranker-0.6B stays the quality reference (validated) | $0 | - | yes (generative decide); OpenAI Decisions beta ($0.03 per 1k pairs measured) not yet an adapter [H5 5] |
| Embedding (only when the local 0.6B cannot run) | text-embedding-3-small at 1024-d | $0.02 [S1] | about $0.004 | gemini-embedding-001 (best MTEB-BR, 0.682) | $0.15 per H5, **unverifiable**: not on Google's pricing page today, which lists only gemini-embedding-2 at $0.20 [S7][S16] | about $0.03 at H5's price | yes (`/embeddings`, Gemini `embedContent`); a space change either way [H2] |
| Second source without OpenAI | Gemini 3.5 Flash-Lite, thinking minimal, **paid tier** | $0.30 / $0.03 / $2.50 [S7] | about $1.63 | Gemini 3.8 Flash | $0.75 / $0.075 / $3.75, doubling on 2027-01-01 [S7] | about $2.90 now | yes (native Google adapter) |

Also in the gpt-6-luna price class: Claude Haiku 5.5 at $0.10 / $0.01 / $0.50 for prompts up to 100K tokens. Its
cache writes cost $0.125 (5 minutes) or $0.20 (1 hour); over 100K it costs $0.50 / $0.05 / $2.50; batch is
$0.05 / $0.25 [S9]. Typical month about $0.39. It needs a native Anthropic adapter, because the OpenAI-compatible
layer ignores `response_format` [S10][H5 2].

Not recommended for private notes (from H5; these policy pages were not re-fetched on 2026-10-18 [F 9]):
- the DeepSeek API (data stored in the PRC) [S13];
- the Gemini free tier (content used to improve products) [S7];
- OpenRouter without `data_collection: deny`/`zdr` [S15].

### 9.2 Monthly cost by usage (USD, list price) [H5 3][I]

| Model | Light | Typical | Heavy | Backlog (once) |
| --- | --- | --- | --- | --- |
| **gpt-6-luna** | 0.10 | **0.39** | 1.50 | 6.03 |
| gpt-6-luna Batch/Flex | 0.05 | 0.19 | 0.75 | 3.01 |
| gpt-5.6-luna (today's route) | 0.23 | 0.87 | 3.37 | 13.70 |
| Claude Haiku 5.5 (no adapter) | 0.10 | 0.39 | 1.50 | 6.03 |
| Gemini 3.5 Flash-Lite | 0.43 | 1.63 | 6.36 | 26.29 |
| Gemini 3.1 Flash-Lite | 0.28 | 1.08 | 4.21 | 17.12 |
| Mistral Small 4 (EU option, weaker; $0.15 / $0.60 [S14]) | 0.14 | 0.51 | 1.97 | 7.81 |
| gpt-6.1-sol (everything) | 2.04 | 7.74 | 30.00 | 120.60 |
| ChatGPT plan via Codex (gpt-6-luna) | about 2.5 credits | about 9.7 credits | about 37.5 credits | about 151 credits |

On the plan route the marginal cost is $0 within the Plus quota (350-3,000 local messages per 5 h for gpt-6-luna;
15-150 for gpt-6-sol; OpenAI calls these estimates, not fixed limits) [S3]. Plus is $20/month and Pro is $100, $200
or $500 [S3]. The cloud cost is the same on every hardware
tier. It depends on the library volume, never on the machine, so a hardware upgrade is justified by privacy or offline
use, never by cost [H3 9][I].

### 9.3 What the app supports and what must change first [H5 2, 6][R13][R14]

- Supported: Codex OAuth (Responses, strict `text.format`, `store: false`); any OpenAI-compatible base URL (OpenAI,
  Groq, Together, Fireworks, Mistral, DeepSeek, Alibaba, OpenRouter); native Gemini.
- Not supported: native Anthropic; dedicated rerank APIs; the OpenAI Decisions adapter (planned).
- Must change before gpt-6-luna becomes the default:
  1. Add `gpt-6-*` to `reasoning.ts`, which today matches only `gpt-5*`, `o1/o3/o4` and `gpt-realtime-2`
     (`reasoning.ts:110-151` [R13]). The API route therefore sends no `reasoning_effort` for gpt-6 slugs, and the
     server default `medium` applies [S2]. Artificial Analysis lists no `medium` latency today. It shows 2.17 s TTFT at
     `low`, 18.71 s at `high`, 20.63 s at `xhigh` and 0.94 s without reasoning [S11][F 0 #13], so `medium` most likely
     sits well above `low` [I].
  2. Check `max_tokens` vs `max_completion_tokens` on the OpenAI-compatible route.
  3. Run one golden-small bake-off (section 7.2).
- gpt-5.6-luna stays as the fallback while Codex still lists it; Codex says it remains available during the rollout,
  with no end date. GPT-5.5 and GPT-5.4 already left Codex sign-in on 2026-10-14 (noon PDT) and 2026-08-31 [S4].
- Distribution of the plan route: Sign in with ChatGPT puts commercial and hosted apps through a limited trial or
  waitlist [S5]. It now also documents an open-source / locally hosted app flow: dynamic registration of a per-user
  agent, eligible Responses API requests with `store: false`, and an interest form for paid or remotely hosted apps
  [S57]. That flow is the candidate replacement for the hard-coded Codex client id (`openai-codex-oauth.ts:4` [R14]).

### 9.4 Privacy notes

- Any cloud writer sends note content. The UI discloses what is sent and the retention at the moment of choice, and
  background spend obeys the monthly cap [R16].
- The provider policy facts below come from H5 and were not re-fetched by the fact-check [F 9]; re-read them before
  release.
- OpenAI API: no training by default, abuse-monitoring logs up to 30 days, zero data retention by approval [S6].
- ChatGPT-plan route: training use is governed by the account's "Improve the model for everyone" setting on personal
  plans (unverified for Codex traffic). Tell users to check it [H5 4].
- Gemini paid tier: not used to improve products. Free tier: used [S7][S8].
- The hardware profile and benchmark results stay on the device (section 6.4).

---

## 10. Open risks

| # | Risk | Effect | Cheapest check or mitigation |
| --- | --- | --- | --- |
| 1 | No public pt-BR or JSON comparison exists for any shortlisted local or cloud model [H1 4.3][H5 4] | Tier verdicts rest on MMMLU and on proxies measured on predecessor models: SOB on Qwen3.5-35B, Prosa on Qwen3-4B/30B, KLD on Qwen3.6-27B [F 7] | Section 7 bake-off; gpt-6-luna live run about $0.19 |
| 2 | GPU caps measured only at 16, 24 and 64 GB, plus one mlx report at 96 GB (about 75%); the other sizes are inferred [H1 9][S36] | 32/36/48 GB rows may move by one writer | Read at run time; collect caps from other Macs |
| 3 | Community speeds (oMLX, llama.cpp scoreboards) on mixed versions, some on fine-tunes or other conversions (the owner's 8-bit row, the MG26 QAT row); M1 and M6 rows could not be re-read; all Windows speeds derived [H1 5][H3 7][F 6] | Chapter-time promises may be off by 20-40% | Device benchmark replaces estimates; show ranges |
| 4 | Runtime upgrades needed (mlx-swift-lm 3.32.3, node-llama-cpp 3.22.2) [S31][S37] | Guided JSON on MLX and Windows fixes wait on `STACK.md` changes and ranker re-validation | Spike branch; measure with and without guided decoding |
| 5 | MTP/speculative decoding: the 3.32.3 release notes list Qwen3.5 MTP (#351) and Gemma 4 12B MTP (#415), confirmed [S31][F 5]; MTP draft GGUFs exist for GG12 and G27 [S23] | Possible 1.5-2x decode left unused, or an untested feature relied on | Keep out of v1; re-test after the upgrade |
| 6 | 32 GB tier is tight (M35-4 needs about 22.5 GiB resident) [H1 6] | Swap or pressure under real app load | Pick MG26 unless the read budget allows M35-4; swap-growth guard |
| 7 | Embedding space stickiness vs preset switches [H2 6.4] | Hybrid <-> Cloud switch would re-embed the library | Keep local embedding in all presets; provider embedding as an explicit opt-in |
| 8 | Codex OAuth: hard-coded client id; Sign in with ChatGPT says commercial or hosted apps must apply [R14][S5] | The plan route may need registration before public release | Owner decision before release; evaluate the documented open-source / local app flow [S57]; API key path as fallback |
| 9 | gpt-6 missing from `reasoning.ts` [R13][H5 2] | Medium reasoning by default: slower and more output tokens | Small code fix in the F4/F5 AI settings work |
| 10 | Price drift: trackers disagree on gpt-6-luna; Gemini 3.8 Flash doubles on 2027-01-01; Gemini 2.5 Flash-Lite has limited access; gemini-embedding-001 is not on the pricing page [S7][H5 8] | Monthly estimates go stale | Versioned price table; re-read vendor pages at release |
| 11 | Windows blockers: Smart App Control, native crashes, Vulkan Qwen3.5 bug (closed as stale, not fixed), iGPU memory accounting [H3 10][S41] | Local on Windows unusable until fixed | Section 3.3 list before the first Windows test |
| 12 | Licence metadata: Gemma catalog entries say "Gemma" while upstream says Apache-2.0; four conversions have no licence tag (M35-4, M27-6, MG12, MG26q), and M35-4's README is a stub [H1 7.1][S23][F 3] | Wrong acceptance gate or licence record | Read each pinned README before cataloguing |
| 13 | Thinking defaults: Qwen3.5+ think by default; Gemma 4 emits empty thought blocks [H1 7.6] | Latency and JSON noise | Per-family thinking control in the catalog; test in L1 |
| 14 | Disk: the full benchmark set is about 311 GB (169 GB for priority 1 plus the required GGUF files) against 155.2 GiB free [M][F 3] | The benchmark cannot hold all candidates | Staged batches (section 8) |
| 15 | Steam data over-represents gaming PCs; most Windows users probably land in the CPU/iGPU rows [H3 5][H4 9] | Windows Local helps fewer people than the VRAM rows suggest | Hybrid is the safe Windows default; ask the machine class in onboarding if the probe is inconclusive |
| 16 | macOS kernel panics under heavy MLX load at default settings (mlx-lm #883, reproduced on macOS 26.4) [S36] | A system crash during a background writer job | Swap-growth and memory-pressure guard at admission (`blocked: memory`); measure the swap delta in every bake-off run |

---

## 11. Where the reports disagree, and what this document keeps

| Topic | Reports | Kept here | Why |
| --- | --- | --- | --- |
| 16 GB Mac writer | H1: 9B 4-bit local for write-fast; H4: budget 5.0 GiB, only 4B fits | Hybrid default; 4B safe opt-in, 9B tight opt-in | H4 counts the resident pair and host reserve; H1's 6 GiB host figure is an estimate |
| 32 GB Mac | H1: dense Qwen3.8-27B 4-bit; H4: only 9B with margin 1.25 (32B placeholder) | MoE first (MG26, or M35-4 when the budget allows); dense 27B only on >= 300 GB/s | Most 32 GB Macs are base chips at 120-170 GB/s, where the 27B decodes at 6-10 tok/s; MoE rows measure 46-66 tok/s on a 32 GB M6 [C] |
| 48 GB quant | H1: 35B-A3B 6-bit | DWQ (mixed 4/8-bit) default, 6-bit after the footprint is measured | 6-bit needs margin 1.10 to fit a 32.4 GiB budget; DWQ KLD 0.027 is already low [S27] |
| Windows 6-16 GB VRAM | H3: Local default from 6 GB (4B) | Hybrid default, Local one click, promoted when class M passes | Same quality class as 16-24 GB Macs; one rule across platforms |
| Windows 24 GB | H4: stays T3 (32B placeholder misses margin) | Local with Qwen3.8-27B or Gemma 4 26B-A4B | Real 27B footprint about 16.3 GiB x 1.10 = 18.0 GiB fits the 19.7 GiB budget |
| Host reserve | H1: about 6 GiB; H4: 9 GiB | 9 GiB *(cal.)* | Includes D39's 4 GiB headroom; calibrate on the owner's Mac |
| Per-source cloud tokens | H3: about 9k in / 5k out (baseline); H5: 20.3K / 8.7K measured on golden-small | H5 figures for costs, H3 for Windows minutes per source | H5 is measured on the current pipeline; both give cents per month |
| MTP in Swift | H1: open PRs | Do not plan on it for v1; re-test after the upgrade | The 3.32.3 notes list MTP for Qwen3.5 and Gemma 4 12B, confirmed by the fact-check [S31][F 5] |

---

## 12. Sources

Research reports (this folder): [H1] `mac-writers.md`; [H2] `embed-rerank.md`; [H3] `windows.md`; [H4] `detection.md`;
[H5] `cloud.md`; [F] `fact-check.md` (2026-10-18; its sources [W1]-[W40] map onto the S numbers below). Each report
lists its own primary sources; the ones this document relies on directly are repeated below.

Repository (read-only): [R1] `packages/domain/src/ai-presets.ts`; [R2] `packages/ai/src/local-model-catalog.ts`;
[R3] `packages/ai/src/local-adapters.ts` (343-359); [R4] `apps/desktop/src/main/services/local-model-service.ts`
(728-737, 853-856); [R5] `packages/ai/src/remote-execution.ts` (17-34, class mapping); [R6] `docs/plan.md` (decisions
23-25, lines 95-104); [R7] `docs/kpi-f2.md` (105 notes/s; 196-198 local JSON failures); [R8]
`docs/spikes/spike-a-reranker.md`; [R9] `docs/spikes/f3-m0.md`; [R10] `docs/f3-decisions.md` (D35, D36, D39, D40,
D45); [R11] `docs/golden-library.md`, `scripts/golden/compare.ts`, `calls-per-chapter.ts`, `graph-salvage-share.ts`;
[R12] `.cache/golden/runs/2026-10-16T22-31-26-329Z/summary.json`, `.cache/golden/cassettes/golden-small-f2`; [R13]
`packages/ai/src/reasoning.ts`; [R14] `apps/desktop/src/main/services/openai-codex-oauth.ts` (line 4); [R15]
`docs/local-models-and-packaging.md`; [R16] `rules/security-privacy.md` (Remote AI and spending; Licensing); [R17]
`node_modules/node-llama-cpp` 3.19.0 `dist/bindings/utils/detectAvailableComputeLayers.js`.

Web (fetched 2026-10-17/18):
- [S1] OpenAI API pricing: https://developers.openai.com/api/docs/pricing
- [S2] gpt-6-luna model page: https://developers.openai.com/api/docs/models/gpt-6-luna
- [S3] ChatGPT/Codex pricing, credits, Plus quotas: https://learn.chatgpt.com/docs/pricing
- [S4] Codex models and retirements: https://learn.chatgpt.com/docs/models
- [S5] Sign in with ChatGPT: https://learn.chatgpt.com/docs/sign-in-with-chatgpt
- [S6] OpenAI data controls: https://developers.openai.com/api/docs/guides/your-data
- [S7] Gemini API pricing (updated 2026-10-16): https://ai.google.dev/gemini-api/docs/pricing
- [S8] Gemini API terms: https://ai.google.dev/gemini-api/terms
- [S9] Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- [S10] Anthropic OpenAI SDK compatibility: https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk
- [S11] Artificial Analysis, GPT-6 Luna (low) and leaderboard: https://artificialanalysis.ai/models/gpt-6-luna-low , https://artificialanalysis.ai/leaderboards/models
- [S12] AA figures via tosea.ai: https://tosea.ai/blog/gpt-6-sol-luna-complete-guide
- [S13] DeepSeek privacy policy: https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html
- [S14] Mistral Small 4: https://docs.mistral.ai/models/mistral-small-4-0-26-03
- [S15] OpenRouter data collection: https://openrouter.ai/docs/guides/privacy/data-collection
- [S16] MTEB-BR: https://arxiv.org/html/2607.04581v2
- [S17] MTEB(Multilingual, v2) leaderboard API: https://mteb-leaderboard-backend.hf.space/v1/benchmarks/MTEB(Multilingual,%20v2)/scores
- [S18] MTEB(por, v1): https://mteb-leaderboard-backend.hf.space/v1/benchmarks/MTEB(por,%20v1)/scores
- [S19] Qwen3-Embedding-4B: https://huggingface.co/Qwen/Qwen3-Embedding-4B ; Qwen3-Reranker-4B: https://huggingface.co/Qwen/Qwen3-Reranker-4B
- [S20] LAMAR reranking study: https://arxiv.org/html/2607.22042
- [S21] Qwen cards: https://huggingface.co/Qwen/Qwen3.5-4B , https://huggingface.co/Qwen/Qwen3.5-9B , https://huggingface.co/Qwen/Qwen3.5-35B-A3B , https://huggingface.co/Qwen/Qwen3.6-35B-A3B , https://huggingface.co/Qwen/Qwen3.8-27B
- [S22] Gemma 4 cards and licence: https://huggingface.co/google/gemma-4-12B-it , https://huggingface.co/google/gemma-4-31B-it , https://huggingface.co/google/gemma-4-26B-A4B-it , https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html
- [S23] Hugging Face Hub API (sizes, revisions, licence tags; no weights): `https://huggingface.co/api/models/<repo>?blobs=true` for every repository in sections 4 and 8, including the QAT repositories added in this revision (https://huggingface.co/api/models/mlx-community/gemma-4-26B-A4B-it-qat-4bit?blobs=true and its https://huggingface.co/mlx-community/gemma-4-26B-A4B-it-qat-4bit/raw/main/config.json , https://huggingface.co/api/models/google/gemma-4-26B-A4B-it-qat-q4_0-gguf?blobs=true , https://huggingface.co/api/models/google/gemma-4-12B-it-qat-q4_0-gguf?blobs=true), fetched 2026-10-18
- [S24] oMLX community benchmarks: https://omlx.ai/benchmarks ; 4k views re-read by the fact-check: https://omlx.ai/benchmarks?model=Qwen3.6-35B-A3B&context=4096 , https://omlx.ai/benchmarks?model=gemma-4-26b&context=4096&device=["M4","Max"] , https://omlx.ai/benchmarks?model=Qwen3.5-9B&context=4096&device=["M4","Pro"] , https://omlx.ai/benchmarks?model=Qwen3.8-27B&context=4096&device=["M4","Max"] ; M1 16 GB row pages cited by H1: https://omlx.ai/benchmarks/1x2lu1v2 , https://omlx.ai/benchmarks/9hxgxqtk
- [S25] Structured Output Benchmark: https://arxiv.org/html/2604.25359v1
- [S26] Prosa pt-BR benchmark: https://arxiv.org/html/2605.01630v1
- [S27] Quantization KL divergence (M5 Max): https://smcleod.net/2026/04/measuring-model-quantisation-quality-with-kl-divergence/
- [S28] 24 GB M4 Pro cap and kernel panics: https://www.kartit.net/blog/qwen38-27b-24gb-macbook , https://www.kartit.net/blog/gemma4-local-benchmark
- [S29] mlx-lm issue 644 (16 GB cap): https://github.com/ml-explore/mlx-lm/issues/644
- [S30] MLX Metal allocator: https://github.com/ml-explore/mlx/blob/main/mlx/backend/metal/allocator.cpp
- [S31] mlx-swift-lm 3.32.3 release: https://github.com/ml-explore/mlx-swift-lm/releases/tag/3.32.3 ; MLXGuidedGeneration README: https://github.com/ml-explore/mlx-swift-lm/blob/main/Libraries/MLXGuidedGeneration/README.md
- [S32] mlx-swift-lm model registry: https://github.com/ml-explore/mlx-swift-lm/blob/main/Libraries/MLXLLM/LLMModelFactory.swift ; at the pinned and current tags: https://github.com/ml-explore/mlx-swift-lm/blob/3.31.4/Libraries/MLXLLM/LLMModelFactory.swift , https://github.com/ml-explore/mlx-swift-lm/blob/3.32.3/Libraries/MLXLLM/LLMModelFactory.swift
- [S33] Apple chips: https://www.apple.com/newsroom/2024/10/apple-introduces-m4-pro-and-m4-max/ , https://www.apple.com/newsroom/2026/03/apple-debuts-m5-pro-and-m5-max-to-supercharge-the-most-demanding-pro-workflows/ , https://machinelearning.apple.com/research/exploring-llms-mlx-m5 , https://www.apple.com/newsroom/2026/09/the-new-mac-mini-and-mac-studio-are-available-today/
- [S34] llama.cpp Apple Silicon table: https://github.com/ggml-org/llama.cpp/discussions/4167
- [S35] Apple `recommendedMaxWorkingSetSize`: https://developer.apple.com/documentation/metal/mtldevice/recommendedmaxworkingsetsize
- [S36] mlx-lm kernel panic with a raised wired limit: https://github.com/ml-explore/mlx-lm/issues/883
- [S37] node-llama-cpp releases and registry: https://github.com/withcatai/node-llama-cpp/releases , https://registry.npmjs.org/node-llama-cpp , https://registry.npmjs.org/node-llama-cpp/3.22.2
- [S38] node-llama-cpp CUDA and Vulkan guides: https://node-llama-cpp.withcat.ai/guide/CUDA , https://node-llama-cpp.withcat.ai/guide/Vulkan
- [S39] node-llama-cpp issues: https://github.com/withcatai/node-llama-cpp/issues/676 , https://github.com/withcatai/node-llama-cpp/issues/554 , https://github.com/withcatai/node-llama-cpp/issues/653
- [S40] llama.cpp Vulkan and CUDA scoreboards: https://github.com/ggml-org/llama.cpp/discussions/10879 , https://github.com/ggml-org/llama.cpp/discussions/15013
- [S41] llama.cpp Qwen3.5 Vulkan batch-512 report: https://github.com/ggml-org/llama.cpp/issues/27237
- [S42] Smart App Control: https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview
- [S43] Steam Hardware Survey (September 2026): https://store.steampowered.com/hwsurvey/
- [S44] AMD Variable Graphics Memory: https://www.kitguru.net/gaming/joao-silva/amd-unveils-afmf-2-and-variable-graphics-memory-for-ryzen-ai-300-processors/ ; Intel shared memory override: https://hwbusters.com/news/intel-releases-new-arc-graphics-drivers-with-shared-gpu-memory-override-and-stability-improvements/
- [S45] Strix Halo speeds: https://github.com/huppiflupp/strix-halo-llm-speeds
- [S46] Electron APIs: https://www.electronjs.org/docs/latest/api/app , https://www.electronjs.org/docs/latest/api/power-monitor , https://www.electronjs.org/docs/latest/api/process
- [S47] Node `process`, `os`, `fs`: https://nodejs.org/api/process.html , https://nodejs.org/api/os.html , https://nodejs.org/api/fs.html
- [S48] Win32_VideoController and AdapterRAM limits: https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-videocontroller , https://learn.microsoft.com/en-us/troubleshoot/windows-client/setup-upgrade-and-drivers/msinfo32-report-wrong-display-adapter-ram
- [S49] WMIC removal: https://support.microsoft.com/help/5067470
- [S50] systeminformation VRAM chain: https://raw.githubusercontent.com/sebhildebrandt/systeminformation/master/lib/graphics.js
- [S51] DXCore adapter enumeration: https://learn.microsoft.com/en-us/windows/win32/dxcore/dxcore-enum-adapters
- [S52] Rosetta detection: https://developer.apple.com/documentation/apple-silicon/about-the-rosetta-translation-environment
- [S53] nvidia-smi: https://man.archlinux.org/man/nvidia-smi.1.en
- [S54] Windows NPU devices: https://learn.microsoft.com/en-us/windows/ai/npu-devices/
- [S55] Apple support specs for the MacBook Pro M4 Max (32-core GPU 410 GB/s, 40-core 546 GB/s): https://support.apple.com/es-lamr/121553 ; https://everymac.com/systems/apple/macbook_pro/specs/macbook-pro-m4-max-14-core-cpu-32-core-gpu-14-2024-specs.html
- [S56] MLX Swift `mxfp8`: https://github.com/ml-explore/mlx-swift/blob/0.31.6/Source/MLX/Ops.swift ; https://github.com/ml-explore/mlx-swift-lm/blob/3.31.4/Libraries/MLXLMCommon/ModelConversion.swift
- [S57] Sign in with ChatGPT for open-source and local apps: https://developers.openai.com/siwc/token-sharing-open-source
- [S58] Qwen3-Embedding cards (1024-d, MTEB Multilingual 64.33 vs 69.45): https://huggingface.co/Qwen/Qwen3-Embedding-0.6B , https://huggingface.co/Qwen/Qwen3-Embedding-4B
