# Memora Eterna stack and dependency specification

Always read before implementation. The tables are executable policy: new work
uses these exact versions. Manifests and lockfiles are the record; when an
approved version changes, update this file in the same change.

## Dependency policy

- npm workspaces with exact versions for direct dependencies. Node.js `24.18.0`
  and npm `11.16.0` (engines: Node `>=24.18.0 <25`, npm `>=11.16.0 <12`).
- Prefer the dependency that already owns a capability. A competing framework,
  runtime, ORM, validator, icon set or package manager needs an explicit decision
  recorded here.
- Compatibility beats novelty. Native runtime upgrades need build, packaging and
  smoke validation; PostgreSQL major upgrades need a data migration strategy.
- Python only inside the packaged Docling sidecar; MLX inference uses the Swift
  helper; all application and domain logic is TypeScript.
- Check licenses before adding a dependency or model artifact
  (`rules/security-privacy.md`).

## Runtime and tooling

| Component | Required version | Use |
| --- | --- | --- |
| Node.js | `24.18.0` | Repository runtime and Electron-aligned baseline |
| npm | `11.16.0` | Package manager |
| `typescript` | `6.0.3` | Type checking and package builds |
| `@types/node` | `24.13.2` | Node type baseline |
| `tsx` | `4.23.0` | Scripts requiring full TypeScript execution |
| `vitest` | `4.1.9` | Unit and integration tests |
| `prettier` | `3.9.9` | Code formatting (`npm run format`) |
| `eslint` / `@eslint/js` | `10.11.0` / `10.0.1` | Linting with bulk suppressions (`npm run lint`) |
| `typescript-eslint` | `8.71.0` | TypeScript lint rules; supports TypeScript `>=4.8.4 <6.1.0` |
| `eslint-plugin-react-hooks` | `7.1.1` | Hooks rules for renderer code |
| `globals` | `17.12.0` | Environment globals for the ESLint config |
| CPython | `3.13.13` | Isolated Docling sidecar only |

Directly executed `.ts` files must stay within Node's erasable TypeScript syntax
unless they run through `tsx`. Use explicit type imports and file extensions;
avoid enums, decorators, parameter properties, TSX, and tsconfig path aliases in
files executed directly by Node.

## Desktop and user interface

| Component | Required version or choice |
| --- | --- |
| Electron | `43.0.0` |
| `electron-vite` | `5.0.0` |
| Vite | `7.3.6` |
| `@vitejs/plugin-react` | `5.2.0` |
| `@swc/core` | `1.15.43` |
| `react` / `react-dom` | `19.2.7` |
| `@types/react` / `@types/react-dom` | `19.2.17` / `19.2.3` |
| Tailwind CSS / `@tailwindcss/vite` | `4.3.2` |
| shadcn/ui | Vendored components; CLI baseline `4.13.0` |
| Icons | `lucide-react` `1.23.0` for interface icons; object-kind and relation-stance glyphs are first-party inline SVG (`apps/desktop/src/renderer/components/glyphs.tsx`) |
| Fonts (OFL-1.1, bundled offline) | `@fontsource-variable/inter` `5.3.0` (interface) and `@fontsource-variable/source-serif-4` `5.3.0` (reading), imported through `wght.css` only |
| Interactive graph rendering | `sigma` `3.0.3` with `graphology` `0.26.0` |
| Graph communities and layout | `graphology-communities-louvain` `2.0.2`; `d3-force` `3.0.0` in a renderer Web Worker; `@types/d3-force` `3.0.10` |
| Desktop packaging | `electron-builder` `26.15.3` |

The product is an Electron desktop application. Do not introduce Next.js or a
separate web application unless explicitly requested and specified.

## Contracts, storage, and graph

| Component | Required version or choice |
| --- | --- |
| `zod` | `4.4.3` |
| PostgreSQL sidecar | `18.4` |
| `pg` / `@types/pg` | `8.22.0` / `8.20.0` |
| `drizzle-orm` / `drizzle-kit` | `0.45.2` / `0.31.10` |
| pgvector | `0.8.4` |
| Apache AGE | `PG18/v1.7.0-rc0` |

Use Drizzle over `node-postgres`. Relational tables remain canonical; pgvector
and AGE are query and projection layers.

## Conversion and integrations

| Capability | Required implementation |
| --- | --- |
| Web article extraction | `defuddle` `0.19.1` |
| Complex documents and OCR | Docling `2.111.0` in the CPython sidecar |
| PDF outline and page labels | `pdfjs-dist` `6.1.200` |
| Textual formats | Native TypeScript converters in `@app/conversion` |
| ZIP handling | `fflate` `0.8.3` with bounded extraction |
| XML/HTML parsing | `linkedom` `0.18.13` where already used |
| YouTube metadata/transcripts | `youtubei.js` `17.2.0` |
| Gateway events | `ws` `8.21.0` |
| Gateway WebSocket types | `@types/ws` `8.18.1` |
| Chrome extension types | `@types/chrome` `0.2.2` |
| Obsidian plugin API | `obsidian` `1.13.1` |

## Local AI runtimes

| Runtime | Required version | Boundary |
| --- | --- | --- |
| `node-llama-cpp` | `3.19.0` | GGUF fallback; main process or controlled workers only |
| MLX Swift | `0.31.6` | Packaged macOS arm64 helper |
| MLX Swift LM | `3.31.4` | Packaged macOS arm64 helper (MLXLLM, MLXEmbedders) |
| Swift Transformers | `1.3.3` | Packaged macOS arm64 helper |

Local models are MLX-first; GGUF through `node-llama-cpp` is the fallback
(`rules/ai.md`). Local model artifacts use immutable revisions, declared files,
sizes, licenses, and SHA-256 checksums. A capability is exposed only after the
actual adapter and runtime have been validated for it.

## Planned additions (pending their phase)

Add exact versions here when the owning phase adopts them (see `docs/plan.md`).

- `d3-hierarchy` for the Shape icicle and mind maps (F2).
- MLX weights for Qwen3-Reranker-0.6B and Qwen3-Embedding-0.6B (Apache-2.0;
  Qwen safetensors or mlx-community conversions), pinned revision plus SHA-256,
  run on MLXLLM/MLXEmbedders (F0 spike, F2 adapter).
- Fallback reranker GGUF artifacts: Qwen3-Reranker-0.6B Q8_0 (ggml-org) and
  bge-reranker-v2-m3 Q8_0 (gpustack), pinned by SHA-256 (F0 spike, F2 adapter).
- `radix-ui` and `cmdk` through vendored shadcn components (F5).
- `@playwright/test` for Electron journeys (F5).
- `umap-js` and `@sigma/layer-webgl` `3.0.0` for the Atlas, only after its spike
  (F6). Stay on `sigma` `3.0.3` until a sigma 4 spike decides otherwise.
- Remote deciders (OpenAI Decisions) as fetch adapters with no new dependency.

Avoid `@cosmograph/*` while it is licensed CC-BY-NC-4.0; use `@cosmos.gl/graph`
(MIT) instead if a GPU force layout is ever needed.
