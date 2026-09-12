import { z } from "zod";
import { AtomicNoteGenerationOutputSchema } from "./knowledge.js";
import { promptMetadataLabels } from "@app/i18n";
import { shippedPromptBodies } from './prompt-defaults.js';
import { builtInOrganizationSlots, builtInConsultationSlots, builtInMaintenanceSlots } from './organization.js';
import { PromptDefinitionSchema, type PromptDefinition, type PromptVariable } from './prompt-catalog.js';
export const promptCategoryLabels = Object.fromEntries(["shared", "summary", "notes", "graph", "sources", "embedding", "organization", "consultation", "maintenance", "diagnostics"].map(key => [key, promptMetadataLabels('categories', key)]));
export function promptLabel(key: string) { return promptMetadataLabels('labels', key); }
const variableExamples: Record<string, z.infer<ReturnType<typeof z.json>>> = {
    reference_guide:[{handle:'r1',kind:'source',title:'Synthetic recall study'},{handle:'r2',kind:'atomic_note',title:'Recall finding'}],
    required_notes:['r2'],
    "chunks": [
        {
            "id": "c1",
            "content": "In a fictional study, retrieval with feedback improved recall."
        }
    ],
    "partial_summaries": "PART 1\nRetrieval helped when feedback was available.",
    "source_type": "Book",
    "source_title": "A fictional study of recall",
    "ordered_subparts": "1. Feedback\nRetrieval with feedback improved delayed recall.",
    "validation_errors": "Unknown evidence alias: c9",
    "allowed_chunk_ids": [
        "00000000-0000-4000-8000-000000000001"
    ],
    "previous_output": "{\"notes\":",
    "source_idea": "Feedback improved delayed recall in a fictional trial.",
    "candidate_notes": "c1: Spaced practice\nPractice on separate days improved recall.",
    "input_kind": "source_chunks",
    "evidence_aliases": [
        "c1"
    ],
    "source_language": "en",
    "input_heading": "ORIGINAL SOURCE CHUNKS",
    "graph_inputs": "c1: Retrieval with feedback improved delayed recall.",
    "relations": [
        {
            "key": "r1",
            "predicate": "improves_recall",
            "definition": "The subject improves recall.",
            "candidateKeys": [
                "c1"
            ]
        }
    ],
    "candidates": [
        {
            "key": "c1",
            "predicate": "supports_recall",
            "definition": "The subject supports recall."
        }
    ],
    "weak_types": "false",
    "sources": [
        {
            "key": "s1",
            "title": "Fictional feedback study",
            "chunks": [
                {
                    "key": "c1",
                    "content": "Feedback improved delayed recall."
                }
            ]
        }
    ],
    "note_relations": [
        {
            "source": "n1",
            "target": "n2",
            "type": "supports"
        }
    ],
    "existing_connections": [],
    "guidance": {
        "guidance": "Explain the conditions under which retrieval helped.",
        "advanced": "Use only the supplied evidence."
    },
    "original_evidence": [
        {
            "handle": "e1",
            "title": "Fictional study",
            "excerpt": "Retrieval helped when feedback was available."
        }
    ],
    "related_knowledge": [],
    "current_page": [],
    "current_state": "Discover original evidence before proposing a change.",
    "target": {
        "title": "Retrieval and feedback",
        "kind": "synthesis"
    },
    "transcript": [
        {
            "action": {
                "tool": "searchEvidence",
                "query": "feedback"
            },
            "result": {
                "items": [
                    {
                        "handle": "e1",
                        "title": "Fictional study"
                    }
                ]
            }
        }
    ],
    "policy": {
        "routine": "weekly",
        "categories": [
            "navigation",
            "evidence"
        ],
        "budget": {
            "changes": 3
        }
    },
    "source_text": "In a fictional study, retrieval with feedback improved recall.",
    "note_title": "Feedback and recall",
    "note_idea": "Feedback qualified the observed recall benefit.",
    "note_body": "The fictional trial found improved recall when feedback followed retrieval.",
    "entity_type": "concept",
    "entity_name": "Retrieval practice",
    "entity_description": "Practice that recalls studied material from memory.",
    "predicate": "improves_recall",
    "definition": "The subject improves delayed recall in the described conditions.",
    "catalog_metadata": {
        "type": "Book",
        "title": "Fictional recall study",
        "language": "en"
    }
};
function variable(key: string, id: string): PromptVariable {
    const numeric = ['max_entities', 'max_relations', 'remaining_tools', 'remaining_repairs'].includes(key);
    return { key, description: promptMetadataLabels('variables', key), valueType: numeric ? 'integer' : 'text', scope: 'run', required: true, originResolver: key, example: variableExamples[key] !== undefined ? (typeof variableExamples[key] === 'object' ? JSON.stringify(variableExamples[key]) : variableExamples[key]) : (numeric ? 3 : key === 'content_language' ? 'English' : key === 'page_title' || key === 'source_title' ? 'Synthetic study' : key === 'output_contract' ? '{"items":[]}' : key === 'query' || key === 'question' ? 'What improves fictional recall?' : 'Synthetic study'), sensitivity: key === 'guidance' ? 'user_guidance' : numeric || ['output_contract', 'content_language', 'input_kind', 'input_heading'].includes(key) ? 'public' : 'source_content', serialization: 'text', applicablePromptIds: [id], emptyRepresentation: null };
}
export const promptDefinitions: PromptDefinition[] = shippedPromptBodies.map(row => {
    const parts = row.id.split('.'), family = parts[0]!;
    const task = family === 'summary' ? 'summarization' : family === 'notes' ? (parts[1] === 'match' ? 'reranking' : 'atomic-note-generation') : family === 'graph' ? 'knowledge-graph-generation' : family === 'sources' ? 'reranking' : family === 'embedding' ? 'embedding' : family === 'diagnostics' ? (parts[1] === 'local_embedding' ? 'embedding' : 'text-generation') : family === 'shared' ? 'fragment' : 'structured-output';
    const title = promptLabel(parts.at(-1)!);
    return PromptDefinitionSchema.parse({ version: 'prompt-catalog-v1', id: row.id, category: [family, ...parts.slice(1, -1)], title, purpose: promptMetadataLabels('purposes', family), caller: row.caller, task, supportsDomain: ['organization', 'consultation', 'maintenance'].includes(family), defaultVersion: row.id==='organization.curator'?'2':'1', fields: [{ id: 'body', template: row.template, editable: true, variableKeys: [...new Set(row.keys)], requiredContractIds: row.keys.includes('output_contract' as never) ? ['output_contract'] : [] }, ...('contract' in row ? [{ id: 'output_contract', template: row.contract, editable: false, variableKeys: [], requiredContractIds: [] }] : [])], variables: [...new Set(row.keys)].map(key => { const v = variable(key, row.id), format = 'formats' in row ? (row.formats as Record<string, {
            valueType: PromptVariable['valueType'];
            serialization: PromptVariable['serialization'];
        }>)[key] : undefined; return { ...v, ...format, example: format?.valueType === 'object' && Array.isArray(variableExamples[key]) ? { candidates: variableExamples[key], relations: variableExamples.relations } : format && ['list', 'object'].includes(format.valueType) ? (variableExamples[key] ?? (format.valueType === 'list' ? [] : {})) : v.example }; }), fragmentIds: row.keys.includes('relation_language' as never) ? ['shared.relation_language'] : [], fixtureIds: ['automatic-wiki-prompts-v1'] });
});
export function promptDefinition(id: string): PromptDefinition { const found = promptDefinitions.find(d => d.id === id); if (!found)
    throw new Error('prompts.errors.unknown'); return found; }
export const organizationPromptFunctions = { pageSynthesis: 'organization', consultation: 'consultation', weekly: 'maintenance.weekly', monthly: 'maintenance.monthly', cleanup: 'maintenance.cleanup' } as const;
for (const [functionName, prefix] of Object.entries(organizationPromptFunctions)) {
    const defaults = functionName === 'pageSynthesis' ? builtInOrganizationSlots : functionName === 'consultation' ? builtInConsultationSlots : builtInMaintenanceSlots[functionName as keyof typeof builtInMaintenanceSlots];
    for (const slot of ['guidance', 'advanced'] as const) {
        const id = `${prefix}.${slot}`, template = defaults[slot].replaceAll('{{title}}', '%page_title%').replaceAll('{{language}}', '%content_language%');
        const keys = [...new Set([...template.matchAll(/%([a-z][a-z0-9_]*)%/g)].map(m => m[1]!))];
        promptDefinitions.push(PromptDefinitionSchema.parse({ version: 'prompt-catalog-v1', id, category: [prefix.split('.')[0]!, ...prefix.split('.').slice(1)], title: promptLabel(slot), purpose: promptMetadataLabels('purposes', prefix.split('.')[0]!), caller: 'Organization instruction ' + functionName + '.' + slot, task: 'structured-output', supportsDomain: true, defaultVersion: '1', fields: [{ id: 'body', template, editable: true, variableKeys: ['page_title', 'content_language'], requiredContractIds: [] }], variables: ['page_title', 'content_language'].map(key => variable(key, id)), fragmentIds: [], fixtureIds: ['organization-legacy-slots'] }));
    }
}
for (const definition of promptDefinitions) {
    if (["notes.extract", "notes.repair"].includes(definition.id))
        definition.fields.push({ id: "output_contract", template: JSON.stringify(z.toJSONSchema(AtomicNoteGenerationOutputSchema), null, 2), editable: false, variableKeys: [], requiredContractIds: [] });
    const id = definition.id;
    if (!id.startsWith("shared.") && !id.startsWith("embedding.") && !id.startsWith("diagnostics.") && !id.endsWith(".guidance") && !id.endsWith(".advanced") && !id.includes(".state.") && !id.includes(".validation."))
        definition.fragmentIds.push("shared.output_language");
    if (definition.task !== "embedding" && definition.task !== "fragment" && !id.endsWith(".guidance") && !id.endsWith(".advanced") && !id.includes(".state.") && !id.includes(".validation."))
        definition.providerFragments.push({ id: "shared.codex_adapter_instruction", provider: "openai-codex" });
    const additional: Record<string, string[]> = { "organization.legacy_synthesis": ["organization.guidance", "organization.advanced", "organization.state.discover", "organization.state.read", "organization.state.propose", "organization.repair"], "consultation.answer": ["consultation.guidance", "consultation.advanced"], "maintenance.weekly": ["maintenance.weekly.guidance", "maintenance.weekly.advanced"], "maintenance.monthly": ["maintenance.monthly.guidance", "maintenance.monthly.advanced"], "maintenance.cleanup": ["maintenance.cleanup.guidance", "maintenance.cleanup.advanced"], "sources.match": ["sources.validation.default", "sources.validation.same_root"] };
    definition.fragmentIds.push(...additional[id] ?? []);
    if (id.endsWith('.repair') && id !== 'organization.repair' && id !== 'notes.repair')
        definition.fragmentIds.push(id === 'sources.repair' ? 'sources.match' : id === 'consultation.repair' ? 'consultation.answer' : id.slice(0, -7));
}
