// What a lint hands to `gardener_findings` (F4 D19, D29): a kind, a fingerprint that identifies the
// finding across audits (a finding found again updates its row, a dismissal persists), the objects
// it names as `memora://` addresses and scalar parameters. Findings carry no copy: the Inbox
// renders each kind from message keys and these parameters.
import { z } from "zod";

import { formatObjectAddress } from "../../object-address.js";
import type { ObjectKind } from "../../object-address.js";
import { ChangeSetRiskSchema, GardenerFindingKindSchema } from "../../change-sets.js";

/** The kinds AUDIT writes; `backlog` and `budget` come from MATCH and the RemoteBudget. */
export const lintFindingKinds = ["duplicate", "broken_link", "redirect_chain"] as const;
export const LintFindingKindSchema = z.enum(lintFindingKinds);
export type LintFindingKind = z.infer<typeof LintFindingKindSchema>;

/** Bounds the table's CHECK enforces. */
export const gardenerFindingLimits = {
  fingerprintMax: 200,
  objectRefsMax: 50,
  paramKeysMax: 20,
  paramTextMax: 200
} as const;

export const FindingParamsSchema = z
  .record(
    z.string().min(1).max(60),
    z.union([
      z.string().max(gardenerFindingLimits.paramTextMax),
      z.number().finite(),
      z.boolean(),
      z.null()
    ])
  )
  .refine((params) => Object.keys(params).length <= gardenerFindingLimits.paramKeysMax, {
    message: "A finding carries few parameters"
  });
export type FindingParams = z.infer<typeof FindingParamsSchema>;

export const GardenerFindingInputSchema = z
  .object({
    kind: GardenerFindingKindSchema,
    fingerprint: z.string().min(1).max(gardenerFindingLimits.fingerprintMax),
    objectRefs: z.array(z.string().min(1).max(400)).max(gardenerFindingLimits.objectRefsMax),
    params: FindingParamsSchema,
    risk: ChangeSetRiskSchema
  })
  .strict();
export type GardenerFindingInput = z.infer<typeof GardenerFindingInputSchema>;

/** A finding of a lint: the input of the repository, typed to the kinds a lint writes. */
export interface LintFinding extends GardenerFindingInput {
  kind: LintFindingKind;
}

/** The `memora://<kind>/<id>` address of an object. */
export function findingAddress(kind: ObjectKind, id: string): string {
  return formatObjectAddress({ kind, id });
}

/** Code-unit order of IDs: the same on every machine and locale. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The two IDs of a pair in one canonical order, so a pair found from either side is one finding. */
export function orderedPair(a: string, b: string): [string, string] {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left <= right ? [left, right] : [right, left];
}
