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

## Archive

`archive/` keeps earlier implementation plans, milestone reports, rollout notes
and benchmark/pilot reports unchanged for historical reference. They are not
normative and may describe behavior that the plan replaces. Links inside
archived files may point to rules that no longer exist.
