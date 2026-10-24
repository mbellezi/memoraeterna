// The writer and the record of the first-run end-to-end test (F4 T90): the credential a recording
// signs in with, and what a recording keeps next to its cassette for the replays to rebuild from.
//
// The credential of a Codex sign-in belongs to the Electron app (safeStorage) and is never copied
// out of it by this harness. A recording is given an OAuth credential in a file the person put
// outside the repository; the harness reads it, keeps it in memory and in the scratch profile's own
// store, and drops its refresh token: it never refreshes, so it cannot rotate the real one and sign
// the app out. The access token must outlive the run.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { OpenAiCodexCredential } from "../openai-codex-oauth.js";
import {
  RecordedFirstRunSchema,
  UsageError,
  codexMinimumRemainingMinutes,
  recordFileName
} from "./config.js";
import type { FirstRunConfig, RecordedFirstRun, WriterRoute } from "./config.js";
import type { FirstRunModelPlan } from "./models.js";

/** The refresh token the scratch profile holds: it refreshes nothing. */
export const harnessRefreshToken = "refresh-unavailable-in-the-first-run-harness";

/** A credential for a run that never calls the real provider (the replay, the self-test). */
export function placeholderCodexCredential(now: number): OpenAiCodexCredential {
  return {
    access: "placeholder-access-token",
    refresh: harnessRefreshToken,
    expires: now + 30 * 24 * 3_600_000,
    accountId: "placeholder-account"
  };
}

/**
 * The credential of a recording, from the file's content. Needs `access`, `expires` (milliseconds
 * since the epoch) and `accountId`; the refresh token, if any, is dropped. Refused when the access
 * token expires before the run could end. The error never carries a token.
 */
export function parseCodexCredentialFile(
  content: string,
  file: string,
  now: number,
  minimumRemainingMs = codexMinimumRemainingMinutes * 60_000
): OpenAiCodexCredential {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new UsageError(`${file} is not JSON`);
  }
  const value = (json ?? {}) as Record<string, unknown>;
  if (
    typeof value.access !== "string" ||
    value.access.length === 0 ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires) ||
    typeof value.accountId !== "string" ||
    value.accountId.length === 0
  )
    throw new UsageError(
      `${file} is not a Codex credential: it needs "access", "expires" (milliseconds) and "accountId"`
    );
  const remaining = value.expires - now;
  if (remaining < minimumRemainingMs)
    throw new UsageError(
      `The access token in ${file} ${remaining <= 0 ? "has expired" : `expires in ${Math.floor(remaining / 60_000)} minutes`}; ` +
        `a recording needs at least ${Math.round(minimumRemainingMs / 60_000)}. The harness never refreshes it ` +
        "(a refresh would rotate the real refresh token): sign in again and write a new file"
    );
  return {
    access: value.access,
    refresh: harnessRefreshToken,
    expires: value.expires,
    accountId: value.accountId,
    ...(typeof value.planType === "string" ? { planType: value.planType } : {})
  };
}

/** The credential file of a recording, read. */
export async function readCodexCredential(
  writer: Extract<WriterRoute, { kind: "codex" }>,
  now: number,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")
): Promise<OpenAiCodexCredential> {
  let content: string;
  try {
    content = await read(writer.credentialFile);
  } catch {
    throw new UsageError(`The credential file ${writer.credentialFile} could not be read`);
  }
  return parseCodexCredentialFile(content, writer.credentialFile, now);
}

/** The API key of a remote writer: a file, else the named environment variable; never a flag. */
export async function readApiKey(
  writer: Extract<WriterRoute, { kind: "remote" }>,
  env: Readonly<Record<string, string | undefined>>,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")
): Promise<string> {
  const key = writer.apiKeyFile
    ? (await read(writer.apiKeyFile)).trim()
    : env[writer.apiKeyEnv]?.trim();
  if (!key)
    throw new UsageError(
      `The writer's API key is not set: put it in $${writer.apiKeyEnv}${writer.apiKeyFile ? ` or in ${writer.apiKeyFile}` : ""} ` +
        "(a keyless local server takes any placeholder value)"
    );
  return key;
}

/** What a cassette was recorded with, read next to it. */
export async function readRecordedFirstRun(
  cassetteDir: string,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")
): Promise<RecordedFirstRun> {
  const file = join(cassetteDir, recordFileName);
  let content: string;
  try {
    content = await read(file);
  } catch {
    throw new UsageError(
      `${file} is missing: the cassette was not recorded by this harness (run it with --mode record first)`
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new UsageError(`${file} is not JSON`);
  }
  const parsed = RecordedFirstRunSchema.safeParse(json);
  if (!parsed.success)
    throw new UsageError(`${file} is not a first-run record: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** Keeps the record beside the cassette (only a passing recording does). */
export async function writeRecordedFirstRun(
  cassetteDir: string,
  record: RecordedFirstRun
): Promise<string> {
  const file = join(cassetteDir, recordFileName);
  await mkdir(cassetteDir, { recursive: true });
  await writeFile(file, `${JSON.stringify(RecordedFirstRunSchema.parse(record), null, 2)}\n`);
  return file;
}

/**
 * A replay makes the requests of the recording: its sources, its content language and the ranker it
 * installed must be the ones the cassette holds. Throws a usage error naming the first difference.
 */
export function checkRecordMatches(
  record: RecordedFirstRun,
  config: Pick<FirstRunConfig, "sources" | "synthetic">,
  plan: FirstRunModelPlan
): void {
  if (record.synthetic !== config.synthetic)
    throw new UsageError(
      record.synthetic
        ? "The cassette is the self-test's, not the live record: replay it with --synthetic"
        : "The cassette is the live record: replay it without --synthetic"
    );
  for (const which of ["first", "second"] as const)
    if (record.sources[which] !== config.sources[which])
      throw new UsageError(
        `The cassette was recorded with the ${which} source ${record.sources[which]}, not ${config.sources[which]}: ` +
          `replay it with --${which}-source ${record.sources[which]}`
      );
  if (record.models.ranker.catalogId !== plan.ranker)
    throw new UsageError(
      `The cassette was recorded with the ranker ${record.models.ranker.catalogId}, but this machine installs ${plan.ranker}: ` +
        "record again on this machine, or replay on the machine that recorded it"
    );
  if (record.models.embedding.catalogId !== plan.embedding)
    throw new UsageError(
      `The cassette was recorded with the embedder ${record.models.embedding.catalogId}, not ${plan.embedding}`
    );
}
