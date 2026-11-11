import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { messages } from "./index.js";

type Locale = "pt-BR" | "es" | "fr" | "it";

const locales: readonly Locale[] = ["pt-BR", "es", "fr", "it"];
const maxListed = 50;

// Keys whose value legitimately equals English in a locale (brand names, units,
// codes, technical identifiers, true cognates), listed per locale.
const allowlists = JSON.parse(
  readFileSync(new URL("./parity-allowlist.json", import.meta.url), "utf8")
) as Record<Locale, string[]>;

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix === "" ? key : `${prefix}.${key}`, out);
    }
  } else {
    out.set(prefix, value);
  }
  return out;
}

function placeholders(value: string): string {
  return [...new Set([...value.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]))]
    .sort()
    .join(",");
}

const flat = (locale: "en" | Locale) => flatten(messages[locale], "", new Map());
const english = flat("en");

function limited(keys: string[]): string {
  const shown = keys.slice(0, maxListed).join("\n  ");
  return keys.length > maxListed ? `${shown}\n  ... and ${keys.length - maxListed} more` : shown;
}

describe("i18n whole-catalog parity", () => {
  it("only allowlists keys that exist in en, and only known locales", () => {
    expect(Object.keys(allowlists).sort()).toEqual([...locales].sort());
    for (const locale of locales) {
      expect(allowlists[locale].filter((key) => !english.has(key))).toEqual([]);
    }
  });

  it("keeps no stale allowlist entry (the value now differs from en)", () => {
    for (const locale of locales) {
      const catalog = flat(locale);
      expect(allowlists[locale].filter((key) => catalog.get(key) !== english.get(key))).toEqual([]);
    }
  });

  for (const locale of locales) {
    describe(locale, () => {
      const catalog = flat(locale);

      it("has the same key set as en", () => {
        const missing = [...english.keys()].filter((key) => !catalog.has(key));
        const extra = [...catalog.keys()].filter((key) => !english.has(key));
        expect(
          { missing: limited(missing), extra: limited(extra) },
          `key set differs for ${locale}`
        ).toEqual({ missing: "", extra: "" });
      });

      it("uses the same placeholders per key", () => {
        const bad: string[] = [];
        for (const [key, value] of english) {
          const other = catalog.get(key);
          if (typeof value === "string" && typeof other === "string") {
            if (placeholders(value) !== placeholders(other)) bad.push(key);
          }
        }
        expect(limited(bad), `placeholder mismatch for ${locale}`).toBe("");
      });

      it("has no empty value and no value equal to its key", () => {
        const empty: string[] = [];
        const keyEcho: string[] = [];
        for (const [key, value] of catalog) {
          if (typeof value !== "string" || value.trim() === "") empty.push(key);
          else if (value === key) keyEcho.push(key);
        }
        expect(
          { empty: limited(empty), keyEcho: limited(keyEcho) },
          `bad values for ${locale}`
        ).toEqual({ empty: "", keyEcho: "" });
      });

      it("repeats an English value only for allowlisted keys", () => {
        const identical: string[] = [];
        for (const [key, value] of catalog) {
          if (typeof value === "string" && value === english.get(key)) identical.push(key);
        }
        const allowed = new Set(allowlists[locale]);
        const unlisted = identical.filter((key) => !allowed.has(key));
        console.info(
          `[i18n parity] ${locale}: ${identical.length} values identical to en, ${unlisted.length} not allowlisted`
        );
        expect(limited(unlisted), `identical to en and not allowlisted for ${locale}`).toBe("");
      });
    });
  }
});
