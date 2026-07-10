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
swift build -c release --package-path native/mlx-helper
```

O binario resultante deve ser copiado para
`resources/sidecars/mlx/darwin-arm64/memora-mlx-helper` pelo fluxo de pacote do
desktop. Python, `pip` e o sidecar Docling nao participam deste runtime.
