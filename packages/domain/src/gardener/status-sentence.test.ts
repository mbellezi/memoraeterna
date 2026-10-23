import { messages, supportedLanguageCodes, type LanguageCode } from "@app/i18n";
import { describe, expect, it } from "vitest";

import { aiClassIds } from "../ai-presets.js";
import {
  gardenerBlockerClasses,
  gardenerBlockerKeys,
  gardenerBlockerReasons,
  type GardenerBlockerKey
} from "./blockers.js";
import {
  formatStatusDuration,
  formatStatusTime,
  gardenerStatusActionKeys,
  gardenerStatusAllMessageKeys,
  gardenerStatusDetailKeys,
  gardenerStatusMessageKeys,
  gardenerStatusRouteClassKeys,
  gardenerStatusStateKeys,
  statusSentence
} from "./status-sentence.js";
import {
  GardenerStatusSnapshotSchema,
  fullGardenerCoverage,
  gardenerStatusActionOf,
  gardenerStatusActions,
  type GardenerStatusSnapshot
} from "./status.js";

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!).sort();

const leaf = (root: unknown, key: string): string | undefined => {
  let current: unknown = root;
  for (const part of key.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
};

const leaves = (value: unknown, prefix = ""): string[] =>
  typeof value === "string"
    ? [prefix]
    : Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        leaves(child, prefix ? `${prefix}.${key}` : key)
      );

const snapshot = (overrides: Partial<GardenerStatusSnapshot> = {}): GardenerStatusSnapshot => ({
  state: "idle",
  params: {},
  coverage: fullGardenerCoverage,
  ...overrides
});

const at = (key: GardenerBlockerKey): Partial<GardenerStatusSnapshot> => {
  const [blockerClass, reason] = key.split(".") as [GardenerStatusSnapshot["class"], string];
  return {
    state: "blocked",
    ...(blockerClass ? { class: blockerClass } : {}),
    reason
  };
};

/** The parameters a message may take: what varies is a name, a place in time or an amount. */
const allowedPlaceholders = ["cap", "duration", "routeClass", "spent", "time"];

describe("the status messages: every (class, reason) in all five locales", () => {
  it("lists one literal message key per reason of the blocker table, named gardener.status.<class>.<reason>", () => {
    expect(Object.keys(gardenerStatusMessageKeys).sort()).toEqual([...gardenerBlockerKeys].sort());
    for (const [key, messageKey] of Object.entries(gardenerStatusMessageKeys))
      expect(messageKey).toBe(`gardener.status.${key}`);
    for (const blockerClass of gardenerBlockerClasses)
      for (const reason of gardenerBlockerReasons[blockerClass])
        expect(gardenerStatusMessageKeys[`${blockerClass}.${reason}` as GardenerBlockerKey]).toBe(
          `gardener.status.${blockerClass}.${reason}`
        );
  });

  it("has every message in every locale, with the same parameters as English", () => {
    for (const key of gardenerStatusAllMessageKeys) {
      const english = leaf(messages.en, key);
      expect(english, key).toBeTruthy();
      for (const locale of supportedLanguageCodes) {
        const text = leaf(messages[locale], key);
        expect(text, `${locale} ${key}`).toBeTruthy();
        expect(placeholders(text!), `${locale} ${key}`).toEqual(placeholders(english!));
      }
    }
  });

  it("has no other message under gardener.status in any locale, and none without a use", () => {
    const used = [...gardenerStatusAllMessageKeys].sort();
    for (const locale of supportedLanguageCodes) {
      const present = leaves(messages[locale].gardener.status, "gardener.status").sort();
      expect(present, locale).toEqual(used);
    }
  });

  it("keeps every variable part a parameter: no key has one, no copy has a number or a count", () => {
    for (const key of gardenerStatusAllMessageKeys) expect(key).not.toMatch(/[{}$]/);
    for (const locale of supportedLanguageCodes)
      for (const key of gardenerStatusAllMessageKeys) {
        const text = leaf(messages[locale], key)!;
        for (const name of placeholders(text))
          expect(allowedPlaceholders, `${locale} ${key} {${name}}`).toContain(name);
        expect(text, `${locale} ${key}`).not.toMatch(/\d/);
        expect(text, `${locale} ${key}`).not.toMatch(/[<>]/);
      }
  });

  it("renders every reason in every locale into a finished sentence with no marker or open parameter", () => {
    for (const locale of supportedLanguageCodes)
      for (const key of gardenerBlockerKeys) {
        const params =
          key === "no_model.no_route"
            ? { routeClass: "write-quality" }
            : ({} as Record<string, string>);
        const sentence = statusSentence(snapshot({ ...at(key), params }), locale);
        expect(sentence.headline, `${locale} ${key}`).not.toContain("[[missing");
        expect(sentence.headline, `${locale} ${key}`).not.toMatch(/[{}]/);
        expect(sentence.text, `${locale} ${key}`).toBe(sentence.headline);
        expect(sentence.headline, `${locale} ${key}`).toMatch(/[.!]$/);
      }
  });

  it("says something different in each locale for the same reason", () => {
    for (const key of gardenerBlockerKeys) {
      const texts = supportedLanguageCodes.map(
        (locale) =>
          statusSentence(
            snapshot({
              ...at(key),
              params: key === "no_model.no_route" ? { routeClass: "embed" } : {}
            }),
            locale
          ).headline
      );
      expect(new Set(texts).size, key).toBe(supportedLanguageCodes.length);
    }
  });
});

describe("the idle and running sentences", () => {
  it("renders the state when no reason holds", () => {
    for (const locale of supportedLanguageCodes) {
      expect(statusSentence(snapshot({ state: "idle" }), locale).text).toBe(
        leaf(messages[locale], gardenerStatusStateKeys.idle)
      );
      expect(statusSentence(snapshot({ state: "running" }), locale).text).toBe(
        leaf(messages[locale], gardenerStatusStateKeys.running)
      );
    }
    expect(statusSentence(snapshot({ state: "idle" }), "en").action).toBeNull();
  });
});

describe("parameters", () => {
  it("names the route class a missing route is about, in the locale's words", () => {
    const expected: Record<LanguageCode, Record<string, string>> = {
      en: { embed: "embedding", decide: "ranking", "write-fast": "quick writing" },
      "pt-BR": { embed: "embeddings", decide: "ranqueamento", "write-fast": "escrita rápida" },
      it: { embed: "embedding", decide: "classificazione", "write-fast": "scrittura rapida" },
      fr: { embed: "les embeddings", decide: "le classement", "write-fast": "la rédaction rapide" },
      es: { embed: "embeddings", decide: "clasificación", "write-fast": "redacción rápida" }
    };
    for (const locale of supportedLanguageCodes)
      for (const [routeClass, noun] of Object.entries(expected[locale])) {
        const text = statusSentence(
          snapshot({ ...at("no_model.no_route"), params: { routeClass } }),
          locale
        ).headline;
        expect(text, `${locale} ${routeClass}`).toContain(noun);
        expect(text).not.toContain("{routeClass}");
      }
    expect(Object.keys(gardenerStatusRouteClassKeys).sort()).toEqual([...aiClassIds].sort());
  });

  it("falls back to the embedding class for a route class it does not know", () => {
    expect(
      statusSentence(
        snapshot({ ...at("no_model.no_route"), params: { routeClass: "other" } }),
        "en"
      ).headline
    ).toBe("No embedding model is set up. Choose one in Settings to continue.");
    expect(statusSentence(snapshot(at("no_model.no_route")), "en").headline).toContain("embedding");
  });

  it("adds the amounts of a spending limit as a sentence of their own", () => {
    const sentence = statusSentence(
      snapshot({ ...at("cap.money_80"), params: { spentUsd: 4.01, capUsd: 5 } }),
      "en"
    );
    expect(sentence.detail).toBe("$4.01 of $5.00 used this month.");
    expect(sentence.text).toBe(`${sentence.headline} ${sentence.detail}`);
    const pt = statusSentence(
      snapshot({ ...at("cap.money_100"), params: { spentUsd: 5, capUsd: 5 } }),
      "pt-BR"
    );
    expect(pt.detail).toMatch(/US\$\s?5,00 de US\$\s?5,00/);
    expect(statusSentence(snapshot(at("cap.money_80")), "en").detail).toBeNull();
  });

  it("adds the time left as a sentence of its own", () => {
    const withEta = (eta: GardenerStatusSnapshot["eta"]) =>
      statusSentence(snapshot({ state: "running", ...(eta ? { eta } : {}) }), "en");
    expect(withEta({ kind: "duration", seconds: 30 }).eta).toBe("Less than a minute left.");
    expect(withEta({ kind: "duration", seconds: 600 }).eta).toBe("About 10 minutes left.");
    expect(withEta({ kind: "duration", seconds: 60 }).eta).toBe("About 1 minute left.");
    expect(withEta({ kind: "duration", seconds: 3 * 3_600 }).eta).toBe("About 3 hours left.");
    expect(withEta(undefined).eta).toBeNull();
    const text = withEta({ kind: "duration", seconds: 600 });
    expect(text.text).toBe(`${text.headline} About 10 minutes left.`);
  });

  it("says when a hold clears, with the date when it is not today", () => {
    const now = new Date(2026, 9, 24, 15, 0).getTime();
    const sameDay = statusSentence(
      snapshot({
        ...at("waiting.provider_rate_limit"),
        eta: { kind: "at", at: new Date(2026, 9, 24, 15, 40).toISOString() }
      }),
      "en",
      { now }
    );
    expect(sameDay.eta).toMatch(/^Resumes around 3:40\sPM\.$/);
    const nextDay = statusSentence(
      snapshot({
        ...at("cap.subscription_daily"),
        eta: { kind: "at", at: new Date(2026, 9, 25, 0, 0).toISOString() }
      }),
      "en",
      { now }
    );
    expect(nextDay.eta).toMatch(/Oct\s25.*12:00\sAM/);
    expect(formatStatusTime("pt-BR", new Date(2026, 9, 24, 15, 40), new Date(now))).toBe("15:40");
  });

  it("formats durations as minutes up to two hours and as hours after", () => {
    expect(formatStatusDuration("en", 90)).toBe("2 minutes");
    expect(formatStatusDuration("en", 7_100)).toBe("118 minutes");
    expect(formatStatusDuration("en", 7_200)).toBe("2 hours");
    expect(formatStatusDuration("fr", 600)).toBe("10 minutes");
    expect(formatStatusDuration("es", 3 * 3_600)).toBe("3 horas");
  });

  it("renders the time left in every locale", () => {
    for (const locale of supportedLanguageCodes) {
      const sentence = statusSentence(
        snapshot({ state: "running", eta: { kind: "duration", seconds: 600 } }),
        locale
      );
      expect(sentence.eta, locale).toMatch(/10/);
      expect(sentence.eta, locale).not.toMatch(/[{}]|missing/);
      const short = statusSentence(
        snapshot({ state: "running", eta: { kind: "duration", seconds: 30 } }),
        locale
      );
      expect(short.eta, locale).toBe(
        leaf(messages[locale], gardenerStatusDetailKeys.etaLessThanMinute)
      );
    }
  });
});

describe("actions", () => {
  it("labels the action of every reason that has one, in every locale", () => {
    expect(Object.keys(gardenerStatusActionKeys).sort()).toEqual([...gardenerStatusActions].sort());
    for (const locale of supportedLanguageCodes)
      for (const key of gardenerBlockerKeys) {
        const action = gardenerStatusActionOf[key];
        const sentence = statusSentence(
          snapshot({ ...at(key), ...(action ? { action } : {}) }),
          locale
        );
        if (action) {
          expect(sentence.action?.id).toBe(action);
          expect(sentence.action?.label, `${locale} ${key}`).toBe(
            leaf(messages[locale], gardenerStatusActionKeys[action])
          );
        } else {
          expect(sentence.action, `${locale} ${key}`).toBeNull();
        }
      }
  });

  it("offers an action only to a reason the person can act on", () => {
    expect(gardenerStatusActionOf["waiting.provider_rate_limit"]).toBeNull();
    expect(gardenerStatusActionOf["offline.network_unreachable"]).toBeNull();
    expect(gardenerStatusActionOf["cap.money_80"]).toBe("continue_budget");
    expect(gardenerStatusActionOf["paused.user_pause"]).toBe("resume");
    // Every snapshot the schema accepts renders.
    for (const key of gardenerBlockerKeys) {
      const parsed = GardenerStatusSnapshotSchema.parse(snapshot(at(key)));
      expect(statusSentence(parsed, "en").text).toBeTruthy();
    }
  });
});
