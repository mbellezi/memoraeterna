import { z } from "zod";

import {
  ObjectAddressTextSchema,
  ObjectKindSchema,
  ObjectRefSchema,
  objectLocateTopicPathLimit
} from "./object-address.js";

/**
 * The objects read layer (F5 D11, docs/plan.md 4.5): what `objects.get`, `objects.resolveMany` and
 * `objects.backlinks` return for the five object kinds. Every shape here crosses the main to
 * renderer boundary, so every shape is a Zod schema; the stored data is never reshaped by them.
 */

/** The longest preview: plain text, never Markdown. */
export const objectPreviewMaxLength = 280;
/** The most addresses one `resolveMany` call resolves (one batch of hover and list rows). */
export const objectResolveManyMax = 200;
/** The most backlinks one page holds. */
export const objectBacklinksMaxLimit = 50;
/** The longest snippet of a backlink. */
export const objectBacklinkSnippetMaxLength = 160;

/** `current`: live; `retired`: kept but out of use; `redirected`: replaced, see `redirectTo`. */
export const objectStatuses = ["current", "retired", "redirected"] as const;
export const ObjectStatusSchema = z.enum(objectStatuses);
export type ObjectStatus = z.infer<typeof ObjectStatusSchema>;

/** One step of a path: a topic of the tree, from the first level down. */
export const PathSegmentSchema = ObjectRefSchema;
export type PathSegment = z.infer<typeof PathSegmentSchema>;

/**
 * What an object card, a hover or a quick look needs about one address. A title is empty when the
 * object has none to show (a topic that is not named yet); clients render their own label.
 * `counts` names the numbers that suit the kind: source (notes, passages), note (sources),
 * topic (notes, children), entity (notes), question (answers).
 */
export const ObjectSummarySchema = z
  .object({
    /** The canonical address of the request, anchor included. */
    address: ObjectAddressTextSchema,
    kind: ObjectKindSchema,
    title: z.string(),
    status: ObjectStatusSchema,
    /** A redirected topic names the live topic that replaced it. */
    redirectTo: ObjectAddressTextSchema.optional(),
    /** Plain text; the anchored passage when the address carries `passage` or `span`. */
    preview: z.string().max(objectPreviewMaxLength),
    language: z.string().min(1).max(16).optional(),
    /** ISO 8601, UTC. */
    updatedAt: z.string(),
    counts: z.record(z.string(), z.number().int().nonnegative()).optional()
  })
  .strict();
export type ObjectSummary = z.infer<typeof ObjectSummarySchema>;

export const ObjectGetInputSchema = z.object({ address: ObjectAddressTextSchema }).strict();
export type ObjectGetInput = z.infer<typeof ObjectGetInputSchema>;

export const ObjectMissingSchema = z.object({ status: z.literal("missing") }).strict();
export const ObjectGetResultSchema = z.union([ObjectSummarySchema, ObjectMissingSchema]);
export type ObjectGetResult = z.infer<typeof ObjectGetResultSchema>;

export const ObjectResolveManyInputSchema = z
  .object({
    addresses: z
      .array(ObjectAddressTextSchema)
      .max(objectResolveManyMax)
      .refine((addresses) => new Set(addresses).size === addresses.length, {
        message: "Addresses must be unique."
      }),
    include: z.object({ path: z.boolean().optional() }).strict().optional()
  })
  .strict();
export type ObjectResolveManyInput = z.input<typeof ObjectResolveManyInputSchema>;

/** The summary of one address; `path` (the topics above it) only when the request asked for it. */
export const ObjectResolvedSchema = ObjectSummarySchema.extend({
  path: z.array(PathSegmentSchema).max(objectLocateTopicPathLimit).optional()
}).strict();
export type ObjectResolved = z.infer<typeof ObjectResolvedSchema>;

/** Items are keyed by the address string of the request; `missing` lists the ones with no object. */
export const ObjectResolveManyResultSchema = z
  .object({
    items: z.record(z.string(), ObjectResolvedSchema),
    missing: z.array(z.string()).max(objectResolveManyMax)
  })
  .strict();
export type ObjectResolveManyResult = z.infer<typeof ObjectResolveManyResultSchema>;

/**
 * How an object links to another, in the order `backlinks` lists them (the cursor keeps the
 * position): a note resting on a source passage (evidence), a shown relation between notes, a
 * visible relation between sources, a topic overview citing a note, an Ask answer citing an
 * object, and a note mentioning an entity.
 */
export const backlinkVias = [
  "evidence",
  "relation",
  "source_relation",
  "overview_citation",
  "question_citation",
  "mention"
] as const;
export const BacklinkViaSchema = z.enum(backlinkVias);
export type BacklinkVia = z.infer<typeof BacklinkViaSchema>;

/** An anchor inside the linked object, as the address fragment without `#`: `passage=<uuid>`. */
const anchorPart = String.raw`(?:passage|span|section|relation)=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
export const BacklinkAnchorSchema = z
  .string()
  .regex(new RegExp(`^${anchorPart}(?:&${anchorPart})*$`, "i"));

export const ObjectBacklinksInputSchema = z
  .object({
    address: ObjectAddressTextSchema,
    limit: z.number().int().min(1).max(objectBacklinksMaxLimit).default(objectBacklinksMaxLimit),
    cursor: z.string().min(1).max(300).optional()
  })
  .strict();
export type ObjectBacklinksInput = z.input<typeof ObjectBacklinksInputSchema>;

/** One link into the object: the address that links, how, where inside it, and a bounded excerpt. */
export const ObjectBacklinkSchema = z
  .object({
    from: ObjectAddressTextSchema,
    via: BacklinkViaSchema,
    anchor: BacklinkAnchorSchema.optional(),
    snippet: z.string().max(objectBacklinkSnippetMaxLength).optional()
  })
  .strict();
export type ObjectBacklink = z.infer<typeof ObjectBacklinkSchema>;

export const ObjectBacklinksResultSchema = z
  .object({
    items: z.array(ObjectBacklinkSchema).max(objectBacklinksMaxLimit),
    /** Present when more exist; pass it back as `cursor` for the next page. */
    next: z.string().optional()
  })
  .strict();
export type ObjectBacklinksResult = z.infer<typeof ObjectBacklinksResultSchema>;

/**
 * The position of a backlinks page: the arm (an index into `backlinkVias`), the creation time with
 * microseconds (the database's own precision) and the row's ID. Pages are ordered by arm, then
 * newest first, so a row added after the first page lands before the cursor and never shifts the
 * rows after it.
 */
export const BacklinkCursorSchema = z
  .object({
    arm: z
      .number()
      .int()
      .min(0)
      .max(backlinkVias.length - 1),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u),
    id: z.string().uuid()
  })
  .strict();
export type BacklinkCursor = z.infer<typeof BacklinkCursorSchema>;

export function encodeBacklinkCursor(cursor: BacklinkCursor): string {
  return btoa(JSON.stringify(BacklinkCursorSchema.parse(cursor)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** The cursor a page handed out, or null when the text is not one (callers reject the request). */
export function decodeBacklinkCursor(text: string): BacklinkCursor | null {
  try {
    const padded = text.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = BacklinkCursorSchema.safeParse(
      JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Markdown as plain text for a preview or a snippet: no markers, links reduced to their text,
 * whitespace collapsed, cut to `max` characters with an ellipsis. It reads only what it is given
 * (callers bound the input), never fails and never keeps a half character.
 */
export function plainText(markdown: string, max: number): string {
  const text = markdown
    // An escaped marker is text: it is parked in the private use area while the markers go.
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/gu, (_, mark: string) =>
      String.fromCodePoint(0xe000 + mark.charCodeAt(0))
    )
    .replace(/```[^\n]*\n?/gu, "\n")
    .replace(/^ {0,3}(?:[-*_]\s*){3,}$/gmu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/gu, "$1")
    .replace(/\[\^[^\]]*\]/gu, "")
    .replace(/<(https?:\/\/[^>\s]+)>/gu, "$1")
    .replace(/<\/?[a-z][^>]*>/giu, " ")
    .replace(/^ {0,3}#{1,6}\s+/gmu, "")
    .replace(/^ {0,3}>\s?/gmu, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gmu, "")
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/gmu, " ")
    .replace(/\|/gu, " ")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/gu, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/gu, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?![\w])/gu, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/gu, "$1")
    .replace(/`+([^`]*)`+/gu, "$1")
    // A marker whose partner was cut off with the rest of the text.
    .replace(/\*\*|~~/gu, "")
    .replace(/[-]/gu, (parked) => String.fromCharCode(parked.charCodeAt(0) - 0xe000))
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(text);
  if (characters.length <= max) return text;
  return `${characters
    .slice(0, Math.max(0, max - 1))
    .join("")
    .trimEnd()}…`;
}
