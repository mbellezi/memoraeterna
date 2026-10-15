import {
  formatObjectAddress,
  ObjectKindSchema,
  objectKinds,
  parseObjectAddress,
  type ObjectAddress
} from "@app/domain";
import { z } from "zod";

/**
 * The local view history crosses the preload boundary: these browser-safe schemas validate every
 * request and answer on both sides. The history is convenience state kept on this machine only.
 * The kinds and the address grammar are the domain's (`@app/domain` object-address), never a copy.
 */

/** Read and write bounds; the stored retention bound lives with the repository. */
export const viewHistoryBounds = {
  titleCharacters: 300,
  /** Pins kept at most; the Recents list asks for every pin besides its recent entries. */
  pinMax: 10,
  /** Recent (unpinned) entries per read. */
  listDefault: 10,
  listMax: 50
} as const;

/** The error a pin past the cap is refused with (the database layer throws the same message). */
export const viewHistoryPinLimitMessage = "errors.viewHistory.pinLimit";

/** A history address names an object only: the table stores `memora://<kind>/<uuid>`, no anchor. */
function historyAddress(value: string): ObjectAddress | null {
  const address = parseObjectAddress(value);
  return address && address.anchor === undefined ? address : null;
}

export const objectAddressSchema = z
  .string()
  .refine((value) => historyAddress(value) !== null)
  .transform((value) => formatObjectAddress(historyAddress(value)!));

/** A title is one trimmed line; a longer one is cut to the stored bound instead of refused. */
const titleSchema = z
  .string()
  .transform((value) => value.replace(/\s+/gu, " ").trim())
  .pipe(z.string().min(1))
  .transform((value) => Array.from(value).slice(0, viewHistoryBounds.titleCharacters).join(""));

/**
 * A stored title is read back as it was written. The bound counts characters (code points), like
 * the input, the repository and the database check do, never UTF-16 units: a title with emoji that
 * fills the bound has more units than characters and must still parse.
 */
const storedTitleSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.length <= viewHistoryBounds.titleCharacters ||
      Array.from(value).length <= viewHistoryBounds.titleCharacters
  );

export const viewHistoryRecordInputSchema = z
  .object({
    kind: ObjectKindSchema,
    id: z.string().uuid(),
    title: titleSchema,
    parentAddress: objectAddressSchema.optional()
  })
  .strict()
  .refine(
    (input) => {
      // Runs even when another field was refused, so it must not assume the ID is well formed.
      const host = input.parentAddress ? parseObjectAddress(input.parentAddress) : null;
      return !(host && host.kind === input.kind && host.id === String(input.id).toLowerCase());
    },
    { message: "An object is not its own host.", path: ["parentAddress"] }
  );

export const viewHistoryListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(viewHistoryBounds.listMax).optional(),
    kinds: z.array(ObjectKindSchema).max(objectKinds.length).optional()
  })
  .strict();

export const viewHistoryPinInputSchema = z
  .object({ address: objectAddressSchema, pinned: z.boolean() })
  .strict();

export const viewHistoryEntrySchema = z
  .object({
    address: objectAddressSchema,
    kind: ObjectKindSchema,
    id: z.string().uuid(),
    title: storedTitleSchema,
    parentAddress: objectAddressSchema.nullable(),
    openedAt: z.string().datetime(),
    openCount: z.number().int().min(1),
    pinned: z.boolean()
  })
  .strict();

export type ViewHistoryRecordInput = z.input<typeof viewHistoryRecordInputSchema>;
export type ViewHistoryListInput = z.input<typeof viewHistoryListInputSchema>;
export type ViewHistoryEntry = z.infer<typeof viewHistoryEntrySchema>;
