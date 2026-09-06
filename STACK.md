# Memora Eterna stack and dependency specification

This file is always read before implementation. It records the technologies and
versions that new work must use. Manifests and lockfiles are the executable
record; when an approved version changes, update this file in the same change.

## Dependency policy

- Use npm workspaces and exact versions for direct dependencies.
- Use Node.js `24.18.0` and npm `11.16.0`; supported engines are Node
  `>=24.18.0 <25` and npm `>=11.16.0 <12`.
- Prefer the existing dependency that owns a capability. Do not introduce a
  competing framework, runtime, ORM, validator, icon set, or package manager
  without an explicit durable decision.
- Compatibility takes precedence over a newer published version. Native runtime
  upgrades require build, packaging, and smoke validation.
- PostgreSQL major upgrades require an explicit data migration strategy.
- Python is allowed only inside the packaged Docling sidecar. Application and
  domain logic remains TypeScript; MLX inference uses the Swift helper.

## Runtime and tooling

| Component | Required version | Use |
| --- | --- | --- |
| Node.js | `24.18.0` | Repository runtime and Electron-aligned baseline |
| npm | `11.16.0` | Package manager |
| `typescript` | `6.0.3` | Type checking and package builds |
| `@types/node` | `24.13.2` | Node type baseline |
| `tsx` | `4.23.0` | Scripts requiring full TypeScript execution |
| `vitest` | `4.1.9` | Unit and integration tests |
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
| Icons | `lucide-react` `1.23.0` |
| Interactive graph rendering | `sigma` `3.0.3` with `graphology` `0.26.0` |
| Graph communities and layout | `graphology-communities-louvain` `2.0.2`; `graphology-layout-forceatlas2` `0.10.1` |
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
| `node-llama-cpp` | `3.19.0` | Main process or controlled workers only |
| MLX Swift | `0.31.6` | Packaged macOS arm64 helper |
| MLX Swift LM | `3.31.4` | Packaged macOS arm64 helper |
| Swift Transformers | `1.3.3` | Packaged macOS arm64 helper |

Local model artifacts use immutable revisions, declared files, sizes, licenses,
and SHA-256 checksums. A capability is exposed only after the actual adapter and
runtime have been validated for it.
