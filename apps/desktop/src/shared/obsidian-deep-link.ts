import { z } from "zod";
/**
 * What a `memora://` link from Obsidian may open: `memora://open/{wiki|source}/<id>` (with the
 * fields its kind allows) and `memora://topic/<id>`, the object address every topic map carries.
 */
export const obsidianDeepLinkSchema = z
  .object({
    kind: z.enum(["wiki", "source", "topic"]),
    id: z.string().uuid(),
    revision: z.string().uuid().optional(),
    evidence: z.string().uuid().optional(),
    relation: z.string().uuid().optional()
  })
  .strict();
export type ObsidianDeepLink = z.infer<typeof obsidianDeepLinkSchema>;
export function parseObsidianDeepLink(raw: string): ObsidianDeepLink | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "memora:" || url.username || url.password || url.port || url.hash)
      return null;
    if (url.hostname === "topic") return parseTopicRoute(url);
    if (url.hostname !== "open") return null;
    const [empty, kind, id, ...rest] = url.pathname.split("/");
    // A topic has one spelling, `memora://topic/<id>`, not a second one under `open`.
    if (empty !== "" || rest.length || kind === "topic") return null;
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!["revision", "evidence", "relation"].includes(key) || key in query) return null;
      query[key] = value;
    }
    if (
      (kind === "source" && (query.revision || query.evidence)) ||
      (kind === "wiki" && query.relation)
    )
      return null;
    const result = obsidianDeepLinkSchema.safeParse({ kind, id, ...query });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
/** `memora://topic/<id>`: only the ID; a topic page has no query to carry and no anchor to open. */
function parseTopicRoute(url: URL): ObsidianDeepLink | null {
  const [empty, id, ...rest] = url.pathname.split("/");
  if (empty !== "" || !id || rest.length || url.search) return null;
  const result = obsidianDeepLinkSchema.safeParse({ kind: "topic", id: id.toLowerCase() });
  return result.success ? result.data : null;
}
