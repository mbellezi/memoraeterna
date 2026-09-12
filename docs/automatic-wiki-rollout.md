# Automatic wiki: controlled setup and rollout

This runbook describes the implemented local workflow. Product acceptance and
remaining release gates are recorded in [the A8 report](automatic-wiki-a8-report.md).
The unpacked macOS artifact is a development validation output; staging alone
establishes neither native startup nor signed/notarized distribution readiness.

## Preserve the current library

Use the existing backup action before an application/database upgrade. Keep its
database dump and selected managed folders together, and verify restoration into
an isolated location before relying on it. A restore test compares row counts and
canonical data, not merely the dump's existence. Never reset the library to enable
the wiki or resolve an upgrade failure.

The current baseline contains 42 migrations. Existing libraries run only pending
forward migrations; empty installations use the baseline and record that history.
Old policies, prompt pins, organization/maintenance runs, review decisions,
receipts, originals and human revisions remain versioned. Existing optional notes,
summaries, vectors, relationships and graph output are preserved. Installing an
update does not activate automatic work or regenerate missing derivatives.

## Offer a scoped first run

1. Open the Wiki's automatic organization setup. Choose the intended existing
   source scope or deliberately include the whole library and future inputs.
   Inspect exclusions, the routed/overridden model, content language and permitted
   changes. A missing model leaves setup/read-only material available and blocks
   inference; it does not silently choose a different model.
2. Review the four installed routines, timezone, due/start windows and shared
   parent allowance. Interpretation, reviewed note evolution and followed-question
   refresh are explicit grants. Existing legacy schedules require the disclosed
   reconciliation; updating or resuming a policy preserves custom schedules.
3. Activate the reviewed preview. Activation installs the routines and makes their
   scheduling eligible while the desktop is open. It is distinct from the explicit
   initial integration/bootstrap action and from importing content.
4. Start the scoped first integration. Originals-only needs no notes, summaries,
   vectors or AGE. Selecting existing notes includes their complete original
   lineage without regenerating them. Import-only remains free of AI execution;
   selected integration remains visible in the effective processing plan.
5. Read the topic and its reading index. Inspect exact originals and independent
   source attribution, uncertainty, freshness and machine/human review status.
   Correct only the intended section or make an explicit placement/order change.
   Protected text and historical evidence remain independently preserved.
6. Add later material within the grant. Inspect the targeted update and any
   incomplete coverage, exhausted allowance, missing evidence or review decision.
   A failed dependent is not a completed library sweep. Unchanged inputs do not
   require another inference or a routine notification.

Default occurrence allowances are 8/16/32/48 calls and
128,000/256,000/512,000/768,000 reserved tokens for incremental/daily/weekly/monthly
work. Every child shares a parent UTC-month ceiling of 128 calls and 2,000,000
reserved tokens. Reservations are conservative input planning, separate from
reported model tokens. Unavailable monetary pricing stays unknown. Lower model,
policy or provider bounds apply; the new remote default of 128,000 context tokens
is an app planning budget, not a uniform endpoint-capacity guarantee.

## Reading and persistent questions

Use the expandable tree, reading links, Sources/Notes/Connections, exact evidence
and revision history. Source navigation and Back preserve the reading context.
An original source title retains its language when interface language changes.

Ask and Compare are transient. Save deliberately creates a retained review
proposal; Follow separately retains an investigation under the selected policy.
Read current/prior answers, explicit gaps and changed understanding. A followed
answer cannot silently broaden its source scope. Pausing/resolving stops new
refresh authority and preserves prior answers and any uncertain failed call.

Temporal statements retain supplied date precision and missing dates. Personal
preference or fatigue is not experimental retention evidence. Reviewed note
merge/split/cross-source operations disclose the complete repair footprint;
prior notes, original excerpts, ownership and redirects survive source deletion.

## Migrate an existing Obsidian mirror separately

Configuring/enabling sync does not authorize moving registered paths. Interface
language is separate from projection language. New empty projections use explicit
layout 2; existing paths and formats remain until a reviewed migration.

Open Connections and request the Obsidian layout preview. Review the exact old/new
paths, source taxonomy, originals versus generated regions, attachment choice,
collisions, exclusions and base/local/proposed bytes. Use the compatible plugin
and its separate layout capability, or explicitly confirm all managed editors are
closed for a no-plugin filesystem migration. Incompatible connected clients,
open/pending editors and stale presence must be resolved before affected writes.

Apply the reviewed migration, then resume any bounded remaining targets. Each
action processes at most 100 targets. Check the durable journal and actual editor
links, including shared notes, original sources and any copied attachment. Offline
edits retain their exact bases and replay through editorial conflict handling.
A generated wrapper or TOC is never an original-source edit.

Rollback is explicit and guarded by current file bytes. A later human edit remains
pending for review while independent files restore; a partial rollback is not a
fully restored vault. Keep the journal, recovery copies and original backup.

## Development verification and release

Run the full tests/typecheck/build, seed verification, A8 combined verifier and
predecessor PostgreSQL matrix listed in the A8 report. Local package checks are:

```bash
npm run package:desktop:dir
node scripts/verify-desktop-artifacts.mjs
```

The artifact verifier checks archive/preload/plugin initialization and every
manifested native resource hash without launching an app. It does not load a model
or use a vault. Under the repository DEV-only rule, manual testing uses
`npm run dev -w @app/desktop` with isolated `MEMORA_USER_DATA_DIR`,
`MEMORA_DEV_BACKGROUND=1`, at most 1600×1200 and a 960×640 minimum.

Only after explicit package/release validation authorization, with DEV stopped:

```bash
npm run package:desktop:smoke
```

That existing smoke creates a fresh temporary persistent userData directory,
opens/quits the package twice, verifies database startup/migration/readiness and
clean shutdown, and removes its fixture. It must not be substituted by another
installed app, an existing library, or a hidden second Electron instance. Actual
editor/native/model gates and platform signing/notarization remain separate.
