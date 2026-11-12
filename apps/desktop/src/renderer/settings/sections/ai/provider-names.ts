import {
  createTranslator,
  supportedLanguageCodes,
  type MessageKey,
  type Translator
} from "@app/i18n";

import { settingsRegistryV2 } from "../../../../shared/settings-registry";
import { labelOf } from "../../settings-model";
import { providerEntryId, providerKinds, type ProviderKind } from "./ai-model";

/** The onboarding's name for a provider kind, stored when the person connects it there. */
const onboardingNameKey: Record<ProviderKind, MessageKey | null> = {
  "openai-codex": "settings.ai.openAiCodex",
  "openai-compatible": "settings.ai.openAiCompatible",
  google: null
};

const entryOf = (kind: ProviderKind) =>
  settingsRegistryV2.find((candidate) => candidate.id === providerEntryId(kind));

/**
 * The names a provider of this kind gets when the app names it, in any language: the AI section's
 * label for the kind and the onboarding's name. A provider the person named (or a model id, which
 * Settings saves as the name) is not among them.
 */
function defaultNamesOf(kind: ProviderKind): Set<string> {
  const names = new Set<string>();
  const entry = entryOf(kind);
  const onboarding = onboardingNameKey[kind];
  for (const code of supportedLanguageCodes) {
    const t = createTranslator(code);
    if (entry) names.add(labelOf(t, entry));
    if (onboarding) names.add(t(onboarding));
  }
  return names;
}

const defaultNames = new Map(providerKinds.map((kind) => [kind, defaultNamesOf(kind)] as const));

/**
 * A stored provider name to the name its kind has in this language, only for a name the app gave
 * (a default in any language): one name for such a provider in every section and every language.
 * A name the person typed, or a model id, stays as it was saved.
 */
export function providerNamesOf(
  t: Translator,
  providers: readonly { provider: string; displayName: string }[]
): Map<string, string> {
  const names = new Map<string, string>();
  for (const provider of providers) {
    const kind = providerKinds.find((candidate) => candidate === provider.provider);
    const entry = kind ? entryOf(kind) : undefined;
    if (kind && entry && defaultNames.get(kind)?.has(provider.displayName))
      names.set(provider.displayName, labelOf(t, entry));
  }
  return names;
}
