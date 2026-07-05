import en from "./locales/en.json" with { type: "json" };
import es from "./locales/es.json" with { type: "json" };
import fr from "./locales/fr.json" with { type: "json" };
import it from "./locales/it.json" with { type: "json" };
import ptBR from "./locales/pt-BR.json" with { type: "json" };

type MessageNode = string | { readonly [key: string]: MessageNode };
type MessageDictionary = { readonly [key: string]: MessageNode };

type LeafMessageKey<T> = {
  [Key in keyof T & string]: T[Key] extends string
    ? Key
    : T[Key] extends Record<string, unknown>
      ? `${Key}.${LeafMessageKey<T[Key]>}`
      : never;
}[keyof T & string];

export const defaultLanguageCode = "en";

export const supportedLanguageCodes = [
  "en",
  "pt-BR",
  "it",
  "fr",
  "es"
] as const;

export type LanguageCode = (typeof supportedLanguageCodes)[number];
export type MessageKey = LeafMessageKey<typeof en>;
export type InterpolationValue = string | number | boolean | Date | null | undefined;
export type InterpolationValues = Readonly<Record<string, InterpolationValue>>;
export type MissingKeyBehavior = "marker" | "throw";

export interface TranslateOptions {
  readonly values?: InterpolationValues;
  readonly missingKeyBehavior?: MissingKeyBehavior;
}

export interface Translator {
  (key: MessageKey, options?: TranslateOptions): string;
  readonly locale: LanguageCode;
}

export class MissingMessageError extends Error {
  constructor(readonly key: string) {
    super(`Missing i18n message: ${key}`);
    this.name = "MissingMessageError";
  }
}

export const messages = {
  en,
  "pt-BR": ptBR,
  it,
  fr,
  es
} satisfies Record<LanguageCode, typeof en>;

export function isSupportedLanguageCode(languageCode: string): languageCode is LanguageCode {
  return supportedLanguageCodes.includes(languageCode as LanguageCode);
}

export function normalizeLanguageCode(languageCode: string | null | undefined): LanguageCode {
  const normalized = languageCode?.replace("_", "-");
  if (normalized && isSupportedLanguageCode(normalized)) {
    return normalized;
  }

  const baseLanguage = normalized?.split("-")[0];
  if (baseLanguage === "pt") {
    return "pt-BR";
  }

  if (baseLanguage && isSupportedLanguageCode(baseLanguage)) {
    return baseLanguage;
  }

  return defaultLanguageCode;
}

export function translate(
  locale: LanguageCode | string | null | undefined,
  key: MessageKey,
  options: TranslateOptions = {}
): string {
  const languageCode = normalizeLanguageCode(locale);
  const message =
    getMessage(messages[languageCode], key) ?? getMessage(messages[defaultLanguageCode], key);

  if (message === undefined) {
    return handleMissingKey(key, options.missingKeyBehavior);
  }

  return interpolate(message, options.values);
}

export function createTranslator(
  locale: LanguageCode | string | null | undefined,
  defaultOptions: TranslateOptions = {}
): Translator {
  const languageCode = normalizeLanguageCode(locale);
  const translator = ((key: MessageKey, options: TranslateOptions = {}) => {
    const missingKeyBehavior = options.missingKeyBehavior ?? defaultOptions.missingKeyBehavior;
    const translateOptions: TranslateOptions = {
      values: {
        ...(defaultOptions.values ?? {}),
        ...(options.values ?? {})
      }
    };

    if (missingKeyBehavior !== undefined) {
      return translate(languageCode, key, {
        ...translateOptions,
        missingKeyBehavior
      });
    }

    return translate(languageCode, key, translateOptions);
  }) as Translator;

  Object.defineProperty(translator, "locale", {
    enumerable: true,
    value: languageCode
  });

  return translator;
}

function getMessage(dictionary: MessageDictionary, key: string): string | undefined {
  let current: MessageNode | undefined = dictionary;

  for (const keyPart of key.split(".")) {
    if (current === undefined || typeof current === "string") {
      return undefined;
    }

    current = current[keyPart];
  }

  return typeof current === "string" ? current : undefined;
}

function interpolate(message: string, values: InterpolationValues = {}): string {
  return message.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (token, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      return token;
    }

    return stringifyInterpolationValue(values[name]);
  });
}

function stringifyInterpolationValue(value: InterpolationValue): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

function handleMissingKey(key: string, behavior: MissingKeyBehavior = "marker"): string {
  if (behavior === "throw") {
    throw new MissingMessageError(key);
  }

  return `[[missing:${key}]]`;
}
