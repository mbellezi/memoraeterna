# Memora MLX helper

This macOS arm64 native helper runs offline inference with MLX models managed by
the desktop. It receives versioned JSONL requests on stdin, emits progress and
results on stdout (one JSON object per line), writes diagnostics to stderr, and
never downloads models itself. Requests are processed one at a time.

Pinned dependencies:

- MLX Swift `0.31.6`;
- MLX Swift LM `3.31.4` (`MLXLLM`, `MLXVLM`, `MLXEmbedders`, `MLXLMCommon`);
- Swift Transformers `1.3.3`.

Reproducible build:

```bash
npm run mlx:build
```

The build requires full Xcode and the Metal Toolchain component:

```bash
xcodebuild -downloadComponent MetalToolchain
```

The script compiles the executable with SwiftPM, generates shaders through the
official MLX Swift Xcode project, and places these files together:

- `.build/release/memora-mlx-helper`;
- `.build/release/mlx.metallib`.

Run real inference with an already installed model:

```bash
npm run mlx:smoke
```

The smoke also accepts `MEMORA_MLX_MODEL_PATH` or `--model-path <path>`.
Desktop packaging copies the executable and `mlx.metallib` to
`resources/sidecars/mlx/darwin-arm64`. Python, pip, and the Docling sidecar are
not part of this runtime.

## Protocol (version 1)

Every request carries `protocolVersion: 1`, a UUID `requestId` and a `command`.
Every response line echoes the `requestId` (uppercase UUID text) and has
`kind: "progress"` or `kind: "result"`. Fields that do not apply are omitted.

```jsonc
// progress (any command)
{ "protocolVersion": 1, "requestId": "…", "kind": "progress", "progress": 0.1, "messageKey": "localModels.progress.scoring" }
// failure (any command); details go to stderr
{ "protocolVersion": 1, "requestId": "…", "kind": "result", "ok": false,
  "error": { "code": "HelperError", "messageKey": "errors.localModels.runtimeFailed", "recoverable": true } }
```

`health`, `shutdown` and `generate` are unchanged:

```jsonc
{ "protocolVersion": 1, "requestId": "…", "command": "generate", "modelPath": "/abs/model", "prompt": "…",
  "parameters": { "maxTokens": 1024, "temperature": 0.2, "topP": 0.95, "topK": 20, "presencePenalty": 1.5, "enableThinking": false, "seed": 1 } }
→ { …, "kind": "result", "ok": true, "output": "…", "durationMs": 812, "inputTokens": 12, "outputTokens": 3 }
```

### `embed`

```jsonc
{ "protocolVersion": 1, "requestId": "…", "command": "embed", "modelPath": "/abs/Qwen3-Embedding-0.6B",
  "texts": ["…", "…"],
  "normalize": true,     // optional, default true (L2)
  "dimensions": 1024,    // optional prefix truncation (MRL) applied before normalization
  "maxTokens": 8192,     // optional per-text token limit (clamped to the model's position limit)
  "batchSize": 16 }      // optional, 1-512
→ { …, "kind": "result", "ok": true, "durationMs": 717, "inputTokens": 8810,
    "embeddings": [[0.0123, …]], "dimensions": 1024, "normalized": true, "pooling": "last",
    "tokenCounts": [88, …], "truncated": [false, …],
    "timing": { "loadMs": 0, "modelCached": true, "tokenizeMs": 4.1, "inferenceMs": 702.5,
                "perItemMs": 7.0, "totalMs": 716.9,
                "batches": [{ "size": 16, "sequenceLength": 142, "ms": 121.4 }] } }
```

- Loaded with `MLXEmbedders` (`qwen3`, `bert`, `roberta`, `xlm-roberta`,
  `nomic_bert`, `gemma3`, `lfm2`). Texts are tokenized with the tokenizer's
  special tokens (Qwen3-Embedding appends `<|endoftext|>`); truncation keeps
  those special tokens.
- Pooling follows `1_Pooling/config.json` (sentence-transformers) or the
  model's default: last token for Qwen3 (causal attention, right padding), CLS
  as the first token's hidden state, mean and max masked by the attention mask.
- Texts are embedded verbatim. Query instructions (Qwen3-Embedding
  `Instruct: …\nQuery:…`) are the caller's responsibility; documents get none.

### `score`

Qwen3-Reranker relevance, implemented exactly as the model card: the prefix
`<|im_start|>system\nJudge whether the Document meets the requirements based on
the Query and the Instruct provided. Note that the answer can only be "yes" or
"no".<|im_end|>\n<|im_start|>user\n`, the content `<Instruct>: {instruction}\n
<Query>: {query}\n<Document>: {document}` and the suffix `<|im_end|>\n
<|im_start|>assistant\n<think>\n\n</think>\n\n`; score =
`softmax([logit_no, logit_yes])[1]` at the last position.

```jsonc
{ "protocolVersion": 1, "requestId": "…", "command": "score", "modelPath": "/abs/Qwen3-Reranker-0.6B",
  "instruction": "Given a web search query, retrieve relevant passages that answer the query", // optional (this default)
  "query": "…", "documents": ["…", "…"],          // or: "pairs": [{ "query": "…", "document": "…", "instruction": "…"? }]
  "maxTokens": 8192,                              // optional full-sequence limit; the document content is cut at the end
  "batchSize": 16 }                               // optional, 1-512
→ { …, "kind": "result", "ok": true, "durationMs": 61, "inputTokens": 193,
    "scores": [0.99951, 0.0000047], "logOdds": [7.625, -12.277],   // logOdds = logit_yes - logit_no
    "yesTokenId": 9693, "noTokenId": 2152,
    "tokenCounts": [85, 108], "truncated": [false, false],
    "timing": { "loadMs": 0, "modelCached": true, "tokenizeMs": 0.4, "inferenceMs": 59.8,
                "perItemMs": 29.9, "totalMs": 60.6,
                "batches": [{ "size": 2, "sequenceLength": 108, "ms": 59.8 }] } }
```

- The model must load as `MLXLLM` `Qwen3Model` (`Qwen3ForCausalLM`). The
  tokenizer must map `yes`/`no` to 9693/2152 and parse `<|im_start|>`/
  `<|im_end|>` as single tokens; otherwise the request fails.
- Batches are formed longest-first, left-padded and run in one forward pass
  with a causal mask restricted to real tokens. Each row's RoPE positions start
  at 0, so a padded row sees the same positions as an unpadded single pass.
- Scores are computed in the weights' dtype (bf16 for the official Qwen
  weights). Batch shape changes bf16 kernel numerics: `logOdds` can move by up
  to ~0.25 (score by ~0.05) between batch sizes for the same pair.

### Model caching

The helper keeps at most one model per command kind loaded (`generate`,
`embed`, `score`) and reuses it while requests name the same `modelPath`.
A different `modelPath` replaces that kind's model. A failed `generate` drops
the generation model; failed `embed`/`score` requests keep loaded models.
