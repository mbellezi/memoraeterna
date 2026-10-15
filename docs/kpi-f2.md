# F2 measurements

Dated measurements of F2 (Topic Tree Engine). Decisions: `docs/f2-decisions.md`.

## Gate W: the legacy wiki wipe (2026-10-15)

The owner authorized the complete deletion of the legacy wiki in chat on 2026-10-15 ("Autorizo apagar
totalmente a wiki antiga"). Only the DEV profile (`~/Library/Application Support/@app/desktop`) holds data.

| Step | Result |
| --- | --- |
| A1 preview on DEV | 5,867 legacy rows: 9 pages + 9 revisions, 1 policy revision + 2 activations, 4 maintenance schedules, 4 routine bindings, 2,919 impact events + 2,919 deliveries; 2 legacy settings keys; 0 legacy jobs; 0 wiki vault files. Library: 30 sources, 197 chunks, 160 notes, 387 vectors. Backup taken and verified by restore in 3.1 s (token `df0c300bbaf6`). |
| A2 dress rehearsal on an APFS clone of the profile | wiped through the app path in 37 ms after a verified backup; a preview of the clone then showed 0 legacy rows, 0 legacy keys and an unchanged library (settings 5 → 4: two keys removed, the wipe record added). |
| A3 fault injection on a restored scratch cluster | killed after `counted`, `backed_up` and `verified`: every time the 5,867 rows were intact; the resumed run wiped them (72 other tables unchanged) and a second run did nothing. |
| A4 recoverability | the rehearsal's verified backup restores with the 5,867 legacy rows and the 160 notes. |
| B0 cold copy | `.cache/f2/legacy-wipe/dev-database-pre-wipe-2026-10-15T16-12-26Z` (290 MB, DEV stopped). |
| B1 DEV wipe | `wiped`: 5,867 → 0 legacy rows in 37 ms; total 3.0 s including the verified backup `.cache/f2/legacy-wipe/backups/memora-backup-2026-10-15T16-12-31-413Z`. |
| B2 normal start | 90 s of normal running with the job supervisor: 0 `LEGACY_RECREATED`, 0 errors, legacy tables at 0, library unchanged (30 / 197 / 160). |

Not checked at B2: the Wiki screen's empty state and one Ask question in the running window (covered by
`verify-consultation.ts` on a scratch database and the renderer tests). The verified dump and the cold copy are
kept until the owner asks to remove them; the old wiki can be read by restoring the dump into a scratch cluster.
