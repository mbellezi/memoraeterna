/**
 * The design freeze for Spike A2. Everything tunable (instruction, wording, option semantics,
 * chunking) is fixed on the tuning split and recorded here before any held-out request is sent;
 * `run.ts` refuses to send held-out stages when the current design does not match this file.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { outputDirectory } from "./budget.js";
import { designFingerprint } from "./design.js";
import { loadFrozen } from "../reranker/dataset.js";

export const frozenDesignPath = join(outputDirectory, "frozen-design.json");

const frozenDesignSchema = z
  .object({
    fingerprint: z.string(),
    instructionId: z.string(),
    frozenAt: z.string(),
    thresholdBasis: z.string()
  })
  .strict();

export async function currentFingerprint(): Promise<{ id: string; fingerprint: string }> {
  const frozen = await loadFrozen();
  return { id: frozen.instructionId, fingerprint: designFingerprint(frozen.instruction) };
}

export async function writeFrozenDesign(): Promise<void> {
  const current = await currentFingerprint();
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    frozenDesignPath,
    `${JSON.stringify(
      {
        fingerprint: current.fingerprint,
        instructionId: current.id,
        frozenAt: new Date().toISOString(),
        thresholdBasis:
          "decision thresholds are computed from tuning scores only (zero forbidden root pairs, most expected pairs, midpoint of the plateau)"
      },
      null,
      2
    )}\n`
  );
}

/** Throws unless the design in the code is the one frozen on tuning. */
export async function assertDesignFrozen(): Promise<void> {
  let stored: z.infer<typeof frozenDesignSchema>;
  try {
    stored = frozenDesignSchema.parse(JSON.parse(await readFile(frozenDesignPath, "utf8")));
  } catch {
    throw new Error("Design not frozen: run `freeze.ts` after the tuning evaluation");
  }
  const current = await currentFingerprint();
  if (stored.fingerprint !== current.fingerprint) {
    throw new Error("The design changed after it was frozen; held-out stages must not run");
  }
}
