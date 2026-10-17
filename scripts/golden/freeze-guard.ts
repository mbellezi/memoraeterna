/**
 * The freeze guard of F3 decision D3. The fixture's held-out partition stays sealed until T58 writes
 * `.cache/f3/freeze/frozen.json` (config hash, calibration identity, parity scores, input hashes, UTC
 * time). Every script that prints or stores a held-out result asks this module first; before the freeze
 * it gets the reason to print instead, and only the evaluator's `--pre-freeze-feasibility` mode may
 * read held-out aggregates (it does not need the file).
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";

/** Workspace-relative location T58 writes. */
export const frozenFilePath = ".cache/f3/freeze/frozen.json";
/** Overrides the location (tests, a freeze kept outside the checkout). */
export const frozenFileEnvironmentVariable = "MEMORA_F3_FROZEN_FILE";

export const frozenSchema = z
  .object({
    /** Hash of the whole frozen configuration (instruction, template, rule, k, bands, escalation, ...). */
    configHash: z.string().min(8),
    /** The calibration identity the runtime must equal (decision R1). */
    calibrationIdentity: z.string().min(1),
    /** Parity scores recorded by the freeze (product adapter against the spike scorer). */
    parity: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]),
    /** Hashes of the inputs the freeze was computed from. */
    inputHashes: z.record(z.string(), z.string()),
    /** UTC instant of the freeze. */
    frozenAt: z.iso.datetime()
  })
  .passthrough();
export type Frozen = z.infer<typeof frozenSchema>;

export type HeldOutAccess = { open: true; frozen: Frozen } | { open: false; reason: string };

/** What a sealed report prints where the held-out result would be. */
export const sealedNotice = (reason: string): string =>
  `held-out sealed until the freeze (decision D3): ${reason}`;

export const frozenFileLocation = (env: NodeJS.ProcessEnv = process.env): string =>
  env[frozenFileEnvironmentVariable] || frozenFilePath;

/** A missing, unreadable or invalid `frozen.json` keeps the held-out partition sealed. */
export async function readHeldOutAccess(
  path: string = frozenFileLocation()
): Promise<HeldOutAccess> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { open: false, reason: `no ${path}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { open: false, reason: `${path} is not valid JSON` };
  }
  const result = frozenSchema.safeParse(parsed);
  if (!result.success) return { open: false, reason: `${path} is not a valid freeze record` };
  return { open: true, frozen: result.data };
}

/** For tools whose whole output is a held-out result: refuse instead of printing a redacted form. */
export function requireHeldOut(access: HeldOutAccess): Frozen {
  if (!access.open) throw new Error(sealedNotice(access.reason));
  return access.frozen;
}
