import {
  createTranslator,
  normalizeLanguageCode,
  type LanguageCode,
  type Translator
} from "@app/i18n";

/**
 * The language a screen module renders in. `npm run screens -- --locale <code>` writes it onto the
 * page before the bundle runs (`window.__screenLocale`); outside the screens tool it is English.
 * A screen module builds its translator with `screenTranslator()` instead of `createTranslator("en")`,
 * so the real components get the same `Translator` the app gives them (`createTranslator` over the
 * person's language), never a string swap.
 */
export function screenLocale(): LanguageCode {
  const value = (globalThis as { __screenLocale?: unknown }).__screenLocale;
  return normalizeLanguageCode(typeof value === "string" ? value : "en");
}

export function screenTranslator(): Translator {
  return createTranslator(screenLocale());
}
