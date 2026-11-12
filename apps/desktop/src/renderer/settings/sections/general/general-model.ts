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

const capitalized = (name: string, locale: LanguageCode): string =>
  name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);

/**
 * A language named for a person reading `locale`: "Inglês (English)" in a Portuguese window, then its
 * own name in brackets so the one who cannot read the first still finds it; "English" alone where the
 * two are the same. The app's language is listed by its own name only (`languageOptions`), so a
 * person stuck in a language they cannot read finds theirs; the language of the notes is not that
 * kind of choice and reads in the window's language.
 */
export function languageNameFor(code: LanguageCode, locale: LanguageCode): string {
  const own = languageName(code);
  const here = capitalized(getLanguageDisplayName(locale, code), locale);
  return here.toLocaleLowerCase(locale) === own.toLocaleLowerCase(locale)
    ? own
    : `${here} (${own})`;
}

/** The languages the notes can be written in, named for the window's language. */
export const contentLanguageOptions = (locale: LanguageCode): SelectOption<LanguageCode>[] =>
  appLanguageCodes.map((code) => ({ value: code, label: languageNameFor(code, locale) }));
