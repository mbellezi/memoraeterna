import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HardwareProfileSchema, type HardwareProfile } from "@app/domain";
import { z } from "zod";

/**
 * The cached hardware profile (F4 D32, T97; spike 6.3): a JSON file under `userData/hardware`, never
 * in PostgreSQL, so a restored backup cannot carry another machine's profile. It holds the allowlisted
 * profile and a fingerprint of the facts Node reads without a command; a changed fingerprint (a new
 * OS release, a memory change, another CPU), a profile older than 30 days or a "Re-detect" probes
 * again. A profile that is incomplete is never written.
 */
export const hardwareProfileFileName = "profile-v1.json";
export const hardwareProfileMaxAgeMs = 30 * 24 * 60 * 60 * 1000;

const CachedProfileSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    profile: HardwareProfileSchema
  })
  .strict();
export type CachedProfile = z.infer<typeof CachedProfileSchema>;

/** The facts Node reads in well under 5 ms, recomputed at every start. */
export interface CheapFacts {
  platform: string;
  osRelease: string;
  processArch: string;
  memoryBytes: number;
  cpuModel: string | null;
}

export function hardwareFingerprint(facts: CheapFacts): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        facts.platform,
        facts.osRelease,
        facts.processArch,
        facts.memoryBytes,
        facts.cpuModel
      ])
    )
    .digest("hex");
}

export function hardwareProfilePath(userDataPath: string): string {
  return join(userDataPath, "hardware", hardwareProfileFileName);
}

/** The cached profile, or null when the file is missing, unreadable or outside the contract. */
export async function readProfileCache(userDataPath: string): Promise<CachedProfile | null> {
  try {
    const text = await readFile(hardwareProfilePath(userDataPath), "utf8");
    const parsed = CachedProfileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Whole or not at all: a reader never sees a half-written profile. */
export async function writeProfileCache(
  userDataPath: string,
  fingerprint: string,
  profile: HardwareProfile
): Promise<void> {
  const path = hardwareProfilePath(userDataPath);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const document: CachedProfile = CachedProfileSchema.parse({ version: 1, fingerprint, profile });
  await mkdir(join(userDataPath, "hardware"), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(document, null, 2), "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The cache answers when it is for this machine's fingerprint, complete and not past its age. */
export function cacheIsCurrent(
  cached: CachedProfile,
  fingerprint: string,
  now: Date,
  maxAgeMs: number = hardwareProfileMaxAgeMs
): boolean {
  const age = now.getTime() - Date.parse(cached.profile.probedAt);
  return (
    cached.fingerprint === fingerprint && cached.profile.complete && age >= 0 && age <= maxAgeMs
  );
}
