import { z } from "zod";

/**
 * The local view history crosses the preload boundary: these browser-safe schemas validate every
 * request and answer on both sides. The history is convenience state kept on this machine only.
 */

/** The object kinds that have a stable `memora://<kind>/<uuid>` address. */
export const objectKinds = ["source", "note", "topic", "question", "entity"] as const;
export const objectKindSchema = z.enum(objectKinds);
export type ObjectKind = z.infer<typeof objectKindSchema>;

/** Read and write bounds; the stored retention bound lives with the repository. */
export const viewHistoryBounds = { titleCharacters: 300, listDefault: 10, listMax: 50 } as const;

const addressPattern = new RegExp(
  `^memora://(${objectKinds.join("|")})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
  "iu"
);

export function formatObjectAddress(kind: ObjectKind, id: string): string {
  return `memora://${kind}/${id}`;
}

/** The kind and ID of an object address; `null` for anything that is not one. */
export function parseObjectAddress(address: string): { kind: ObjectKind; id: string } | null {
  const match = addressPattern.exec(address);
  return match
    ? { kind: match[1]!.toLowerCase() as ObjectKind, id: match[2]!.toLowerCase() }
    : null;
}

export const objectAddressSchema = z
  .string()
  .refine((value) => parseObjectAddress(value) !== null)
  .transform((value) => value.toLowerCase());

/** A title is one trimmed line; a longer one is cut to the stored bound instead of refused. */
const titleSchema = z
  .string()
  .transform((value) => value.replace(/\s+/gu, " ").trim())
  .pipe(z.string().min(1))
  .transform((value) => Array.from(value).slice(0, viewHistoryBounds.titleCharacters).join(""));

export const viewHistoryRecordInputSchema = z
  .object({
    kind: objectKindSchema,
    id: z.string().uuid(),
    title: titleSchema,
    parentAddress: objectAddressSchema.optional()
  })
  .strict()
  .refine((input) => input.parentAddress !== formatObjectAddress(input.kind, input.id), {
    message: "An object is not its own host.",
    path: ["parentAddress"]
  });

export const viewHistoryListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(viewHistoryBounds.listMax).optional(),
    kinds: z.array(objectKindSchema).max(objectKinds.length).optional()
  })
  .strict();

export const viewHistoryPinInputSchema = z
  .object({ address: objectAddressSchema, pinned: z.boolean() })
  .strict();

export const viewHistoryEntrySchema = z
  .object({
    address: objectAddressSchema,
    kind: objectKindSchema,
    id: z.string().uuid(),
    title: z.string().min(1).max(viewHistoryBounds.titleCharacters),
    parentAddress: objectAddressSchema.nullable(),
    openedAt: z.string().datetime(),
    openCount: z.number().int().min(1),
    pinned: z.boolean()
  })
  .strict();

export type ViewHistoryRecordInput = z.input<typeof viewHistoryRecordInputSchema>;
export type ViewHistoryListInput = z.input<typeof viewHistoryListInputSchema>;
export type ViewHistoryEntry = z.infer<typeof viewHistoryEntrySchema>;
