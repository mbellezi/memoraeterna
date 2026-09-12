import { z } from "zod";

export const promptCatalogVersion = "prompt-catalog-v1";
const key = z.string().regex(/^[a-z][a-z0-9_]*$/);
const promptId = z.string().regex(/^[a-z][a-z0-9_.-]*$/);
const labels = z.object({ en: z.string().min(1), "pt-BR": z.string().min(1), it: z.string().min(1), fr: z.string().min(1), es: z.string().min(1) }).strict();
export const PromptVariableSchema = z.object({
  key, description: labels, valueType: z.enum(["text", "integer", "number", "boolean", "list", "object"]),
  scope: z.enum(["application", "function", "domain", "run"]), required: z.boolean(),
  originResolver: key, example: z.json(), sensitivity: z.enum(["public", "source_content", "user_guidance"]),
  serialization: z.enum(["text", "json", "evidence_aliases"]), applicablePromptIds: z.array(promptId).min(1),
  emptyRepresentation: z.string().nullable()
}).strict().superRefine((value, ctx) => {
  if (!value.required && value.emptyRepresentation === null)
    ctx.addIssue({ code: "custom", path: ["emptyRepresentation"], message: "Optional variables need an explicit empty representation" });
});
export const PromptDefinitionSchema = z.object({
  version: z.literal(promptCatalogVersion), id: promptId, category: z.array(key).min(1),
  title: labels, purpose: labels, caller: z.string().min(1),
  task: z.enum(["summarization", "atomic-note-generation", "knowledge-graph-generation", "reranking", "structured-output", "embedding", "text-generation", "fragment"]),
  supportsDomain: z.boolean(), defaultVersion: z.string().min(1),
  fields: z.array(z.object({ id: key, template: z.string().max(100_000), editable: z.boolean(),
    variableKeys: z.array(key), requiredContractIds: z.array(promptId) }).strict()).min(1),
  variables: z.array(PromptVariableSchema), fragmentIds: z.array(promptId), fixtureIds: z.array(z.string().min(1)).min(1)
}).strict().superRefine((value, ctx) => {
  const keys = value.variables.map(v => v.key);
  if (new Set(keys).size !== keys.length || new Set(value.fields.map(f => f.id)).size !== value.fields.length)
    ctx.addIssue({ code: "custom", message: "Duplicate variable or field identity" });
  for (const [index, field] of value.fields.entries()) {
    if (field.variableKeys.some(k => !keys.includes(k))) ctx.addIssue({ code: "custom", path: ["fields", index], message: "Undeclared field variable" });
  }
});
export const PromptCompositionSnapshotSchema = z.object({
  version: z.literal(promptCatalogVersion), promptId,
  revisions: z.array(z.object({ id: promptId, revisionId: z.string().min(1) }).strict()).min(1),
  compositionHash: z.string().regex(/^[a-f0-9]{64}$/),
  templateLanguage: z.enum(["en", "pt-BR", "it", "fr", "es"]),
  origin: z.enum(["default", "global", "function", "domain", "domain_function"]),
  outputContractVersion: z.string().min(1), embeddingStrategyIdentity: z.string().nullable()
}).strict();
