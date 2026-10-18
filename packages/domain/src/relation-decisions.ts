// The OpenAI Decisions API as an opt-in relation decider (F3 plan decision 30): the settings it
// keeps, the reasons the matcher falls back to the local ranker, the presets that may offer it and
// the status Settings shows. Pure: the main process reads and writes the settings.
import { z } from "zod";

import type { AiPresetMode } from "./ai-presets.js";

/** `{ enabled }`: off until the person turns it on after reading the privacy notice. */
export const relationsDecisionsSettingKey = "relations.decisions";
/**
 * The reference of the OpenAI Platform key in the secure store (Electron `safeStorage`): a fixed
 * reference, so the key survives a library reset that clears the settings. Only this reference is
 * ever stored in the database, never the key.
 */
export const relationsDecisionsCredentialRef = "ai:decisions-openai-platform";
/** `{ day, inputTokens, requests }`: the spend of the local day, from the provider's usage. */
export const relationsDecisionsSpendSettingKey = "relations.decisions.dailySpend";
/** `{ keyInvalid, lastUsedAt, fallback }`: what the last use found, for the status. */
export const relationsDecisionsStateSettingKey = "relations.decisions.state";

/** The presets that may offer the decider: never the Local preset, never a custom setup. */
export const decisionsDeciderPresets = ["hybrid", "cloud"] as const;

export function decisionsAvailableInPreset(preset: AiPresetMode | null): boolean {
  return preset === "hybrid" || preset === "cloud";
}

export const DecisionsSettingSchema = z.object({ enabled: z.boolean() }).strict();
export type DecisionsSetting = z.infer<typeof DecisionsSettingSchema>;

/**
 * Why the local ranker decides although the person turned the Decisions decider on: the key is
 * missing or the provider refused it, the day's spend cap is reached, the provider's billing quota
 * is exhausted, its lane's circuit breaker is open, the network failed, or another failure.
 */
export const decisionsFallbackReasons = [
  "no_key",
  "invalid_key",
  "spend_cap",
  "quota",
  "breaker_open",
  "network",
  "error"
] as const;
export const DecisionsFallbackReasonSchema = z.enum(decisionsFallbackReasons);
export type DecisionsFallbackReason = z.infer<typeof DecisionsFallbackReasonSchema>;

export const DecisionsStoredStateSchema = z
  .object({
    /** The provider answered 401 or 403 to the stored key; cleared when a key is saved or tested. */
    keyInvalid: z.boolean().default(false),
    lastUsedAt: z.iso.datetime().nullable().default(null),
    /** The last time the local ranker decided in its place, and why; null after a successful use. */
    fallback: z
      .object({ reason: DecisionsFallbackReasonSchema, at: z.iso.datetime() })
      .strict()
      .nullable()
      .default(null)
  })
  .strict();
export type DecisionsStoredState = z.infer<typeof DecisionsStoredStateSchema>;

/** The day's spend counter: input tokens, billed at the typed price (output is free). */
export const DecisionsDailySpendSchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    inputTokens: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative()
  })
  .strict();
export type DecisionsDailySpend = z.infer<typeof DecisionsDailySpendSchema>;

/**
 * What Settings shows. `unavailable_preset`: the setup is Local or Custom, where the decider is
 * not offered; `off`: available and not turned on; `ready`: it decides; `fallback`: it is on and
 * the local ranker decides, for `fallbackReason`. It never holds the key.
 */
export const decisionsStatusStates = ["off", "unavailable_preset", "ready", "fallback"] as const;
export const DecisionsStatusSchema = z
  .object({
    state: z.enum(decisionsStatusStates),
    enabled: z.boolean(),
    presetAllowed: z.boolean(),
    keyStored: z.boolean(),
    keyInvalid: z.boolean(),
    fallbackReason: DecisionsFallbackReasonSchema.nullable(),
    model: z.string().min(1),
    /** US$ per million input tokens, the typed price the spend is computed from. */
    priceInputPerMillionUsd: z.number().nonnegative(),
    spentTodayUsd: z.number().nonnegative(),
    dailyCapUsd: z.number().nonnegative(),
    requestsToday: z.number().int().nonnegative(),
    /** Whether a frozen calibration of this decider exists (it can apply); else it only suggests. */
    calibrated: z.boolean(),
    lastUsedAt: z.iso.datetime().nullable()
  })
  .strict();
export type DecisionsStatus = z.infer<typeof DecisionsStatusSchema>;
