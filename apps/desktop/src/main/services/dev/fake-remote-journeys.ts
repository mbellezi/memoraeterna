import { createRequire } from "node:module";

import { createAiConfigRepository, type Queryable } from "@app/db";
import { z } from "zod";

import { SoakKnobRefusal } from "./soak-refusal.js";

/**
 * The journeys mode of the DEV fake remote providers (F5 T155, J6).
 *
 * A journeys clone is BASE-J: its first run signed in a Codex writer (a stub credential) and routed
 * the write classes to it, so the fake remote's own safety check ("the soak reaches no real
 * provider", `fake-remote-install.ts`) refuses the profile and Ask cannot reach the fake that
 * answers `class:answer`. The harness names that one configuration in
 * `MEMORA_JOURNEYS_ADMIT_WRITER=<provider configuration id>`, and the check lets exactly it
 * through, as `MEMORA_SOAK_REAL_WRITER` does for a soak (`soak-real-writer.ts`): the configuration
 * must exist, be a Codex one and hold a credential, and every other real provider is still refused.
 * The journey runs with no cassette and with the clone's automation paused, so no job calls the
 * writer; an Ask is answered by the fake.
 *
 * It is switched on only by that variable, it is refused in a packaged build (as `MEMORA_FAKE_REMOTE`
 * is, and a build whose packaging cannot be read counts as packaged), and with the variable unset
 * nothing about the fake remote changes.
 */

export const journeysAdmitWriterKnobName = "MEMORA_JOURNEYS_ADMIT_WRITER";

type Env = Readonly<Record<string, string | undefined>>;

export interface JourneysAdmission {
  /** The id of the Codex provider configuration the check lets through. */
  providerConfigId: string;
}

/**
 * Reads `MEMORA_JOURNEYS_ADMIT_WRITER`: null when unset; refused when packaged and for a value that
 * is not a provider configuration id.
 */
export function readJourneysAdmission(
  env: Env,
  options: { isPackaged: boolean }
): JourneysAdmission | null {
  const raw = env[journeysAdmitWriterKnobName]?.trim();
  if (!raw) return null;
  if (options.isPackaged)
    throw new SoakKnobRefusal(
      "packaged",
      `${journeysAdmitWriterKnobName} is refused in packaged builds`
    );
  if (!z.string().uuid().safeParse(raw).success)
    throw new SoakKnobRefusal(
      "invalidValue",
      `${journeysAdmitWriterKnobName} must be the id of a Codex provider configuration (a UUID)`
    );
  return { providerConfigId: raw.toLowerCase() };
}

/**
 * Whether the running app is a packaged build, read from Electron when it is the host. Anything that
 * cannot be read counts as packaged, so the mode is refused rather than admitted by accident.
 */
export function appIsPackaged(): boolean {
  try {
    const electron = createRequire(import.meta.url)("electron") as unknown;
    if (typeof electron !== "object" || electron === null) return true;
    return (electron as { app?: { isPackaged?: unknown } }).app?.isPackaged !== false;
  } catch {
    return true;
  }
}

/**
 * The provider configurations the fake remote's reach check lets through besides the fakes: none
 * unless the journeys variable names one, and then only a Codex configuration that holds a
 * credential in this profile (a stub credential, in BASE-J).
 */
export async function journeysAdmittedConfigIds(
  db: Queryable,
  env: Env,
  options: { isPackaged: boolean }
): Promise<string[]> {
  const admission = readJourneysAdmission(env, options);
  if (!admission) return [];
  const config = (await createAiConfigRepository(db).listProviders()).find(
    (provider) => provider.id === admission.providerConfigId
  );
  if (!config)
    throw new SoakKnobRefusal(
      "realWriter",
      `${journeysAdmitWriterKnobName} names no provider configuration in this profile`
    );
  if (config.provider !== "openai-codex" || !config.credentialRef)
    throw new SoakKnobRefusal(
      "realWriter",
      `${journeysAdmitWriterKnobName} names a configuration that is not a signed-in Codex writer`
    );
  return [config.id];
}
