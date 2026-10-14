# Model adapters and second-brain harness direction

Initial assessment: 2026-09-05. Harness decision updated: 2026-09-07.

The [hybrid second-brain implementation plan](second-brain-implementation-plan.md)
develops the wiki workflow, consultation UI, evidence model and staged Obsidian
integration against this boundary. The selected starting approach is a
TypeScript executor specific to the application, validated by its M2
three-tool spike. Provider SDK evaluation remains independent.

Current model routing follows [the AI rules](../rules/ai-and-knowledge.md):
organization, consultation, maintenance, cleanup and instruction samples use
`structured-output`. The operation override takes precedence over the task route,
then the default profile only if no route exists. Query embeddings retain their
independent `embedding` route. Local/remote execution follows the selected model,
without a separate permission selector. See [AI setup](../README.md#local-models)
for the setup workflow.

Keep the existing `AiModelAdapter` boundary and place any future agent runtime
above application services. The current product already has local GGUF/MLX,
remote models, model-based execution selection, task routing, parameter normalization and audit
records. Replacing that whole boundary solely to prepare a wiki would create
unnecessary migration work.

## Selected approach and alternatives

| Option | Role | Fit for Memora Eterna |
| --- | --- | --- |
| Application-specific TypeScript executor | Explicit workflow states, bounded model/tool loop and review/apply transitions | Selected initial harness; reuse Zod, PostgreSQL jobs/checkpoints and supervised workers. Validate recovery and complexity at M2. |
| Existing adapters | Model execution and capability negotiation | Retain as the application contract, including local runtimes. |
| LangGraph.js | Stateful execution, checkpoints and pauses for review | Preferred external alternative if M2 reveals excessive custom branching/recovery machinery. Evaluate the same scenarios before adoption. |
| Vercel AI SDK | Provider abstraction, structured outputs, tools and agent loops | Candidate for a separate remote-provider adapter spike; domain services remain independent of SDK types. Not a wiki prerequisite. |
| DeepSeek Harness | Composable agent runtime with plugins, sessions, tools and scheduling | Experimental only; not the initial runtime. The evaluated developer-preview APIs are still evolving. |

The executor is deliberately limited to product workflows. The application
owns transitions into review and apply; the model may select only permitted
read/proposal actions within a bounded analysis state. Native tool calls and
validated JSON actions share the same application contracts. Versioned prompts
and weekly/monthly schedules live in PostgreSQL and use existing task routing;
the persisted scheduler is described in `second-brain-implementation-plan.md`.

[LangGraph.js](https://docs.langchain.com/oss/javascript/langgraph/overview)
and its [persistence layer](https://docs.langchain.com/oss/javascript/langgraph/persistence)
are the external comparison target. If selected later, nodes must call existing
services/adapters, with one defined checkpoint authority per run. Canonical
knowledge, review decisions and mutation receipts stay in application storage.
This execution graph does not replace the knowledge graph.

The [AI SDK provider architecture](https://ai-sdk.dev/docs/foundations/providers-and-models)
separates providers and models, while its [agent documentation](https://ai-sdk.dev/docs/agents)
describes tool loops. These capabilities make it a plausible implementation
choice, not a replacement for source identity, processing plans or persistence.

[DeepSeek's official announcement](https://www.deepseek.com/harness/en/)
describes a Cordis-based plugin runtime covering models, tools, sessions,
sandboxes, storage, loops and scheduling. Its append-only session history is
relevant to auditable wiki work. The announcement also explicitly identifies the
runtime as a developer preview whose APIs will evolve.

## Selected wiki boundary

```text
Application-specific TypeScript workflow executor
  -> application tools: search evidence, read source revision, propose wiki edit
  -> validated services, persisted jobs, review policies
  -> AiModelAdapter -> provider SDK / local runtime
  -> repositories -> canonical PostgreSQL
```

The M2 wiki spike uses synthetic sources and only three tools:
search evidence, read a revision, and propose a page change. Acceptance requires
source citations, cancellation, restart recovery, per-step costs, enforced local
privacy and review before replacing curated content. Tool execution should have
explicit scopes and budgets; source text is evidence, never an instruction that
can grant additional permissions. Run the same workflow with an eligible local
and a remote model in separate, explicitly authorized test configurations.
Include restart while awaiting review, restart after commit before completion,
cancellation during a call/before apply and a concurrent human edit.

Keep the selected executor if these cases pass with a small maintainable
implementation. If they require substantial general-purpose branching/recovery
infrastructure, compare LangGraph.js before expanding the workflow. Record
evidence, checkpoint ownership and exact dependency versions before any
external adoption. A framework does not replace tool authorization or protect
against prompt injection on behalf of application services.

The decision selects the initial implementation direction only. It installs no
framework, changes no model adapter, and claims no runtime compatibility. AI
SDK evaluation can proceed independently; it must not delay the wiki spike.
