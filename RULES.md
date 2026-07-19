# Memora Eterna core engineering rules

This is the small specification that applies to every repository task. Read it
together with `STACK.md` and `rules/index.md`; then load only the domain rules
selected by the index.

## 1. Specification-driven workflow

1. Inspect the relevant implementation and tests before changing them.
2. Use `rules/index.md` to select the smallest applicable rule set.
3. Treat the selected rules as acceptance criteria, not background reading.
4. Keep changes scoped to the request and preserve unrelated user work.
5. Verify the result in proportion to its risk before reporting completion.

When a request conflicts with a rule, the user's explicit request controls the
implementation and the contradicted rule must be updated in the same change.
Never leave code and the specification knowingly inconsistent.

## 2. Agent execution contract

- State assumptions that materially affect the solution. Ask one concise
  question when competing interpretations would materially change the result;
  otherwise make a safe, reversible assumption explicit and proceed.
- Prefer the simplest complete approach and challenge requests that create
  unnecessary risk, complexity, or maintenance cost.
- Define verifiable success criteria and complete the request end to end. Track
  every item in multi-file or batch work; identify any incomplete part as
  `[blocked]` with the exact missing input or condition.
- Ground claims in repository files and actual tool results. Label inferences,
  never invent evidence, and use a fallback check when retrieval is empty,
  partial, or suspiciously narrow.
- Use targeted tools and the repository's dedicated edit/test mechanisms. Ask
  before irreversible, externally visible, expensive, or production-impacting
  actions.
- Match existing style and naming. Remove only unused artifacts introduced by
  the current change; report unrelated issues instead of silently fixing them.
- During substantial work, provide concise, outcome-based progress updates
  without narrating routine tool calls.
- Before finalizing, check correctness, scope, simplicity, grounding, output
  format, and safety. Keep the final response concise and report only checks
  that actually ran.

## 3. Maintaining the specification

A change is **durable** when future work must continue to respect it. Examples
include a public contract, domain invariant, architectural boundary, persistent
data behavior, security or privacy policy, workflow semantic, or stack decision.

- Every new durable decision must be added to the relevant file in `rules/`, or
  to `STACK.md` when it changes technology or dependency policy.
- If a durable change contradicts an existing rule, update that rule instead of
  adding an exception elsewhere.
- If no domain file fits, create one and add an explicit route to
  `rules/index.md`.
- Do not turn temporary plans, implementation diaries, command output, or
  one-off bug details into rules.
- Always state in the final response which rules were added or changed. If no
  rule update was needed, state that no durable specification changed.
- Project documentation and rules are written in English.

## 4. System invariants

- The product is local-first, TypeScript-first, contract-driven, and auditable.
- PostgreSQL is the canonical local store. Files, paths, projections, search
  indexes, embeddings, and AGE graphs are not canonical identity.
- Stable IDs and source evidence must survive derivation, synchronization, and
  reprocessing.
- Privileged work stays outside untrusted UI surfaces. Validate data with Zod
  whenever it crosses a process, worker, integration, or sidecar boundary.
- Never expose or log secrets. Remote processing must respect the selected
  privacy policy and record its effective model, parameters, token usage, and
  estimated cost when available.

## 5. Change discipline

- Prefer the smallest complete solution. Do not add speculative features or
  refactor unrelated code.
- Do not revert changes made by the user or other agents unless explicitly
  asked.
- Add or update regression coverage for changed behavior when practical.
- For UI changes, cover the relevant empty, loading, error, and success states.
- Do not create a final commit unless the user explicitly requests one.

## 6. Multi-agent Git workflow

### 6.1 Checkout and branch coordination

- Use the existing Local checkout. Do not create or use Git worktrees for task
  isolation or integration.
- Before the first edit, record the current branch and repository status. When
  a task needs its own branch, name it `codex/<task-slug>` and create or switch
  to it only when the checkout state can be preserved safely.
- Only one code-changing task may own the checkout at a time. Other agents may
  inspect or review concurrently, but they must not edit tracked files, switch
  branches, stage, commit, or integrate while another task owns the checkout.
- Preserve unrelated user or agent changes. Do not switch branches, stage,
  commit, stash, move, or overwrite those changes; continue only when the
  requested edit can be isolated safely in the current checkout.
- Keep each task scoped to its assigned files or subsystem. Shared files such
  as lockfiles, migrations, central registries, generated files, and global
  configuration must be coordinated explicitly when multiple tasks are active.

### 6.2 Commit authorization

- Do not create a commit merely because an implementation turn has ended.
- The exact user instruction `finalizar` authorizes the agent to verify,
  commit, and request or perform integration for the current task.
- A separate explicit instruction to commit also counts as authorization, but
  applies only to the files and scope named by the user.
- Never include pre-existing, unrelated, or unverified changes in a commit.
- Stage files or hunks explicitly. Do not use broad staging when unrelated
  changes are present.
- Commits must be atomic, describe the completed behavior, and contain only
  changes belonging to the current task.

### 6.3 Finalization and integration

When the user issues `finalizar`, perform the following sequence:

1. Confirm that the requested behavior is complete.
2. Inspect the complete task diff and repository status.
3. Run the relevant tests, type checks, linting, builds, and other checks
   required by the selected domain rules.
4. Commit only the current task's changes on its dedicated branch.
5. Synchronize the task branch with the latest local base branch according to
   the repository's merge policy.
6. Resolve merge conflicts using the repository rules, tests, and the intent
   of both changes. Never resolve conflicts by blindly choosing `ours`,
   `theirs`, or an entire side of a file.
7. Run the affected checks again after conflict resolution.
8. From a clean checkout, switch to the base branch and integrate the task
   according to the repository's merge policy.
9. Report the task commit, integration result, checks run, and any remaining
   risk.

- Integrations into the same base branch must be serialized. Only one task may
  update the base branch at a time.
- If the checkout contains unrelated uncommitted changes, do not switch
  branches or integrate. Preserve the task branch and ask the user to resolve
  the checkout state.
- If a conflict represents competing product behavior, schema intent,
  migration order, security policy, or another semantic decision, stop and ask
  the user instead of guessing.
- Do not push, force-push, open a pull request, or delete a branch unless the
  user explicitly authorizes that action.

## 7. Completion report

Report:

- changed files or areas;
- checks and tests actually run;
- migrations generated, applied, and verified, when applicable;
- rule or stack specification changes;
- remaining risks or blockers.
