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
- [spikes/f1a-matching-latency.md](spikes/f1a-matching-latency.md) — where note-matching time goes on
  the golden library and the ranked fixes behind decision 16.
- [spikes/source-relations-plan.md](spikes/source-relations-plan.md) — source matching cost, what the
  source layer adds to quality, and the options behind decision 17.
- [kpi-golden.md](kpi-golden.md) — the golden library baseline: pipeline time, AI calls, first v6
  matching measurement and replay determinism.
- [kpi-f1a.md](kpi-f1a.md) — F1a measurements: matching fixture on pinned notes, why the note layer reads
  22-24/28, and the evidence for the other F1a exit criteria.
- [kpi-f1b.md](kpi-f1b.md) — F1b measurements: decide-only matching v9 on the golden library and the
  fixture, locate and Note page latency.
- [f2-decisions.md](f2-decisions.md) — the binding F2 decisions (D1-D36), owner-question defaults, gates and
  measurement datasets for the Topic Tree Engine.
- [golden-library.md](golden-library.md) — the public reference library, DEV-only
  AI cassettes (record/replay) and the golden runner.

## Archive

`archive/` keeps earlier implementation plans, milestone reports, rollout notes
and benchmark/pilot reports unchanged for historical reference. They are not
normative and may describe behavior that the plan replaces. Links inside
archived files may point to rules that no longer exist.
