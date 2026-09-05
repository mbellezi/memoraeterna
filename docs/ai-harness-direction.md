# Model adapters and future wiki harnesses

Assessment date: 2026-09-05.

Keep the existing `AiModelAdapter` boundary and place any future agent runtime
above application services. The current product already has local GGUF/MLX,
remote models, privacy policies, task routing, parameter normalization and audit
records. Replacing that whole boundary solely to prepare a wiki would create
unnecessary migration work.

## Candidates

| Option | Role | Fit for Memora Eterna |
| --- | --- | --- |
| Existing adapters | Model execution and capability negotiation | Retain as the application contract, including local runtimes. |
| Vercel AI SDK | Provider abstraction, structured outputs, tools and agent loops | Preferred candidate for a future remote-provider adapter spike; domain services should not depend directly on its types. |
| DeepSeek Harness | Composable agent runtime with plugins, sessions, tools and scheduling | Evaluate for wiki orchestration in an isolated spike. Its developer-preview APIs are still evolving. |

The [AI SDK provider architecture](https://ai-sdk.dev/docs/foundations/providers-and-models)
separates providers and models, while its [agent documentation](https://ai-sdk.dev/docs/agents)
describes tool loops. These capabilities make it a plausible implementation
choice, not a replacement for source identity, processing plans or persistence.

[DeepSeek's official announcement](https://www.deepseek.com/harness/en/)
describes a Cordis-based plugin runtime covering models, tools, sessions,
sandboxes, storage, loops and scheduling. Its append-only session history is
relevant to auditable wiki work. The announcement also explicitly identifies the
runtime as a developer preview whose APIs will evolve.

## Proposed wiki boundary

```text
Wiki workflow / harness
  -> application tools: search evidence, read source revision, propose wiki edit
  -> validated services, persisted jobs, review policies
  -> AiModelAdapter -> provider SDK / local runtime
  -> repositories -> canonical PostgreSQL
```

The initial wiki spike should use synthetic sources and only three tools:
search evidence, read a revision, and propose a page change. Acceptance requires
source citations, cancellation, restart recovery, per-step costs, enforced local
privacy and review before replacing curated content. Tool execution should have
explicit scopes and budgets; source text is evidence, never an instruction that
can grant additional permissions.

This change does not install AI SDK or DeepSeek Harness, implement a wiki, or
claim compatibility with either runtime. The recommendation is to test AI SDK
behind a remote adapter first and choose a harness against the wiki's concrete
workflow afterwards.
