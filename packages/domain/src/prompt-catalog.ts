import { z } from "zod";

export const promptCatalogVersion = "prompt-catalog-v1";
const key = z.string().regex(/^[a-z][a-z0-9_]*$/);
const promptId = z.string().regex(/^[a-z][a-z0-9_.-]*$/);
const labels = z.object({ en: z.string().min(1), "pt-BR": z.string().min(1), it: z.string().min(1), fr: z.string().min(1), es: z.string().min(1) }).strict();
export const PromptVariableSchema = z.object({
  key, description: labels, valueType: z.enum(["text", "integer", "number", "boolean", "list", "object"]),
  scope: z.enum(["application", "function", "domain", "run"]), required: z.boolean(),
  originResolver: key, example: z.json(), sensitivity: z.enum(["public", "source_content", "user_guidance"]),
  serialization: z.enum(["text", "json", "json_pretty", "evidence_aliases"]), applicablePromptIds: z.array(promptId).min(1),
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
  variables: z.array(PromptVariableSchema), fragmentIds: z.array(promptId), providerFragments:z.array(z.object({id:promptId,provider:z.string()}).strict()).default([]), fixtureIds: z.array(z.string().min(1)).min(1)
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

export type PromptDefinition = z.infer<typeof PromptDefinitionSchema>;
export type PromptVariable = z.infer<typeof PromptVariableSchema>;
export type PromptCompositionSnapshot = z.infer<typeof PromptCompositionSnapshotSchema>;
export const PromptScopeSchema = z.object({
  level: z.enum(["global", "function", "domain", "domain_function"]),
  domainId: z.string().uuid().nullable().default(null)
}).strict().refine(v => (v.level === "domain" || v.level === "domain_function") === (v.domainId !== null));
export const PromptRevisionSchema = z.object({
  id: z.string().uuid(), promptId, scope: PromptScopeSchema,
  fields: z.record(key, z.string().max(100_000)), createdAt: z.string(),
  origin: z.enum(["draft", "reset", "restore", "legacy"]),
  legacy: z.record(z.string(), z.json()).nullable(),
  validationHash: z.string().nullable(), samplePassed: z.boolean()
}).strict();
export type PromptRevision = z.infer<typeof PromptRevisionSchema>;
export const PromptPinSchema = z.object({
  version: z.literal(promptCatalogVersion),
  entries: z.array(z.object({ id: promptId, fields: z.record(key, z.string()),
    revisions: PromptCompositionSnapshotSchema.shape.revisions,
    origin: PromptCompositionSnapshotSchema.shape.origin
  }).strict()),
  domainId: z.string().uuid().nullable()
}).strict();
export type PromptPin = z.infer<typeof PromptPinSchema>;
export const PromptCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("list") }).strict(),
  z.object({ command: z.literal("get"), promptId, revisionId:z.string().uuid().optional(), domainId: z.string().uuid().nullable().default(null) }).strict(),
  z.object({ command: z.literal("save"), promptId, scope: PromptScopeSchema, fields: z.record(key,z.string().max(100_000)) }).strict(),
  z.object({ command: z.literal("preview"), promptId, domainId: z.string().uuid().nullable().default(null), fields: z.record(key,z.string().max(100_000)) }).strict(),
  z.object({ command: z.literal("validate"), revisionId: z.string().uuid(), sample: z.boolean().default(false) }).strict(),
  z.object({ command: z.literal("activate"), revisionId: z.string().uuid(), expectedActiveId: z.string().uuid().nullable() }).strict(),
  z.object({ command: z.literal("reset"), promptId, scope: PromptScopeSchema, expectedActiveId: z.string().uuid().nullable() }).strict(),
  z.object({ command: z.literal("restore"), revisionId:z.string().uuid() }).strict()
]);
export type PromptCommand = z.infer<typeof PromptCommandSchema>;

export type PromptToken = { kind: "literal" | "variable"; text: string; start: number; end: number };
export class PromptTemplateError extends Error {
  constructor(public readonly code: "unknown_variable" | "missing_required" | "type_mismatch" | "malformed_variable" | "missing_contract" | "composition_cycle", public readonly variable = "") {
    super(`prompts.errors.${code}`);
  }
}
/** A single scanner. Source values are never parsed as templates. */
export function parsePromptTemplate(template: string): PromptToken[] {
  const tokens: PromptToken[] = [];
  let i = 0, literal = "", start = 0;
  const flush = () => { if (literal) tokens.push({ kind: "literal", text: literal, start, end: i }); literal = ""; };
  while (i < template.length) {
    if (template[i] !== "%") { literal += template[i++]; continue; }
    if (template[i + 1] === "%") { literal += "%"; i += 2; continue; }
    if (!/[A-Za-z_]/.test(template[i + 1] ?? "")) { literal += template[i++]; continue; }
    const end = template.indexOf("%", i + 1), name = template.slice(i + 1, end < 0 ? undefined : end);
    if (end < 0 || !/^[a-z][a-z0-9_]*$/.test(name)) throw new PromptTemplateError("malformed_variable", name);
    flush(); tokens.push({ kind: "variable", text: name, start: i, end: end + 1 }); i = end + 1; start = i;
  }
  flush(); return tokens;
}
export function promptVariablesUsed(template: string): string[] {
  return [...new Set(parsePromptTemplate(template).filter(t => t.kind === "variable").map(t => t.text))];
}
export function validatePromptGraph(graph: Record<string, readonly string[]>): void {
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id:string) => {
    if (visiting.has(id)) throw new PromptTemplateError("composition_cycle",id);
    if (visited.has(id)) return;
    visiting.add(id); for (const child of graph[id] ?? []) visit(child);
    visiting.delete(id); visited.add(id);
  };
  Object.keys(graph).forEach(visit);
}
export function renderPromptTemplate(template: string, variables: readonly PromptVariable[], values: Record<string, unknown>, requiredContracts: readonly string[] = []): string {
  const tokens = parsePromptTemplate(template), used = tokens.filter(t => t.kind === "variable").map(t => t.text);
  for (const contract of requiredContracts) if (!used.includes(contract)) throw new PromptTemplateError("missing_contract", contract);
  return tokens.map(token => {
    if (token.kind === "literal") return token.text;
    const variable = variables.find(v => v.key === token.text);
    if (!variable) throw new PromptTemplateError("unknown_variable", token.text);
    const value = values[variable.key];
    if (value === undefined || value === null) {
      if (!variable.required) return variable.emptyRepresentation!;
      throw new PromptTemplateError("missing_required", variable.key);
    }
    const valid = variable.valueType === "text" ? typeof value === "string"
      : variable.valueType === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
      : variable.valueType === "number" ? typeof value === "number" && Number.isFinite(value)
      : variable.valueType === "boolean" ? typeof value === "boolean"
      : variable.valueType === "list" ? Array.isArray(value)
      : typeof value === "object" && !Array.isArray(value);
    if (!valid) throw new PromptTemplateError("type_mismatch", variable.key);
    return variable.serialization === "json_pretty" ? JSON.stringify(value,null,2) : variable.serialization === "json" || variable.serialization === "evidence_aliases" ? JSON.stringify(value) : String(value);
  }).join("");
}

export const PromptPreviewSchema=z.object({text:z.string(),fragments:z.array(z.object({id:z.string(),text:z.string(),provider:z.string().nullable()})).default([]),errors:z.array(z.object({field:z.string(),code:z.string(),variable:z.string()})),compositionHash:z.string(),affected:z.array(z.string()),variables:z.array(z.object({field:z.string(),keys:z.array(z.string())})),samplePassed:z.boolean().optional(),sampleProgress:z.lazy(()=>PromptSampleProgressSchema).optional()});
export const PromptOverviewSchema=z.object({definitions:z.array(PromptDefinitionSchema),active:z.array(PromptRevisionSchema),domains:z.array(z.object({id:z.string(),name:z.string()})),states:z.array(z.object({id:z.string(),draft:z.boolean(),invalid:z.boolean()})),routes:z.array(z.object({task:z.string(),profileId:z.string()})),profiles:z.array(z.object({id:z.string(),name:z.string(),modelId:z.string().nullable(),status:z.string(),isDefault:z.boolean().default(false)}))});
export const PromptDetailSchema=z.object({definition:PromptDefinitionSchema,effective:PromptPinSchema.shape.entries.element,revisions:z.array(PromptRevisionSchema),activations:z.array(z.object({id:z.string(),revisionId:z.string(),createdAt:z.string()})),preview:PromptPreviewSchema,affected:z.array(z.string())});
export const PromptResponseSchema=z.union([PromptOverviewSchema,PromptDetailSchema,PromptPreviewSchema,z.string().uuid(),z.null()]);

export const PromptSampleProgressSchema=z.object({version:z.literal(1).default(1),calls:z.number().int().nonnegative().default(0),inputCharacters:z.number().int().nonnegative().default(0),outputTokensReserved:z.number().int().nonnegative().default(0),requiredKeys:z.array(z.string()).default([]),completedKeys:z.array(z.string()).default([]),inapplicable:z.record(z.string(),z.string()).default({}),auditIds:z.array(z.string().uuid()).default([]),checkpoints:z.record(z.string(),z.json()).default({}),error:z.string().nullable().default(null)}).strict();
export type PromptSampleProgress=z.infer<typeof PromptSampleProgressSchema>;
