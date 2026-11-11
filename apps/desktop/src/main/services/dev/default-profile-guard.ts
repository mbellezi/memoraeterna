import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * F5 D25 (T111): an unpackaged build never changes the owner's everyday profile by accident.
 *
 * Two refusals, both decided here so a table test can cover them without Electron or PostgreSQL:
 * - `MEMORA_USER_DATA_DIR` set to a blank or relative value (it used to fall back to the default
 *   userData silently, or to resolve against `apps/desktop`);
 * - pending migrations on the default userData of an unpackaged build, unless the owner says so with
 *   the knob below.
 */

/** `EX_CONFIG` of `sysexits.h`: the environment names a configuration the app will not start with. */
export const userDataOverrideRefusedExitCode = 78;

/** The owner's explicit consent to upgrade the default profile from an unpackaged build. */
export const allowDefaultProfileUpgradeKnob = "MEMORA_ALLOW_DEFAULT_PROFILE_UPGRADE";

export type UserDataOverrideDecision =
  | { readonly ok: true; readonly path?: string }
  | { readonly ok: false; readonly reason: "blank" | "relative" };

/** An unset variable keeps the default; a set one must be an absolute path (returned resolved). */
export function decideUserDataOverride(raw: string | undefined): UserDataOverrideDecision {
  if (raw === undefined) return { ok: true };
  const value = raw.trim();
  if (value === "") return { ok: false, reason: "blank" };
  if (!isAbsolute(value)) return { ok: false, reason: "relative" };
  return { ok: true, path: resolve(value) };
}

/** The stderr line of a refusal. It never carries the value: a path can hold a name or a token. */
export function describeUserDataOverrideRefusal(reason: "blank" | "relative"): string {
  return `MEMORA_USER_DATA_DIR is ${reason === "blank" ? "blank" : "not an absolute path"}; refusing to start (exit ${userDataOverrideRefusedExitCode}).`;
}

/**
 * Whether `userDataPath` is the default userData: same real path (symlinks resolved, a trailing
 * slash gone), compared without case on the platforms whose file systems fold it. A path that does
 * not exist yet resolves through its nearest existing parent, so a fresh machine compares right.
 */
export async function isDefaultUserData(input: {
  readonly userDataPath: string;
  readonly defaultUserDataPath: string;
  readonly platform: NodeJS.Platform;
}): Promise<boolean> {
  const [userData, defaultUserData] = await Promise.all([
    canonicalProfilePath(input.userDataPath, input.platform),
    canonicalProfilePath(input.defaultUserDataPath, input.platform)
  ]);
  return userData === defaultUserData;
}

export type DefaultProfileStartDecision =
  | { readonly start: true }
  | { readonly start: false; readonly reason: "pending-migrations-on-default-profile" };

/**
 * Whether the database may apply its migrations. Migrations are pending when the history's newest
 * `created_at` is older than the journal's last `when` (Drizzle's own rule); a history with no rows
 * is a fresh profile, which starts.
 */
export function decideDefaultProfileStart(input: {
  readonly isPackaged: boolean;
  readonly isDefault: boolean;
  readonly knob: string | undefined;
  readonly history: { readonly maxCreatedAt: number | null };
  readonly journalLastWhen: number;
}): DefaultProfileStartDecision {
  if (input.isPackaged || !input.isDefault) return { start: true };
  if (input.knob === "1") return { start: true };
  if (input.history.maxCreatedAt === null) return { start: true };
  if (input.history.maxCreatedAt >= input.journalLastWhen) return { start: true };
  return { start: false, reason: "pending-migrations-on-default-profile" };
}

/** Raised by the database service before any migration runs; its status carries the copy key. */
export class DefaultProfileUpgradeRefusedError extends Error {
  public readonly reason = "pending-migrations-on-default-profile" as const;

  public constructor() {
    super(
      `Refusing to apply pending migrations to the default profile of an unpackaged build; set ${allowDefaultProfileUpgradeKnob}=1 to upgrade it on purpose.`
    );
    this.name = "DefaultProfileUpgradeRefusedError";
  }
}

async function canonicalProfilePath(path: string, platform: NodeJS.Platform): Promise<string> {
  const real = await realpathOfExistingPrefix(resolve(path));
  return platform === "darwin" || platform === "win32" ? real.normalize("NFC").toLowerCase() : real;
}

async function realpathOfExistingPrefix(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await realpathOfExistingPrefix(parent), basename(path));
  }
}
