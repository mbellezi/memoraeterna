import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import type { PgPool } from "@app/db";

import type { LibraryResetResult } from "./library-reset-service.js";

/**
 * DEV-only measurement profile reset (`MEMORA_PROFILE_RESET=1`, F2 T22a). `scripts/topics/env-profiles.ts`
 * clones the stopped DEV profile into `.cache/profiles/<name>` (APFS clone, so model weights are not
 * duplicated) and starts the app once with this knob: it runs the Settings library reset, keeps the AI
 * routes, credentials and installed models, writes `profile-reset.json` and quits. A cloned profile
 * holds the owner's library, so the golden reset (which only empties golden sources) cannot do it.
 *
 * It is a one-shot like `MEMORA_LEGACY_WIPE`: refused when packaged, with any other DEV knob that
 * changes the library, with a value other than `1`, and unless the profile folder is inside
 * `<repository>/.cache/profiles/` after symbolic links are resolved, so the owner's own profile can
 * never be reset by it. It runs after the knowledge defaults and before the local models, the job
 * supervisor, the gateway and the vault reconcile start.
 */

export const profileResetKnob = "MEMORA_PROFILE_RESET";
export const profilesDirectory = [".cache", "profiles"] as const;
export const profileResetMarkerFile = "profile-reset.json";

/** DEV knobs that import, wipe or reset a library; the profile reset never runs beside one. */
export const profileResetConflictingKnobs = [
  "MEMORA_LEGACY_WIPE",
  "MEMORA_GOLDEN_RUN",
  "MEMORA_GOLDEN_SOURCE_PAIRS",
  "MEMORA_GOLDEN_RESET",
  "MEMORA_MATCHING_PILOT",
  "MEMORA_MATCHING_BENCHMARK"
] as const;

export type ProfileResetRefusalCode =
  | "packaged"
  | "invalidValue"
  | "conflictingKnob"
  | "outsideProfiles"
  | "notDevelopmentDatabase"
  | "notEmptied";

export class ProfileResetRefusal extends Error {
  public constructor(
    public readonly code: ProfileResetRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "ProfileResetRefusal";
  }
}

/** Reads the knob: false when unset or 0-like, true for exactly `1`; anything else is an error. */
export function readProfileResetKnob(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean }
): boolean {
  const raw = env[profileResetKnob]?.trim();
  if (!raw) return false;
  if (options.isPackaged)
    throw new ProfileResetRefusal("packaged", `${profileResetKnob} is refused in packaged builds`);
  if (raw !== "1")
    throw new ProfileResetRefusal("invalidValue", `${profileResetKnob} must be 1 (or unset)`);
  const others = profileResetConflictingKnobs.filter((name) => env[name]?.trim());
  if (others.length > 0)
    throw new ProfileResetRefusal(
      "conflictingKnob",
      `${profileResetKnob} cannot run with ${others.join(", ")}`
    );
  return true;
}

/**
 * True when `userDataPath` is a folder strictly inside `<workspaceRoot>/.cache/profiles/` once both
 * are resolved through symbolic links (a link out of the profiles folder does not count).
 */
export async function isMeasurementProfilePath(
  userDataPath: string,
  workspaceRoot: string
): Promise<boolean> {
  try {
    const profiles = await realpath(resolve(workspaceRoot, ...profilesDirectory));
    const profile = await realpath(resolve(userDataPath));
    const path = relative(profiles, profile);
    return path !== "" && !path.startsWith("..") && !isAbsolute(path);
  } catch {
    return false;
  }
}

const markerSchema = z
  .object({
    format: z.literal("memora-profile-reset"),
    version: z.literal(1),
    resetAt: z.string().min(1),
    contentLanguage: z.string().min(1),
    removed: z
      .object({
        sources: z.number().int().min(0),
        notes: z.number().int().min(0),
        files: z.number().int().min(0),
        failedFiles: z.number().int().min(0)
      })
      .strict(),
    library: z.object({ sources: z.number().int().min(0), notes: z.number().int().min(0) }).strict()
  })
  .strict();
export type ProfileResetMarker = z.infer<typeof markerSchema>;

/** Reads a profile's marker; null when the profile was never reset (or the file is unreadable). */
export async function readProfileResetMarker(
  userDataPath: string
): Promise<ProfileResetMarker | null> {
  try {
    const parsed = markerSchema.safeParse(
      JSON.parse(await readFile(join(userDataPath, profileResetMarkerFile), "utf8"))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface ProfileResetStartupOptions {
  env: Readonly<Record<string, string | undefined>>;
  isPackaged: boolean;
  userDataPath: string;
  workspaceRoot: string;
  pool: Pick<PgPool, "query">;
  /** The Settings reset (caches cleared, then `LibraryResetService.reset()`); nothing is started yet. */
  libraryReset: { reset(): Promise<LibraryResetResult> };
  /** The content language the profile ends with (settings are restored to their defaults). */
  readContentLanguage: () => Promise<string>;
  logger: Pick<Console, "info" | "error">;
  now?: () => Date;
}

async function countLibrary(pool: Pick<PgPool, "query">) {
  const result = await pool.query<{ sources: number; notes: number }>(
    `select (select count(*)::int from source_items) as sources,
            (select count(*)::int from atomic_notes) as notes`
  );
  return {
    sources: Number(result.rows[0]?.sources ?? 0),
    notes: Number(result.rows[0]?.notes ?? 0)
  };
}

/** The DEV PostgreSQL sidecar descriptor the golden runner also requires. */
async function requireDevelopmentDatabase(userDataPath: string): Promise<void> {
  const descriptor = z
    .object({ developmentOnly: z.literal(true) })
    .safeParse(
      JSON.parse(
        await readFile(join(userDataPath, "database", "dev-connection.json"), "utf8").catch(
          () => "{}"
        )
      )
    );
  if (!descriptor.success)
    throw new ProfileResetRefusal(
      "notDevelopmentDatabase",
      `${profileResetKnob} needs the DEV PostgreSQL sidecar (dev-connection.json)`
    );
}

/**
 * Runs at startup after the knowledge defaults. `continue` means a normal start (no knob); `quit`
 * means the reset ran or was refused and the app must quit now. The marker is written last, so its
 * presence means the library was verified empty.
 */
export async function runProfileResetStartup(
  options: ProfileResetStartupOptions
): Promise<"continue" | "quit"> {
  try {
    if (!readProfileResetKnob(options.env, { isPackaged: options.isPackaged })) return "continue";
    if (!(await isMeasurementProfilePath(options.userDataPath, options.workspaceRoot)))
      throw new ProfileResetRefusal(
        "outsideProfiles",
        `${profileResetKnob} only resets a profile inside .cache/profiles/ (set MEMORA_USER_DATA_DIR)`
      );
    await requireDevelopmentDatabase(options.userDataPath);
    // A marker from an earlier reset must not vouch for this one if it fails half way.
    await rm(join(options.userDataPath, profileResetMarkerFile), { force: true });
    const result = await options.libraryReset.reset();
    const library = await countLibrary(options.pool);
    if (library.sources > 0 || library.notes > 0)
      throw new ProfileResetRefusal(
        "notEmptied",
        `the library is not empty after the reset (${library.sources} sources, ${library.notes} notes)`
      );
    const marker: ProfileResetMarker = {
      format: "memora-profile-reset",
      version: 1,
      resetAt: (options.now ?? (() => new Date()))().toISOString(),
      contentLanguage: await options.readContentLanguage(),
      removed: {
        sources: result.deletedSources,
        notes: result.deletedAtomicNotes,
        files: result.deletedFiles,
        failedFiles: result.failedFiles
      },
      library
    };
    await writeMarker(options.userDataPath, marker);
    options.logger.info(`PROFILE_RESET ${JSON.stringify(marker)}`);
  } catch (error) {
    options.logger.error(`PROFILE_RESET refused: ${describeProfileResetError(error)}`);
  }
  return "quit";
}

async function writeMarker(userDataPath: string, marker: ProfileResetMarker): Promise<void> {
  await mkdir(userDataPath, { recursive: true });
  const target = join(userDataPath, profileResetMarkerFile);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`);
  await rename(temporary, target);
}

/** A one-line reason; connection strings are redacted. */
export function describeProfileResetError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]")
    .slice(0, 400);
}
