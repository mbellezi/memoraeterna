import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import {
  defaultUserDataPath,
  readMatchingProfile,
  type MatchingRunner
} from "../../apps/desktop/src/main/services/matching-profile.ts";

export { defaultUserDataPath };

/**
 * `--profile <absolute dir>` of the matching scripts (F5 D26, T112). A script names the scratch profile
 * it reads (its `matching-{pilot,benchmark}/` artifacts and its `database/dev-connection.json`); it
 * never falls back to the owner's DEV profile and never prints the connection descriptor.
 */

export class ProfileArgError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProfileArgError";
  }
}

export const profileArgUsage =
  "Pass --profile <absolute scratch profile directory> (inside .cache/profiles/ or .cache/f<N>/scratch/).";

function canonical(path: string): string {
  let resolved = resolve(path);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // A folder that does not exist yet is compared as written.
  }
  // macOS volumes are case-insensitive by default.
  return resolved.toLowerCase();
}

function overlaps(a: string, b: string): boolean {
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  };
  return inside(a, b) || inside(b, a);
}

export interface ParsedProfileArg {
  /** The absolute profile folder. */
  profile: string;
  /** `argv` without the `--profile` flag and its value. */
  rest: string[];
}

/**
 * Reads `--profile <dir>` or `--profile=<dir>` from `argv` (arguments after the script name). Throws
 * when it is missing, empty, repeated, relative, or the default userData folder (or inside, or above it).
 */
export function parseProfileArg(
  argv: readonly string[],
  options: { home?: string } = {}
): ParsedProfileArg {
  const rest: string[] = [];
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--profile") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new ProfileArgError(`--profile needs a directory. ${profileArgUsage}`);
      values.push(value);
      index += 1;
    } else if (arg.startsWith("--profile=")) values.push(arg.slice("--profile=".length));
    else rest.push(arg);
  }
  if (values.length === 0) throw new ProfileArgError(`--profile is required. ${profileArgUsage}`);
  if (values.length > 1) throw new ProfileArgError("--profile was given more than once.");
  const profile = values[0]!.trim();
  if (profile === "") throw new ProfileArgError(`--profile is empty. ${profileArgUsage}`);
  if (!isAbsolute(profile))
    throw new ProfileArgError(`--profile must be an absolute path. ${profileArgUsage}`);
  if (overlaps(canonical(profile), canonical(defaultUserDataPath(options.home))))
    throw new ProfileArgError("--profile refuses the default DEV userData folder.");
  return { profile: resolve(profile), rest };
}

const descriptorSchema = z.object({
  developmentOnly: z.literal(true),
  connectionString: z.string().min(1),
  psqlPath: z.string().min(1).optional()
});
export interface ProfileDescriptor {
  connectionString: string;
  psqlPath?: string;
}

/**
 * Reads `<profile>/database/dev-connection.json`: a DEV descriptor on a loopback host. Errors name the
 * problem only; neither the connection string nor any part of the file is ever put in a message.
 */
export async function readProfileDescriptor(profile: string): Promise<ProfileDescriptor> {
  let parsed: z.infer<typeof descriptorSchema>;
  try {
    parsed = descriptorSchema.parse(
      JSON.parse(await readFile(join(profile, "database", "dev-connection.json"), "utf8"))
    );
  } catch {
    throw new ProfileArgError(
      "The profile has no readable database/dev-connection.json for a DEV database."
    );
  }
  let host: string;
  try {
    host = new URL(parsed.connectionString).hostname;
  } catch {
    throw new ProfileArgError("The profile's connection descriptor is not a database URL.");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
    throw new ProfileArgError("The profile's database is not on a loopback host.");
  return {
    connectionString: parsed.connectionString,
    ...(parsed.psqlPath ? { psqlPath: parsed.psqlPath } : {})
  };
}

export interface MatchingScriptProfile {
  profilePath: string;
  /** `<profile>/matching-pilot` or `<profile>/matching-benchmark`. */
  outputDirectory: string;
  rest: string[];
}

/**
 * `--profile` for a matching script: parsed, then required to be a scratch profile (the same gate as the
 * runners), before the script reads or writes anything.
 */
export async function resolveMatchingScriptProfile(
  argv: readonly string[],
  runner: MatchingRunner,
  options: { home?: string; workspaceRoot?: string } = {}
): Promise<MatchingScriptProfile> {
  const { profile, rest } = parseProfileArg(argv, options);
  const matching = await readMatchingProfile({
    userDataPath: profile,
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    runner,
    ...(options.home === undefined ? {} : { home: options.home })
  });
  return { ...matching, rest };
}

/** The scripts' entry: the profile of this process, or a one-line message on stderr and exit 2. */
export async function scriptProfile(runner: MatchingRunner): Promise<MatchingScriptProfile> {
  try {
    return await resolveMatchingScriptProfile(process.argv.slice(2), runner);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
