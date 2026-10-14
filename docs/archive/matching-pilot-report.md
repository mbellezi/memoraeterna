# DEV matching pilot — 8 September 2026

The pilot completed two matching rounds on 12 synthetic roots (four books with
two chapters each): 20 source records, 16 content documents and 44 atomic notes.
Both rounds recovered all five labelled expected root pairs. The revised prompts
removed the observed false connection between an exhibition named “Memória” and
retrieval practice. The results support provisional settings, not a universal
optimum or measured semantic precision/recall.

## Environment and reproducibility

- Unpackaged DEV desktop; DEV sidecar database `memora_app`, using its generated
  development connection descriptor. The initial library was confirmed empty.
- Existing profiles preserved: `Luna` / `openai-codex` / `gpt-5.6-luna`, low
  reasoning; local `Qwen/Qwen3-Embedding-0.6B-GGUF`, 1024 dimensions.
- Corpus and labels: `scripts/fixtures/matching-pilot.json`. Only ordinary source
  content was ingested; assessment labels and expected ideas never entered prompts.
- Full run instructions: `docs/matching-calibration.md`. Local, ignored artifacts
  are under `.cache/matching-pilot/`, including baseline/current results,
  diagnostics, routes, settings, analysis and the database backup.
- Baseline batch: `37430abb-a630-47ab-a385-3f970b2cc06f`.
  Corrected batch: `c7c3e586-e184-41ec-a6c8-fc30cf315475`.

## Observed outcomes

| Measure | Baseline | Corrected matching |
| --- | ---: | ---: |
| Source records / atomic notes | 20 / 44 | 20 / 44 |
| Note relationships | 29 | 35 |
| Source relationships | 19 | 19 |
| Expected root pairs recovered | 5 / 5 | 5 / 5 |
| Source relationships within expected pairs | 12 | 9 |
| Reported input + output tokens | 398,914 | 233,450 |
| Remote note reranking calls, successful | 48 | 44 |
| Remote source matching calls, successful | 73 | 70 |

The four-catalog regression check added 2,572 local embedding input tokens.
Total reported usage was **634,936 tokens**, approximately 35.3% of the authorized
1,800,000-token pilot allowance. Two interrupted baseline calls have unavailable
usage, so this is the known reported total, not a guaranteed billing total.
Reasoning tokens are reported separately by telemetry and were not added again
on top of output tokens. Remote monetary cost was unavailable; no price was
inferred. Local embedding input is included in the token totals.

The corrected round reused extracted content, notes and summaries, with warm
embeddings. It revised note prompt v4 → v5 and source prompt v3 → v4. It also
temporarily lacked catalog graph evidence because of the reprocessing defect
described below. These differences prevent causal attribution of relation-count
changes to the prompts alone. Numeric matching settings were held constant for
both rounds.

## Quality assessment

The five expected pairs span retrieval practice with feedback, its conditional
limitations, cache expiry/invalidation, and drying/firing ceramic defects. All
were represented at the root level in both runs. This screening result does not
assert that every expected proposition or relationship type was recovered.

The revised pass produced no cross-source relation involving the exhibition
named “Memória”; the baseline had incorrectly interpreted the proper name as an
abstract definition and linked it to learning. The index-only source generated
zero atomic notes. No same-root source relationship was persisted. Both botanical
chapters reused the same Ana Costa identity; the astronomer with the same name
remained separate. Some conceptual identity fragmentation remains, including
separate “Evocação” / “Recuperação ativa” representations despite alias reuse.

The remaining source relationships include cross-domain methodological bridges.
Eight are outside the labelled pair sets; two connect botany and astronomy, a
pair originally labelled forbidden. Those two explanations compare experimental
control/randomization with detector calibration, independently of the shared
person/project names. The original label is preserved, but this is an ambiguous
negative requiring adjudication, not proof that the two identities were merged.
Other abstract bridges may be defensible yet low in personal usefulness. Neither
unlabelled relationships nor model confidence scores establish correctness.

The 35 note relationships include direct paraphrases, mechanisms and conditions,
as well as several broader `supports` relationships. Increasing density is not
itself an improvement. A larger labelled corpus should assess direction, type,
redundancy, useful contrasts and missed relations at the proposition level.

## Initial settings

**Saved in DEV after the runs:** source minimum importance **0.80**, previously
0.75. Existing 19 source relationships are retained as pilot evidence; this
setting applies to subsequent processing and does not retroactively prune them.
The run snapshots retain the actual 0.75 setting used during generation;
`settings-calibrated.json` records the subsequent setting.

| Source importance replay | Baseline relations / expected pairs | Corrected relations / expected pairs |
| --- | ---: | ---: |
| 0.75 | 19 / 5 | 19 / 5 |
| 0.80 | 14 / 5 | 13 / 5 |
| 0.85 | 7 / 5 | 9 / 5 |
| 0.90 | 4 / 4 | 3 / 3 |

At 0.80 all nine corrected relationships within expected pairs survive, while six
lower-importance bridges are excluded. The baseline loses one specific relation
within an expected pair while preserving pair coverage. The 0.85 setting removes
additional expected-pair details; 0.90 loses expected pairs. Thus 0.80 is a
conservative starting point, not an optimized universal threshold.

Other initial controls remain:

- Note final score **0.60**, required AI verification, minimum AI score **0.65**,
  generic `mentions` / `related` disabled; at most ten newly generated relations
  per note per execution. The corrected recorded-candidate replay yields 54 unique
  passing pairs at 0.55, 35 at 0.60, 16 at 0.65 and six at 0.70. Lowering the score
  can admit weak matches; raising it sharply removes substantive matches.
- Note retrieval: text/vector/graph limits **30 / 30 / 20**, fused limit **30**,
  graph-only reserve **5**, reciprocal-rank constant **60**, original normalized
  signal weights and AI weight **0.40**, output limit **4,096**.
- Entity/type identity similarity **0.92 / 0.92**, candidate limits **3 / 3**,
  confirmation batches **12**, target context **12,000 characters**. No evidence
  from this small corpus justifies lowering identity safeguards.
- Source matching: minimum confidence **0.80**, candidates **40**, pairs **8**,
  generated/ranked relations **10**, relations per pair **4**, reported input
  budget **60,000** per root/execution. Advanced context defaults: three passages
  per root, 1,000 characters per passage, 1,200 summary characters, six note
  relations per pair, 4,096 output tokens and reciprocal-rank constant 60.

These replays only filter observed decisions; they do not evaluate new retrieval
candidates or simulate execution order. Some roots reached the eight-pair cap
and correctly reported partial coverage. The 1.8-million allowance is separate
from those per-root limits. Twelve roots cannot validate a 40-source retrieval
cap or reveal scaling behavior for a large library.

## Implemented safeguards and verification

Advanced matching controls are persisted and exposed in all five UI languages,
with validation, grouped resets, explicit slider labels and explanations of
budget scope. AI rejection now blocks note persistence independently of the
other weighted signals. Saved note pairs are excluded before reranking, and
generation caps use final ranking. Source evidence is deduplicated and bounded
per root, including note-derived passages.

The actual pilot exposed two orchestration defects:

1. Retrying while a queue drain was active could start an overlapping drain.
   Wakeups are now coalesced until the active drain finishes.
2. Re-embedding a catalog recreated an identical chunk and cascaded deletion of
   graph evidence. Unchanged catalog chunks now retain their IDs. The four
   affected catalogs were recovered from the baseline backup after exact
   content/hash checks: 26 mentions, 31 claims, 62 claim/entity links and 28 entity
   relations. The AGE projection was refreshed. A normal embedding-only batch
   then verified that all four chunk IDs and every restored graph record ID
   remained unchanged. The final snapshot again contains 182 represented entities.

Validation includes the full automated suite, TypeScript checks, formatting,
workspace production build, real isolated PostgreSQL verification of candidate
limits/evidence caps/saved-pair queries, and DEV UI inspection. No schema migration,
new dependency, packaged production change or commit was made. Domain rules for
matching, graph identity, source relations, ingestion, jobs and localized UI were
updated with the implementation.

The pilot is complete. A subsequent calibration corpus should expand to roughly
60 roots, include unseen evaluation examples and stronger negative pairs, and
measure proposition-level usefulness and token cost from consistent snapshots.
That larger calibration was not executed in this pilot.
