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
 * `objects.locate`: where an object is, in one read-only response. The contract is shaped to survive
 * the Topic Tree Engine (F2): `primaryPath` will gain topic placements in front of the source
 * chain, and `alsoIn` will list secondary topic placements; clients render both without change.
 */
export const objectLocateListLimit = 25;
/** Longest path the locator walks (a library root is never this deep). */
export const objectLocatePathLimit = 32;

export const ObjectRefSchema = z
  .object({ kind: ObjectKindSchema, id: z.string().uuid(), title: z.string() })
  .strict();
export type ObjectRef = z.infer<typeof ObjectRefSchema>;

/**
 * A reference in `alsoIn` or `citedBy`. `legacy` marks a pre-refactoring wiki page presented as a
 * topic, entity or question: its `id` is the wiki page ID and it disappears when the legacy wiki is
 * wiped (docs/plan.md F2).
 */
export const ObjectPlacementSchema = ObjectRefSchema.extend({ legacy: z.boolean() }).strict();
export type ObjectPlacement = z.infer<typeof ObjectPlacementSchema>;

export const ObjectLocateResultSchema = z
  .object({
    object: ObjectRefSchema,
    primaryPath: z.array(ObjectRefSchema).min(1).max(objectLocatePathLimit),
    alsoIn: z.array(ObjectPlacementSchema).max(objectLocateListLimit),
    citedBy: z.array(ObjectPlacementSchema).max(objectLocateListLimit),
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
