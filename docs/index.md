# Developer documentation

Normative rules live in `RULES.md`, `STACK.md` and `rules/`. If a document here
conflicts with a rule, follow the rule and fix the document.

## Plan

- [plan.md](plan.md) — the Memora Eterna 2.0 refactoring roadmap: target
  architecture, phases F0-F6 with exit criteria, and the current phase.

## Operational runbooks

- [postgres-sidecar.md](postgres-sidecar.md) — install and validate PostgreSQL,
  pgvector and AGE.
- [docling-sidecar.md](docling-sidecar.md) — build, verify and smoke-test the
  packaged Docling runtime.
- [local-models-and-packaging.md](local-models-and-packaging.md) — local AI
  runtimes, model storage, backups and desktop packaging.
- [matching-benchmark.md](matching-benchmark.md) and
  [matching-calibration.md](matching-calibration.md) — run the DEV matching
  benchmark and pilot. `matching-benchmark-settings.json` and
  `matching-pilot-settings.json` are read by tests; keep them in place.

## F0 measurements

Evidence gathered in phase F0 that the plan's decisions rest on. They are
dated measurements, not rules.

- [kpi-baseline.md](kpi-baseline.md) — the baseline of `npm run kpi` on restored
  library backups; the numbers the refactoring must beat.
- [spikes/spike-a-reranker.md](spikes/spike-a-reranker.md) — a local reranker as
  the relation decider (MLX first).
- [spikes/spike-a2-decisions.md](spikes/spike-a2-decisions.md) — the OpenAI
  Decisions API as an optional remote relation decider, on the same data.
- [spikes/spike-b-topic-tree.md](spikes/spike-b-topic-tree.md) — a deterministic
  topic tree built on real embeddings.
- [golden-library.md](golden-library.md) — the public reference library, DEV-only
  AI cassettes (record/replay) and the golden runner.

## Archive

`archive/` keeps earlier implementation plans, milestone reports, rollout notes
and benchmark/pilot reports unchanged for historical reference. They are not
normative and may describe behavior that the plan replaces. Links inside
archived files may point to rules that no longer exist.
