# Memora MLX helper

This macOS arm64 native helper runs offline inference with MLX models managed by
the desktop. It receives a versioned JSONL request on stdin, emits progress and
results on stdout, and never downloads models itself.

Pinned dependencies:

- MLX Swift `0.31.6`;
- MLX Swift LM `3.31.4`;
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
