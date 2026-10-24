import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { createAiConfigRepository, createSettingsRepository, type Queryable } from "@app/db";
import { DecisionsSettingSchema, relationsDecisionsSettingKey } from "@app/domain";
import { z } from "zod";

import { insideSoakProfiles, type SoakPaths } from "./soak-data-root.js";
import { SoakKnobRefusal } from "./soak-refusal.js";

/**
 * The real Codex writer in a soak (F4 T89, spec 5.4) and the dormant admission of the Decisions
 * configuration (decision 32's remote check of C4).
 *
 * F3's soak never reached a real provider: its knobs refused any profile whose routes could, and its
 * fakes stood in for every remote class. The 7-day Hybrid soak must run the real Codex writer
 * (write-fast, write-quality, answer and the generative-decide `op:` routes), so
 * `MEMORA_SOAK_REAL_WRITER=<codex providerConfigId>` relaxes the three refusals for exactly that
 * configuration: the knob's own need for the fakes (`soak-plan.ts`), the setup's reach check
 * (`soak-setup.ts`) and the fakes' installation (`fake-remote-install.ts`) through the
 * `allowedConfigIds` of `findRealRemoteReach` (`soak-routes.ts`). Every other real provider is still
 * refused, as is a writer that is not a Codex OAuth configuration; the knob is honoured only
 * unpackaged and only on a profile under the data root's `profiles/`.
 *
 * The Decisions API is a second real provider: an opt-in decider with its own key. A soak refuses it
 * (stored opt-in or DEV knobs) unless `MEMORA_SOAK_ADMIT_DECISIONS=1` admits it for this run, which
 * needs the real writer, a profile whose plan allows Decisions (the 7-day soak's plan says `off`),
 * the DEV opt-in, a key file only its owner can read and a daily cap of at most the product's own
 * US$0.50. Off by default; nothing in the app sets it.
 */

export const realWriterKnobName = "MEMORA_SOAK_REAL_WRITER";
export const decisionsAdmitKnobName = "MEMORA_SOAK_ADMIT_DECISIONS";
/** The DEV knobs of the opt-in Decisions decider (`dev/decisions-dev-options.ts`). */
export const decisionsDevKnobs = [
  "MEMORA_RELATIONS_DECISIONS",
  "MEMORA_RELATIONS_DECISIONS_KEY_FILE",
  "MEMORA_RELATIONS_DECISIONS_CAP_USD"
] as const;
/** The product's own daily cap of the Decisions decider (US$), which an admission never exceeds. */
export const soakDecisionsCapMaxUsd = 0.5;

type Env = Readonly<Record<string, string | undefined>>;

export interface RealWriterSettings {
  /** The id of the Codex provider configuration whose profile is the soak's writer. */
  providerConfigId: string;
}

export interface RealWriterEnvironment {
  isPackaged: boolean;
  /** The profile folder the app runs on. */
  userDataPath: string;
  paths: SoakPaths;
}

/**
 * Reads `MEMORA_SOAK_REAL_WRITER`: null when unset; refused when packaged, for a value that is not
 * a provider configuration id, and on a profile that is not inside the data root's `profiles/`.
 */
export function readRealWriterKnob(
  env: Env,
  options: RealWriterEnvironment
): RealWriterSettings | null {
  const raw = env[realWriterKnobName]?.trim();
  if (!raw) return null;
  if (options.isPackaged)
    throw new SoakKnobRefusal("packaged", `${realWriterKnobName} is refused in packaged builds`);
  if (!z.string().uuid().safeParse(raw).success)
    throw new SoakKnobRefusal(
      "invalidValue",
      `${realWriterKnobName} must be the id of a Codex provider configuration (a UUID)`
    );
  if (!insideSoakProfiles(options.userDataPath, options.paths))
    throw new SoakKnobRefusal(
      "outsideProfiles",
      `${realWriterKnobName} only runs on a clone inside the data root's profiles/ (set MEMORA_USER_DATA_DIR)`
    );
  return { providerConfigId: raw.toLowerCase() };
}

export interface DecisionsAdmission {
  /** The day's spend cap of this run (US$). */
  capUsd: number;
}

/**
 * Reads `MEMORA_SOAK_ADMIT_DECISIONS`: null when unset. Admitted only when packaged is false, the
 * value is `1`, the real writer is set, the plan profile allows Decisions, `MEMORA_RELATIONS_DECISIONS`
 * is `on`, a key file that only its owner can read is named and the cap is stated and at most
 * {@link soakDecisionsCapMaxUsd}. The key is never read here.
 */
export function readDecisionsAdmission(
  env: Env,
  options: {
    isPackaged: boolean;
    realWriter: RealWriterSettings | null;
    /** The plan profile's `f4.decisions`. */
    profileDecisions: "off" | "admitted";
  }
): DecisionsAdmission | null {
  const raw = env[decisionsAdmitKnobName]?.trim();
  if (!raw) return null;
  const refuse = (message: string) => new SoakKnobRefusal("decisions", message);
  if (options.isPackaged)
    throw new SoakKnobRefusal(
      "packaged",
      `${decisionsAdmitKnobName} is refused in packaged builds`
    );
  if (raw !== "1") throw refuse(`${decisionsAdmitKnobName} must be 1 (or unset)`);
  if (!options.realWriter)
    throw refuse(
      `${decisionsAdmitKnobName} needs ${realWriterKnobName}: it admits the remote check`
    );
  if (options.profileDecisions !== "admitted")
    throw refuse("This plan profile keeps the Decisions decider off");
  if (env.MEMORA_RELATIONS_DECISIONS !== "on")
    throw refuse(`${decisionsAdmitKnobName} needs MEMORA_RELATIONS_DECISIONS=on`);
  const cap = Number(env.MEMORA_RELATIONS_DECISIONS_CAP_USD);
  if (!(cap > 0 && cap <= soakDecisionsCapMaxUsd))
    throw refuse(
      `MEMORA_RELATIONS_DECISIONS_CAP_USD must state a daily cap above 0 and at most US$${soakDecisionsCapMaxUsd}`
    );
  const keyFile = env.MEMORA_RELATIONS_DECISIONS_KEY_FILE?.trim();
  if (!keyFile || !isAbsolute(keyFile))
    throw refuse("MEMORA_RELATIONS_DECISIONS_KEY_FILE must name the key file by its absolute path");
  try {
    const file = statSync(keyFile);
    if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error("unsafe");
  } catch {
    throw refuse(
      "MEMORA_RELATIONS_DECISIONS_KEY_FILE must be an existing file only its owner can read (mode 600)"
    );
  }
  return { capUsd: cap };
}

/** The DEV Decisions knobs set in `env`, which a soak that does not admit them refuses. */
export function decisionsKnobsSet(env: Env): string[] {
  return decisionsDevKnobs.filter((knob) => env[knob]?.trim());
}

/**
 * What the library's AI configuration says about the writer, as problems (empty when it is the one
 * Codex configuration the knob names): the configuration exists, is a Codex OAuth one and holds a
 * credential. No call is made; the setup's class tests make the one call that checks the token.
 */
export async function realWriterProblems(
  db: Queryable,
  writer: RealWriterSettings
): Promise<string[]> {
  const providers = await createAiConfigRepository(db).listProviders();
  const config = providers.find((provider) => provider.id === writer.providerConfigId);
  if (!config) return [`${realWriterKnobName} names no provider configuration in this profile`];
  const problems: string[] = [];
  if (config.provider !== "openai-codex")
    problems.push(
      `${realWriterKnobName} names a ${config.provider} configuration: only a Codex (ChatGPT OAuth) one is admitted`
    );
  if (!config.credentialRef)
    problems.push("The Codex configuration holds no sign-in: connect it in Settings first");
  return problems;
}

/**
 * The stored Decisions opt-in of the library (`relations.decisions`), as a problem when it is on
 * and the run does not admit the Decisions configuration: the decider would call the OpenAI
 * Platform with the stored key.
 */
export async function decisionsOptInProblem(
  db: Queryable,
  admitted: boolean
): Promise<string | null> {
  if (admitted) return null;
  const stored = DecisionsSettingSchema.safeParse(
    await createSettingsRepository(db).get(relationsDecisionsSettingKey)
  );
  return stored.success && stored.data.enabled
    ? "This profile has the Decisions decider switched on: a soak never calls the OpenAI Platform. Switch it off in Settings (or admit it with MEMORA_SOAK_ADMIT_DECISIONS for the remote check)."
    : null;
}
