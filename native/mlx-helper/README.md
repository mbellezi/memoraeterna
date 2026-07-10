# Memora MLX Helper

Helper nativo macOS arm64 para inferencia offline com modelos MLX gerenciados
pelo desktop. O processo recebe uma mensagem JSONL versionada em `stdin`, emite
progresso/resultados em `stdout` e nunca baixa modelos por conta propria.

Dependencias fixadas:

- `mlx-swift 0.31.6`;
- `mlx-swift-lm 3.31.4`;
- `swift-transformers 1.3.3`.

Build reproduzivel:

```bash
npm run mlx:build
```

O build exige Xcode completo e o componente Metal Toolchain instalado:

```bash
xcodebuild -downloadComponent MetalToolchain
```

O script compila o executavel via SwiftPM, gera os shaders pelo projeto Xcode
oficial do `mlx-swift` e materializa lado a lado:

- `.build/release/memora-mlx-helper`;
- `.build/release/mlx.metallib`.

Para executar uma inferencia real com um modelo ja instalado:

```bash
npm run mlx:smoke
```

O smoke tambem aceita `MEMORA_MLX_MODEL_PATH` ou `--model-path <path>`. O fluxo
de pacote copia o executavel e o `mlx.metallib` para
`resources/sidecars/mlx/darwin-arm64`. Python, `pip` e o sidecar Docling nao
participam deste runtime.
