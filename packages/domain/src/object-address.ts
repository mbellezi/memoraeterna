import { z } from "zod";

/**
 * Object addresses: one stable, UUID-based reference for the five visible object kinds, shared by
 * the router, links, Cmd-K, Obsidian deep links and Back (docs/plan.md 4.5).
 *
 *   memora://<kind>/<uuid>[#passage=<chunkId>][&span=<sourceSpanId>][&section=<sectionId>]
 *
 * An address names an object by identity, never by title. Anchors point inside it: a chunk
 * (`passage`), a SourceSpan (`span`) or a section (`section`). The parser is strict (unknown kinds,
 * unknown or repeated anchors and malformed IDs are rejected) and the formatter is canonical, so
 * `parse(format(a))` equals `a`.
 */
export const objectKinds = ["source", "note", "topic", "question", "entity"] as const;
export const ObjectKindSchema = z.enum(objectKinds);
export type ObjectKind = z.infer<typeof ObjectKindSchema>;

/** Anchor names in canonical order. */
export const objectAnchorKeys = ["passage", "span", "section"] as const;
export type ObjectAnchorKey = (typeof objectAnchorKeys)[number];
export type ObjectAnchor = Partial<Record<ObjectAnchorKey, string>>;

export interface ObjectAddress {
  kind: ObjectKind;
  id: string;
  /** Present only when the address names at least one anchor. */
  anchor?: ObjectAnchor;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const addressPrefix = "memora://";
const maxAddressLength = 400;

function isKind(value: string): value is ObjectKind {
  return (objectKinds as readonly string[]).includes(value);
}

function isAnchorKey(value: string): value is ObjectAnchorKey {
  return (objectAnchorKeys as readonly string[]).includes(value);
}

function parseAnchor(fragment: string): ObjectAnchor | null {
  const anchor: ObjectAnchor = {};
  for (const part of fragment.split("&")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (!isAnchorKey(key) || key in anchor || !uuidPattern.test(value)) return null;
    anchor[key] = value.toLowerCase();
  }
  return Object.keys(anchor).length > 0 ? anchor : null;
}

/** Returns the address named by `value`, or null when it is not a well-formed object address. */
export function parseObjectAddress(value: string): ObjectAddress | null {
  if (value.length > maxAddressLength || !value.startsWith(addressPrefix)) return null;
  const rest = value.slice(addressPrefix.length);
  const hash = rest.indexOf("#");
  const path = hash === -1 ? rest : rest.slice(0, hash);
  const fragment = hash === -1 ? null : rest.slice(hash + 1);
  const segments = path.split("/");
  const [kind, id] = segments;
  if (segments.length !== 2 || !kind || !id || !isKind(kind) || !uuidPattern.test(id)) return null;
  if (fragment === null) return { kind, id: id.toLowerCase() };
  const anchor = parseAnchor(fragment);
  return anchor ? { kind, id: id.toLowerCase(), anchor } : null;
}

/** Formats an address canonically; throws on a malformed ID so an unparsable address never exists. */
export function formatObjectAddress(address: ObjectAddress): string {
  if (!isKind(address.kind) || !uuidPattern.test(address.id))
    throw new TypeError("Invalid object address.");
  const parts: string[] = [];
  for (const key of objectAnchorKeys) {
    const value = address.anchor?.[key];
    if (value === undefined) continue;
    if (!uuidPattern.test(value)) throw new TypeError("Invalid object address anchor.");
    parts.push(`${key}=${value.toLowerCase()}`);
  }
  const base = `${addressPrefix}${address.kind}/${address.id.toLowerCase()}`;
  return parts.length > 0 ? `${base}#${parts.join("&")}` : base;
}

/** A string that is a well-formed object address; used at every process boundary. */
export const ObjectAddressTextSchema = z
  .string()
  .max(maxAddressLength)
  .refine((value) => parseObjectAddress(value) !== null, { message: "Invalid object address." });

export const ObjectLocateInputSchema = z.object({ address: ObjectAddressTextSchema }).strict();
export type ObjectLocateInput = z.infer<typeof ObjectLocateInputSchema>;

/**
 * `objects.locate`: where an object is, in one read-only response (docs/f2-decisions.md D24).
 *
 * - `primaryPath` runs from the root of the topic tree down to the topic the object is placed in
 *   (a note by its own placement, a source by the placement of its root source), then along the
 *   source chain (root source to owning source); a note ends with itself. An object the tree does
 *   not hold yet has the source chain alone. The first entry of a path that starts with a topic is
 *   the tree root, which has no title.
 * - `alsoIn` lists the secondary topic placements of the object.
 * - `citedBy` lists the objects that cite it: other notes derived from a source today and, with
 *   the overviews (F2 T31), the topics whose overview cites it.
 *
 * A title is empty when the object has none to show: the tree root and a topic that is not named
 * yet. Clients render their own localized label (D11 stores no placeholder).
 */
export const objectLocateListLimit = 25;
/** Longest source chain the locator walks (a library root is never this deep). */
export const objectLocatePathLimit = 32;
/** Longest topic path: the root and the depth cap (`topicReadLimits.pathMax`, tested to match). */
export const objectLocateTopicPathLimit = 8;

export const ObjectRefSchema = z
  .object({ kind: ObjectKindSchema, id: z.string().uuid(), title: z.string() })
  .strict();
export type ObjectRef = z.infer<typeof ObjectRefSchema>;

/** A secondary placement: always a topic. */
export const ObjectTopicRefSchema = ObjectRefSchema.extend({ kind: z.literal("topic") }).strict();
export type ObjectTopicRef = z.infer<typeof ObjectTopicRefSchema>;

export const ObjectLocateResultSchema = z
  .object({
    object: ObjectRefSchema,
    primaryPath: z
      .array(ObjectRefSchema)
      .min(1)
      .max(objectLocatePathLimit + objectLocateTopicPathLimit),
    alsoIn: z.array(ObjectTopicRefSchema).max(objectLocateListLimit),
    citedBy: z.array(ObjectRefSchema).max(objectLocateListLimit),
    counts: z
      .object({
        /** Every placement the object has besides its primary path (the lists above are capped). */
        alsoIn: z.number().int().nonnegative(),
        citedBy: z.number().int().nonnegative(),
        /** Notes attached to a source; zero for a note. */
        notes: z.number().int().nonnegative(),
        /** Current chunks of a source, or the passages a note derives from. */
        passages: z.number().int().nonnegative(),
        /** Direct child sources of a source; zero for a note. */
        children: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();
export type ObjectLocateResult = z.infer<typeof ObjectLocateResultSchema>;
