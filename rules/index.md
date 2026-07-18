# Rule index and task router

Read this index for every task after `RULES.md` and `STACK.md`. Then read only
the rows that match the request. A task may require more than one row; follow
transitive references explicitly named inside a selected rule.

| Request or affected area | Required rule |
| --- | --- |
| New app/package, dependency direction, IPC/preload/main boundary, service ownership, or broad refactor | `rules/architecture.md` |
| Finding ownership, choosing files, moving folders, adding scripts, or changing repository structure | `rules/repository-map.md` |
| Source types, descriptors, metadata, bibliography, import wizard, duplicates, containers, hierarchy, document revisions, or processing plans | `rules/source-ingestion.md` |
| File/web conversion, Markdown normalization, structure detection, Docling protocol, OCR, chunks, SourceSpans, or assets | `rules/conversion.md` |
| Jobs, processing batches, ingestion runs/stages, worker supervisor, retries, cancellation, checkpoints, or recovery | `rules/jobs-and-processing.md` |
| Drizzle schema, migrations, repositories, SQL, PostgreSQL lifecycle, pgvector storage, or AGE persistence | `rules/database.md` |
| AI providers, profiles, model parameters, local models, summaries, atomic notes, knowledge graph, matching, embeddings, or search ranking | `rules/ai-and-knowledge.md` |
| Renderer components, product copy, styles, accessibility, themes, locales, or user-visible backend messages | `rules/frontend-and-i18n.md` |
| Integration Gateway, Chrome extension, YouTube capture, Obsidian plugin, vault projection, pairing, or sync | `rules/integrations.md` |
| Secrets, external input, filesystem access, network access, remote AI, deletion, backups, logs, or privacy-sensitive behavior | `rules/security-and-privacy.md` |
| PostgreSQL/Docling/MLX sidecars, native artifacts, runtime downloads, desktop packaging, signing, notarization, or distribution | `rules/runtime-and-packaging.md` |

## Routing examples

- A new import UI reads `source-ingestion.md` and `frontend-and-i18n.md`; add
  `conversion.md` only if conversion behavior changes.
- A schema change for AI profiles reads `database.md` and
  `ai-and-knowledge.md`.
- An Obsidian deletion fix reads `integrations.md` and
  `security-and-privacy.md`; add `database.md` if persistence changes.
- A dependency upgrade always reads `STACK.md`; add the owning domain rule and
  `runtime-and-packaging.md` for native or packaged dependencies.

Operational commands and developer setup live in `README.md` and `docs/`. Those
files are not normative. If operational documentation conflicts with a rule,
fix the documentation and follow the rule.
