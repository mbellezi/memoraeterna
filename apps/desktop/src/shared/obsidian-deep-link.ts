import { z } from "zod";
import {
  formatObjectAddress,
  normalizeMemoraLink,
  ObjectAddressTextSchema,
  type NormalizedLink
} from "@app/domain";

/**
 * What a `memora://` link from outside may do (docs/f5-decisions.md D10): open one object, or say
 * that the page of the retired wiki it names is gone. The reading is `normalizeMemoraLink` in
 * `@app/domain`, the one reader of these links (the canonical address with its anchors, and the
 * legacy forms the Obsidian projections wrote); this module only gives the result the shape that
 * crosses to the renderer on `deepLinkOpen`. A link never opens a view, a setting or anything else.
 */
export const deepLinkSchema = z.discriminatedUnion("kind", [
  /** An object, by its canonical address (anchors included). */
  z.object({ kind: z.literal("object"), address: ObjectAddressTextSchema }).strict(),
  /** A page of the retired wiki: a notice, never a page. */
  z.object({ kind: z.literal("retired-wiki"), id: z.string().uuid() }).strict()
]);
export type DeepLink = z.infer<typeof deepLinkSchema>;

/** Why a link was refused (the reason alone is logged: the text of a link is not). */
export type DeepLinkRejection = Extract<NormalizedLink, { kind: "invalid" }>["reason"];

export type DeepLinkReading =
  { ok: true; link: DeepLink } | { ok: false; reason: DeepLinkRejection };

/** Reads a link from outside, or says why it was refused. */
export function readDeepLink(raw: string): DeepLinkReading {
  const link = normalizeMemoraLink(raw);
  if (link.kind === "invalid") return { ok: false, reason: link.reason };
  if (link.kind === "retired-wiki")
    return { ok: true, link: { kind: "retired-wiki", id: link.id } };
  return { ok: true, link: { kind: "object", address: formatObjectAddress(link.address) } };
}

/** The link, or null when it is not one the app opens. */
export function parseDeepLink(raw: string): DeepLink | null {
  const reading = readDeepLink(raw);
  return reading.ok ? reading.link : null;
}
