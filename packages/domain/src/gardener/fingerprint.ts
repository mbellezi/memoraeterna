import { z } from "zod";

/**
 * Content-only input fingerprints (F4 D9). A task fingerprints what it reads (content hashes,
 * ids, generations), never how it would process it: a model, prompt, runtime or setting is
 * provenance and never re-runs work. A task whose fingerprint equals the last successful one for
 * its (kind, subject) is skipped; a quarantined input waits until its fingerprint changes (D8).
 *
 * `@app/domain` has no hashing: the canonical text is built here and the caller digests it with
 * SHA-256 (`node:crypto` in the main process).
 */
export const gardenerFingerprintVersion = 1;

export const GardenerFingerprintSchema = z.string().regex(/^gf1:[0-9a-f]{64}$/u);

export type FingerprintPart =
  | string
  | number
  | boolean
  | null
  | readonly FingerprintPart[]
  | { readonly [key: string]: FingerprintPart };

/**
 * Field names that name provenance, not content. A fingerprint input that holds one is refused:
 * hashing a model or a setting would re-run every task when it changes (plan 4.3).
 */
export const provenanceFingerprintFields: readonly string[] = [
  "model",
  "modelId",
  "provider",
  "runtime",
  "prompt",
  "promptRevision",
  "promptFingerprint",
  "promptVersion",
  "parameters",
  "settings",
  "language",
  "contentLanguage",
  "deciderKey",
  "typerKey"
];

const provenance = new Set(provenanceFingerprintFields);

function canonical(part: FingerprintPart, path: string): string {
  if (part === null || typeof part === "boolean") return JSON.stringify(part);
  if (typeof part === "number") {
    if (!Number.isFinite(part)) throw new Error(`gardener_fingerprint_number:${path}`);
    return JSON.stringify(part);
  }
  if (typeof part === "string") return JSON.stringify(part);
  if (Array.isArray(part))
    return `[${(part as readonly FingerprintPart[]).map((item, index) => canonical(item, `${path}[${index}]`)).join(",")}]`;
  const record = part as { readonly [key: string]: FingerprintPart };
  const keys = Object.keys(record).sort();
  for (const key of keys)
    if (provenance.has(key)) throw new Error(`gardener_fingerprint_provenance:${path}.${key}`);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key]!, `${path}.${key}`)}`).join(",")}}`;
}

/** The text a fingerprint digests: version, kind and the inputs with sorted keys. */
export function canonicalFingerprintInput(kind: string, parts: FingerprintPart): string {
  if (!kind) throw new Error("gardener_fingerprint_kind");
  return `gf${gardenerFingerprintVersion}\n${kind}\n${canonical(parts, "$")}`;
}

/** The fingerprint of `parts` for `kind`, given a SHA-256 hex digest function. */
export function gardenerFingerprint(
  kind: string,
  parts: FingerprintPart,
  sha256Hex: (text: string) => string
): string {
  const digest = sha256Hex(canonicalFingerprintInput(kind, parts)).toLowerCase();
  return GardenerFingerprintSchema.parse(`gf${gardenerFingerprintVersion}:${digest}`);
}

/**
 * Whether a claimed task skips instead of running (D8, D9), given its fingerprint and the outcome
 * cache of its (kind, subject). An unknown fingerprint never skips: nothing proves the input is the
 * same, so a kind without a fingerprint runs every time (its failures still mark a quarantine).
 */
export function gardenerSkipReason(
  fingerprint: string | null,
  cached: {
    lastFingerprint: string | null;
    failedFingerprint: string | null;
    quarantinedAt: Date | string | null;
  } | null
): "same_input" | "quarantined" | null {
  if (fingerprint === null || cached === null) return null;
  if (cached.quarantinedAt !== null && cached.failedFingerprint === fingerprint)
    return "quarantined";
  // The input the last success read (also after a quarantined change was reverted to it).
  if (cached.lastFingerprint === fingerprint) return "same_input";
  return null;
}
