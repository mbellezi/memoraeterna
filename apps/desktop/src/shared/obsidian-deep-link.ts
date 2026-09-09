import { z } from "zod";
export const obsidianDeepLinkSchema = z.object({ kind: z.enum(['wiki', 'source']), id: z.string().uuid(), revision: z.string().uuid().optional(), evidence: z.string().uuid().optional(), relation: z.string().uuid().optional() }).strict();
export type ObsidianDeepLink = z.infer<typeof obsidianDeepLinkSchema>;
export function parseObsidianDeepLink(raw: string): ObsidianDeepLink | null { try {
    const url = new URL(raw);
    if (url.protocol !== 'memora:' || url.hostname !== 'open' || url.username || url.password || url.port || url.hash)
        return null;
    const [empty, kind, id, ...rest] = url.pathname.split('/');
    if (empty !== '' || rest.length)
        return null;
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
        if (!['revision', 'evidence', 'relation'].includes(key) || key in query)
            return null;
        query[key] = value;
    }
    if(kind==='source'&&(query.revision||query.evidence)||kind==='wiki'&&query.relation)return null;
    const result = obsidianDeepLinkSchema.safeParse({ kind, id, ...query });
    return result.success ? result.data : null;
}
catch {
    return null;
} }
