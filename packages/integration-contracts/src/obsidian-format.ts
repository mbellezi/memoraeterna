import { obsidianManagedFrontmatterSchema, type ObsidianManagedFrontmatter } from "./index.js";
export const wikiProjectionCapability = "obsidian-wiki-projection-v1" as const;
export const wikiGeneratedStart = "<!-- memora:generated:start -->";
export const wikiGeneratedEnd = "<!-- memora:generated:end -->";
export const isOutwardProjection = (type: string) => !["source_item", "atomic_note"].includes(type);
/** Only line-ending differences are insignificant. Preserve hard breaks, fences and final newlines. */
export const normalizeProjectionText = (text: string) => text.replace(/\r\n?/g, "\n");
export const hasReservedObsidianContent = (text: string) => /(?:^|\n)\s*["']?memora_[a-z_]+["']?\s*:|<!--\s*memora:/i.test(text);
const keys: Record<string, keyof ObsidianManagedFrontmatter> = {
    memora_id: "memoraId", memora_type: "memoraType", memora_source_id: "memoraSourceId",
    memora_document_id: "memoraDocumentId", memora_root_source_id: "memoraRootSourceId",
    memora_division_id: "memoraDivisionId", memora_document_revision_id: "memoraDocumentRevisionId",
    memora_managed: "memoraManaged", memora_sync_version: "memoraSyncVersion",
    memora_content_hash: "memoraContentHash", memora_wiki_schema: "memoraWikiSchema", memora_revision_id: "memoraRevisionId"
};
export function serializeManagedFrontmatter(frontmatter: ObsidianManagedFrontmatter, userFrontmatter = ""): string {
    const rows = Object.entries(keys).flatMap(([key, field]) => frontmatter[field] === undefined ? [] : [`${key}: ${JSON.stringify(frontmatter[field])}`]);
    return ["---", ...rows, ...(userFrontmatter ? [userFrontmatter] : []), "---"].join("\n");
}
export function parseObsidianMarkdown(raw: string): {
    frontmatter: ObsidianManagedFrontmatter;
    bodyMarkdown: string;
    userFrontmatter: string;
} | null {
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalizeProjectionText(raw));
    if (!match)
        return null;
    const fields: Record<string, unknown> = {}, user: string[] = [], seen = new Set<string>();
    for (const line of match[1]!.split("\n")) {
        const entry = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
        if (!entry || !entry[1]!.startsWith("memora_")) {
            if (/memora_[a-z_]+\s*["']?\s*:/.test(line))
                return null;
            user.push(line);
            continue;
        }
        const key = entry[1]!, field = keys[key];
        if (!field || seen.has(key))
            return null;
        seen.add(key);
        const scalar = entry[2]!;
        try {
            fields[field] = JSON.parse(scalar);
        }
        catch {
            fields[field] = scalar;
        }
    }
    const parsed = obsidianManagedFrontmatterSchema.safeParse(fields);
    if (!parsed.success)
        return null;
    if (isOutwardProjection(parsed.data.memoraType) && (parsed.data.memoraWikiSchema !== 1 || !parsed.data.memoraRevisionId))
        return null;
    return { frontmatter: parsed.data, bodyMarkdown: match[2]!, userFrontmatter: user.join("\n") };
}
export function sectionStart(id: string) { return `<!-- memora:section:${id}:start -->`; }
export function sectionEnd(id: string) { return `<!-- memora:section:${id}:end -->`; }
export function parseWikiRegions(body: string) {
    const normalized = normalizeProjectionText(body);
    const controls = outsideCodeFences(normalized);
    const start = controls.indexOf(wikiGeneratedStart), end = controls.indexOf(wikiGeneratedEnd);
    if (start < 0 || end < start || controls.indexOf(wikiGeneratedStart, start + 1) >= 0 || controls.indexOf(wikiGeneratedEnd, end + 1) >= 0 || normalized.slice(end + wikiGeneratedEnd.length).trim())
        return null;
    const editorial = normalized.slice(0, start), generated = normalized.slice(start);
    const maskedEditorial = controls.slice(0, start);
    const sections = [...maskedEditorial.matchAll(/<!-- memora:section:([0-9a-f-]{36}):start -->\n([\s\S]*?)\n<!-- memora:section:\1:end -->/g)];
    if (new Set(sections.map(s => s[1])).size !== sections.length || (maskedEditorial.match(/<!-- memora:section:/g)?.length ?? 0) !== sections.length * 2)
        return null;
    return { editorial, generated, sections: sections.map(s => ({ id: s[1]!, markdown: editorial.slice(s.index! + sectionStart(s[1]!).length + 1, s.index! + s[0].length - sectionEnd(s[1]!).length - 1) })) };
}
export function safeWikiLabel(text: string) { return text.replace(/[\r\n\[\]|#<>]/g, " "); }
export function wikiLink(path: string | undefined, title: string, id: string, kind = "source") {
    return path ? `[[${path.replace(/\.md$/i, "").replace(/[\[\]|#]/g, char => `\\${char}`)}|${safeWikiLabel(title)}]]` : `[${safeWikiLabel(title)}](memora://open/${kind}/${encodeURIComponent(id)})`;
}
/** Mask fenced code without changing string offsets. Reserved markers inside examples are ordinary prose. */
export function outsideCodeFences(text: string): string {
    let fence: {
        char: string;
        size: number;
    } | null = null;
    return text.split('\n').map(line => { const token = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line); if (fence) {
        if (token && token[1]![0] === fence.char && token[1]!.length >= fence.size && !token[2]!.trim())
            fence = null;
        return ' '.repeat(line.length);
    } if (token) {
        fence = { char: token[1]![0]!, size: token[1]!.length };
        return ' '.repeat(line.length);
    } return line; }).join('\n');
}
export function markdownHeading(text: string) { return text.replace(/\\/g, "\\\\").replace(/([\[\]#<>*_])/g, "\\$1").replace(/\r?\n/g, " "); }
