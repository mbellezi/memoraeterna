# Developer documentation

This directory contains operational runbooks and explicitly labeled design plans.

## Operational runbooks

- `docling-sidecar.md` — build, verify, and smoke-test the packaged Docling
  runtime.
- `postgres-sidecar.md` — install and validate PostgreSQL, pgvector, and AGE.
- `local-models-and-packaging.md` — local AI runtimes, model storage, backups,
  and desktop packaging.

## Design and implementation plans

- [Automatic knowledge wiki implementation plan](automatic-wiki-implementation-plan.md)
  — forward plan for AI-managed pages and TOCs, native hierarchical navigation,
  incremental integration, automatic maintenance setup and deadlines, long-term
  knowledge, source-type folders and safe Obsidian layout migration.
- [Application-wide AI prompt catalog](ai-prompt-catalog-plan.md) — companion
  design for hierarchical Prompts settings, editable runtime templates,
  `%variable_name%` fields, variable descriptions, inheritance and migration.
- [AI harness direction](ai-harness-direction.md) — existing model adapter
  boundary and evaluation direction for future wiki orchestration.
- [Hybrid second-brain implementation plan](second-brain-implementation-plan.md)
  — historical M1–M5 implementation/acceptance baseline for the wiki, restricted
  harness, consultation, maintenance and Obsidian synchronization. Future work
  follows the automatic knowledge wiki plan above; the original M6 is deferred.

Normative engineering specifications live in `RULES.md`, `STACK.md`, and
`rules/`. Earlier completed implementation plans and the historical ADR were removed;
their durable decisions are represented by the routed domain rules.
