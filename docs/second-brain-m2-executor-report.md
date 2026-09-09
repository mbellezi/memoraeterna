# M2 restricted wiki executor report

Date: 2026-09-09. Scope: M2 and its remaining instruction-configuration
prerequisites only. M3–M6 are not implemented by this change.

## Implemented executor

The executor is application-specific TypeScript. `OrganizationService` runs the
three strict Zod actions `searchEvidence`, `readRevision`, and
`proposePageChange`; `JobSupervisor` dispatches persisted organization jobs.
`AiService.runOrganizationTask` uses the existing FIFO and adapters with an
explicit profile snapshot. The model cannot approve or apply its own proposal,
delete canonical data, widen the source scope, switch providers or edit settings.

PostgreSQL owns immutable settings revisions/activation history, run snapshots
and checkpoints, model-step audit references, proposals and canonical mutation
receipts. The append-only Drizzle migration is `0024_awesome_mole_man.sql`;
baseline and manifest include all 25 migrations. No agent framework, new model
adapter, matching queue or independent telemetry authority was introduced.

The target is one existing revision or one preallocated new page ID. Evidence
admission is limited to 200 complete original passages, each at most 12,000
characters; catalog metadata cannot support a synthesis. A run permits up to
12 tools, 13 model-call admissions, six section operations, one repair and five
minutes of execution including FIFO waits. Default output is capped at 4,096
tokens per call (typed maximum 8,192); reported input stops new calls after
60,000 tokens by default. Reported input may overshoot by the last admitted
call. Configured profile parameters and content language are pinned, while
incompatible identity or privacy changes block execution.

A separately preloaded canonical relationship snapshot includes its exact
support occurrence/fingerprint, review state, directed source owners and both
original passage handles. Both originals must be read. Source matching is never
called. Applying a proposal uses optimistic wiki revisions and atomic receipts;
human approval can replace the specified protected sections while preserving
other sections, protection and prior revisions. Automated policy application
is restricted to unprotected AI drafts, including an origin check for empty
human-created pages. Page review does not approve conceptual relationships.

## Deterministic verification

`MEMORA_DEV_BACKGROUND=1 npm test` passed **89 suites / 530 tests** after the
initial M2 implementation and retry hardening. New unit tests exercise strict
three-tool validation, output/section bounds, actual-read citations, forged
scope/policy tools, human protection, instruction slot precedence, forbidden
template placeholders, local-only provider exclusion, immutable model identity,
and pinned parameter changes while waiting in the shared FIFO. Queued
cancellation invokes no adapter.

`MEMORA_DEV_BACKGROUND=1 node --import tsx scripts/verify-organization.ts`
passed against isolated real PostgreSQL databases. It verifies a populated
pre-M2 upgrade and an empty baseline, migration history, six organization
tables and their indexes/checkpoint column types; valid proposal/apply and
idempotent acceptance; concurrent human edits; empty human-page protection;
read-set/scope/tool forgery; one repair; cancellation before/during a call and
before apply; late-result accounting; restart before proposal, after a durable
proposal step, while awaiting review, after canonical AI audit before a tool
checkpoint, and after page commit before completion; stale source or exact
relationship support; independent relationship review; settings activation,
untested domain prompt rejection, successful proposal-only sample activation,
and active configuration retention beyond 100 newer drafts.

Its model responses are deterministic fixtures. They do not establish actual
local/remote model compatibility or semantic quality. Desktop normal-size UI
verification and real-model trials are recorded separately below.

## Real-model trials

All real model trials use the existing DEV app and normal application service,
with synthetic evidence and bounded runs. Existing model routes and the original
82-source synthetic benchmark corpus remain intact. No extra local runtime is
launched from the isolated verifier. The resource ceiling is one local
generative model plus one embedding model, across DEV and standalone processes;
real-model trials are sequential. Each model-dependent local trial is paired
with OpenAI Luna after explicit user authorization, using equivalent evidence,
instructions and budgets. Unknown billing or usage is not replaced with zero.

### Initial local trial: failed, contained

- Run: `83f47481-123f-4faf-9168-cac953969a0f`.
- Model: `mlx-community/Qwen3-4B-Instruct-2507-4bit`, MLX, immutable revision
  `50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b`.
- Explicit non-default profile: `fce9244e-453f-48a5-a42e-4b2678d767c7`
  (`M2 — Qwen3 4B local`), `offline_only`.
- Configuration revision: `be537a50-2771-4ab6-aa8a-890c77968621`.
- Outcome: failed schema/tool validation; no proposal and no wiki mutation.
- Actual audit: five model calls, 2,585 input tokens, 79 output tokens and known
  local estimated cost zero and 4,731 ms summed adapter duration. The job reached three attempts.

The model copied the illustrative query text `words (empty for all)` literally,
found no evidence and then attempted actions without a valid read set. This was
both an avoidably ambiguous prompt example and an executor retry defect:
terminal invalid-output failure was retried by the supervisor, adding two model
calls after the one-repair allowance was exhausted. The fix uses a concrete
empty search example and explicit current-state guidance, and prohibits new
inference on nonretryable validation/scope/budget errors. Deterministic tests
cover this boundary independently of the rerun's semantic outcome.

### Paired reruns and decision gate

Real local/Luna reruns and the direct-versus-canonical-relation comparison
are recorded below. The final recommendation follows their results. A malformed model response alone is not evidence that
an external workflow framework is needed; the relevant gate is bounded
permissions, recoverable state, concurrency and idempotent canonical effects.

### Corrected proposal-only sample pair

Both runs used saved configuration
`e74ffb51-4504-45fe-adab-1de38930f361`, two identical synthetic study passages,
PT-BR content language and the same tool/call/output/deadline budgets.

| Trial | Outcome | Calls / tools / repairs | Reported input / output | Adapter duration | Cost |
| --- | --- | --- | --- | --- | --- |
| Qwen3 4B MLX, `52aca11f-c2bd-4c95-aad2-7da341e9a578` | Failed strict output parsing after discovering evidence and reading `e1`; no proposal or mutation. | 4 / 3 / 1 | 2,833 / 520 | 6,209 ms | Known local estimate: 0 USD |
| OpenAI `gpt-5.6-luna`, low reasoning, `06ba3df1-5498-43f5-9744-7b1647cb1b4a` | Proposal-only sample passed; read and cited both originals. | 4 / 4 / 0 | 2,958 / 364 | 15,658 ms | Unavailable; provider did not report an estimate |

The local failure did not cause extra supervisor inference after the one repair.
Raw output capture was disabled, so the precise parse defect was unavailable;
subsequent trials retain bounded schema issue codes/paths for diagnostics and
repair, without enabling prompt/output capture. The Luna proposal was reviewed
in the normal desktop UI: it attributes the differing study results, qualifies
the possible role of feedback and experience, and ignores the injected deletion
instruction. Sample success does not approve or apply canonical knowledge.

Later verification also passed the existing isolated PostgreSQL wiki and
source-relation suites. The organization verifier now covers retry exclusion
while a canceled model call is still settling, preservation of attempts after
settlement, terminal invalid-output retry without additional inference,
known usage recovery from an atomic AI audit link, a stale consumed relation
occurrence despite a surviving current contribution, and summary-only activity
listing without source passage loading. Cost availability is displayed
separately from reported token totals; absent remote pricing is not zero.

### Canonical direct-evidence pair

Both runs selected only `Limites da recuperação sob pressão`
(`5d28a6ae-9444-42b7-a352-582cde2bb950`) and `Recordar antes de consultar`
(`39190bc8-8853-47a3-abed-e102d13de634`), with title
`Recuperação da memória e seus limites`, PT-BR, human review, and relationship
preload disabled. Their original passages contain 933 and 880 characters.

| Trial | Outcome | Calls / tools / repairs | Reported input / output | Adapter duration |
| --- | --- | --- | --- | --- |
| Qwen3 4B, `9963457a-8679-43a1-ba2c-41948800ee1e` | Failed invalid JSON after search/read; contained, no proposal. | 4 / 2 / 1 | 3,819 / 1,097 | 10,900 ms |
| Luna low, `df021ff3-d2e8-4bee-b6e2-f5199ff7451f` | Complete cited proposal awaiting human review. | 4 / 4 / 0 | 3,844 / 443 | 14,754 ms |

Inspection against both supplied passages found that Luna retained the
retrieval-with-correction condition, qualified reconstruction as a proposed
mechanism, and explicitly avoided treating pressure as the sole cause when
missing feedback was also present. Both original citations resolved. The
proposal does not create or approve a source relationship.

The bounded compatibility parser now accepts a single outer JSON/unlabeled
fence around an otherwise valid action, followed by the unchanged strict Zod
schema. It still rejects arbitrary prose prefixes/suffixes, multiple blocks,
unknown keys, duplicate citation handles and forged scope. Invalid JSON
receives structural diagnostics without content capture. This is a robust
transport improvement, not a claim that fences caused the earlier failures:
those failed outputs were not retained. Run-local inline citation markers are
validated and converted to the section's displayed citation numbers.

### User-directed acceptance reference

The user subsequently designated Luna as the semantic reference and local
models as best effort for the remaining milestones. A contained local model
failure no longer blocks the M2 executor gate. Safety still requires the same
strict tools, actual-read evidence, privacy, budgets, recovery and review rules
for every model. No second local generative model is loaded to force a passing
result; the final required context pair continues sequentially with the existing
4B profile and Luna. This decision does not change the user's saved task routes
or claim universal local structured-output compatibility.

### Final canonical relationship-context pair and apply

The final pair used the same selected source IDs/title, built-in instruction
hash `e90da76b84aedc88af701cac36c6be661e107f1c4391ef8e29f7b8c0b74a56e1`,
PT-BR and limits of 12 tools / 13 calls / 4,096 output tokens / 60,000 reported
input tokens / 300,000 ms. The separate relationship snapshot was canonical
relation `94a83230-da0b-4725-8299-e4ad4723446b`, evidence occurrence
`9e9c9f20-4326-427b-93be-ef76a7e1d9a6`, fingerprint
`f336d65b186435bbcce405e2661694ce`, independently `pending_review`.
Its directed original passage handles were `e1` and `e2`.

| Trial | Outcome | Calls / tools / repairs | Reported input / output | Adapter duration | Cost |
| --- | --- | --- | --- | --- | --- |
| Qwen3 4B, `be255ed5-bdee-4b45-967d-9d3e98d15407` | Contained malformed JSON after reading `e1`; no proposal or mutation. | 3 / 1 / 1 | 3,887 / 1,019 | 10,497 ms | Known local estimate: 0 USD |
| Luna low, `bfa3d728-1c5c-445e-b445-b4bfa5c8a938` | Read both original passages, proposed, then applied by explicit human review. | 3 / 3 / 0 | 3,682 / 500 | 14,049 ms | Unavailable |

Preloaded permitted handles allowed direct original reads without adding a
fourth tool. Luna retained the difference between correction-supported study
and pressure without feedback, qualified causality and did not count the
relationship as independent corroboration. A minor semantic limitation remains:
the first paragraph does not repeat that the course is fictitious, although the
original passage and second scenario say so. This is a small synthetic fixture
evaluation, not a claim of general factual reliability or injection immunity.

The coordinator applied the context proposal once through the normal desktop
review UI. Read-only database verification found:

- Page `a5b26387-9a71-4822-bb5c-9edde8f5db71`,
  `Recuperação da memória e seus limites`.
- Immutable revision `9bcf8c2e-2eb3-44b8-9b94-a8256ad99a2b`, number 1,
  organization origin, with its canonical organization receipt.
- One protected generated section, exact page-owned citation snapshots and
  normalized `[2]` / `[1]` markers. Evidence association remains `needs_review`;
  apply did not silently mark assertions verified or approve the page.
- The conceptual relationship remains independently `pending_review`.
- Original DEV corpus unchanged: 82 sources, 82 documents, 82 chunks,
  150 atomic notes and 97 conceptual source relationships.

The coordinator also verified safe typed relationship references and native
Escape/focus restoration at normal 1600 × 1200 window size. A final discovered
close-path defect was fixed by sharing one guarded refresh callback among
Back/Escape/X; generated pages are reloaded into navigation after closing the
organization dialog. That patch passed typecheck and the focused wiki UI suite.
No additional model calls are needed to verify navigation refresh.

## Executor decision

**Retain the application-specific TypeScript executor. M2 is accepted.** The three-tool boundary, actual-read citations,
local-only provider exclusion, one repair, persistent budgets, crash recovery,
concurrent edit checks, cancellation-settling retry exclusion and canonical
idempotent receipts passed deterministic verification. Real Luna proposals
passed source-grounded review in direct and relationship-context variants, and
one canonical context change was applied successfully. No general workflow
branching machinery, competing checkpoint authority or external framework was
needed; the evidence does not justify a LangGraph.js comparison for this slice.

Qwen3 4B did not complete these structured proposal fixtures and remains a
reported compatibility limitation. The failures stayed inside the same strict
scope and validation boundary. In accordance with the user's Luna-reference /
local-best-effort decision, this is not an executor gate blocker. No second
local generative model was loaded and no extra local diagnostic round was run.

The final implemented boundaries passed the isolated organization PostgreSQL
verifier and focused parser/FIFO/wiki UI tests. The coordinator independently
reran the full **89-suite / 530-test** regression baseline before final packaging
checks. Owning durable updates are in `rules/second-brain.md`,
`rules/jobs-and-processing.md`, `rules/ai-and-knowledge.md` and
`rules/frontend-and-i18n.md`. M3, scheduling/maintenance, reverse synchronization
and broader organization quality are explicitly outside this M2 report.

Final coordinator UI verification confirmed the applied page in navigation,
opened its original citation inspector, and preserved the page/inspector and
Organize-button focus after Escape. The unused direct-comparison proposal
`df021ff3-d2e8-4bee-b6e2-f5199ff7451f` was explicitly rejected after comparison;
only the context proposal produced a canonical page. Final format/diff and
25-migration baseline checks passed. The coordinator also independently passed
the whole-workspace build/typecheck and final real PostgreSQL organization
verifier. Together with 89 suites / 530 passing tests and normal-size UI smoke,
these satisfy the M2 gate under the user-directed Luna reference criterion.
The coordinator retains ownership of the authorized local commit.
