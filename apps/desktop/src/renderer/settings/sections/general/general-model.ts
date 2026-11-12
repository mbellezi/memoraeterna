import { getLanguageDisplayName, type LanguageCode } from "@app/i18n";

import { appLanguageCodes, themeModeSchema, type ThemeMode } from "../../../../shared/ipc";
import type { SelectOption } from "./setting-controls";

/**
 * The words of General that are not copy: the name of a language in its own language ("Português
 * (Brasil)", "English"), so a person who ended up in a language they cannot read still finds theirs.
 */
export const themeModes: readonly ThemeMode[] = themeModeSchema.options;

export const isThemeMode = (value: unknown): value is ThemeMode =>
  typeof value === "string" && (themeModes as readonly string[]).includes(value);

export const isLanguageCode = (value: unknown): value is LanguageCode =>
  typeof value === "string" && (appLanguageCodes as readonly string[]).includes(value);

/** A language's own name, first letter capitalized the way that language writes it. */
export function languageName(code: LanguageCode): string {
  const name = getLanguageDisplayName(code, code);
  return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
}

/** The five languages of the app, as a select lists them. */
export const languageOptions = (): SelectOption<LanguageCode>[] =>
  appLanguageCodes.map((code) => ({ value: code, label: languageName(code) }));
