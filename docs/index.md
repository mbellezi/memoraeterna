# Developer documentation

This directory contains operational runbooks and explicitly labeled design plans.

## Operational runbooks

- `docling-sidecar.md` — build, verify, and smoke-test the packaged Docling
  runtime.
- `postgres-sidecar.md` — install and validate PostgreSQL, pgvector, and AGE.
- `local-models-and-packaging.md` — local AI runtimes, model storage, backups,
  and desktop packaging.

## Design and implementation plans

- [AI harness direction](ai-harness-direction.md) — existing model adapter
  boundary and evaluation direction for future wiki orchestration.
- [Hybrid second-brain implementation plan](second-brain-implementation-plan.md)
  — optional atomic notes, evidence-backed wiki organization, consultation and
  visual design, bounded harness, editable function/domain instructions,
  weekly/monthly maintenance, Obsidian projection and staged reverse sync.

Normative engineering specifications live in `RULES.md`, `STACK.md`, and
`rules/`. Earlier completed implementation plans and the historical ADR were removed;
their durable decisions are represented by the routed domain rules.
