# Memora Eterna engineering rules

This is the small contract that applies to every repository task. Read it with
`STACK.md` and `rules/index.md`, then load only the domain rules the task needs.

## 1. What rules are for

- Rules hold only durable invariants: product guarantees, boundaries, data
  integrity, security, privacy and workflow. They are acceptance criteria, not
  background reading.
- Numbers, thresholds, limits and defaults live in typed configuration with
  tests, not in rules.
- When a change alters an invariant, update its rule in the same change. Never
  leave code and rules knowingly inconsistent.
- Delete a superseded rule instead of adding an exception elsewhere. Do not turn
  plans, implementation diaries, incident notes or versioned compatibility
  contracts into rules.
- `docs/plan.md` describes the target architecture, the roadmap and the current
  phase. Rules describe what must stay true while it is built.
- Project documentation and rules are written in English.

## 2. Product invariants

- The product is a local-first Electron desktop application, TypeScript-first.
- PostgreSQL is the canonical store. Files, vault paths, search indexes,
  embeddings, AGE graphs, layouts and read-only projection views are derived and
  never define identity.
- Stable IDs and source evidence survive derivation, synchronization and
  reprocessing. Derived knowledge keeps its provenance to exact sources and
  spans.
- Automation on AI-managed content is automatic but reversible: every automatic
  change is recorded in a change-set that can be undone for its retention window.
- Human-created, human-edited, pinned or protected content is never changed by
  automation without explicit approval.
- Validate data with Zod whenever it crosses a process, worker, integration or
  sidecar boundary.
- Privileged work (database, filesystem, secrets, native runtimes, network
  adapters) stays out of the renderer and external clients.
- Never expose or log secrets.
- Every AI call records the effective model, parameters, token usage and cost
  when known. Unknown values stay unknown; never invent them.

## 3. Engineering workflow

- Inspect the relevant code and tests before changing them. Ground claims in
  files and actual tool output; label inferences.
- Make the smallest complete change for the request. Do not refactor unrelated
  code or add speculative features. Preserve other people's and agents' work.
- Add or update tests for every changed behavior.
- UI changes cover loading, empty, error and success states.
- Ask before irreversible, externally visible, expensive or destructive actions
  that the task did not authorize.
- Verify economically: per change, `npm run check:changed` (incremental
  typecheck, related tests, format and lint of the changed files) plus any
  domain-rule check; the full `npm run check` and e2e suites only close a stage
  (wave merge, gate, phase exit) or follow cross-cutting changes.
- Start DEV only with `npm run dev -w @app/desktop` from the repository root,
  with `MEMORA_USER_DATA_DIR` set to a scratch or cloned profile.

## 4. Agent model tiers

Use the cheapest adequate model for each task and always set the model
explicitly when spawning an agent. When unsure, use Sonnet.

| Tier | Model | Use for |
| --- | --- | --- |
| Mechanical | Haiku 5.5 | File moves, formatting, renames, running checks, simple searches and reports |
| Standard | Sonnet 5.5 | Implementation with a clear spec: features, tests, UI components, migrations, scripts |
| Hard | Opus 5.5 | Architecture and design, hard algorithms, concurrency, cross-cutting refactors, rule writing, adversarial review |

## 5. Multi-agent work

- One orchestrator owns the task, the plan and integration of results.
- Parallel agents work only on disjoint file sets or in separate git
  worktrees. Shared files (lockfiles, migrations, central registries, global
  configuration) have exactly one owner at a time.
- Each agent reads only the rules its task needs, through `rules/index.md`.
- An agent never edits, stages or reverts files outside its assigned scope.

## 6. Git

- Work happens on branch `refactoring` unless the owner says otherwise.
- Commit each verified task atomically, with explicit staging of only that
  task's files. Never include unrelated, pre-existing or unverified changes.
- Commit messages describe the completed behavior.
- Never push, merge into `main`, force-push, rewrite history, or delete
  branches or tags without an explicit owner request.

## 7. Completion report

Keep it short and report:

- changed areas;
- checks actually run and their result;
- migrations generated, applied and verified, when applicable;
- rule or stack changes (or "no rule changed");
- remaining risks or blockers.
