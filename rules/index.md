# Rule index

Read after `RULES.md` and `STACK.md`, then load only the rows the task touches.

Sections or bullets tagged `(target Fn)` describe behavior that is not built
yet. Do not implement them outside their phase task in `docs/plan.md`, and do
not extend the legacy behavior they replace. Untagged text is true today or
constrains new code.

| Task touches | Read |
| --- | --- |
| Apps/packages, IPC/preload/main/worker boundaries, jobs, repo layout, sidecars, packaging, DEV testing | `rules/architecture.md` |
| Schema, migrations, SQL, PostgreSQL sidecar, pgvector/AGE, projection views, provenance, data wipes | `rules/data.md` |
| AI providers, routing, parameters, local models, scheduler, embeddings, rerankers, prompts, AI audit | `rules/ai.md` |
| Ingestion, conversion, chunks, summaries, notes, relations, graph, topic tree, search, Ask, Gardener | `rules/knowledge.md` |
| Renderer UI, styles, themes, copy, locales, accessibility, visualizations | `rules/frontend.md` |
| Secrets, input, filesystem, network, remote AI, spending, deletion, backups, logs, licensing | `rules/security-privacy.md` |
| Gateway, Chrome extension, YouTube, Obsidian projection and sync, deep links | `rules/integrations.md` |
| Dependency or version change | `STACK.md`, plus the owning rule above |
| Roadmap, current phase, target architecture | `docs/plan.md` |
