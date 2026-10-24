// The versioned price table of remote AI routes (F4 D14, T76; plan 4.3 "money cap"). The RemoteBudget
// prices background spend with it: recorded tokens times the entry of the call's provider and model.
// A model missing from the table is priced conservatively (a multiple of the table's highest price),
// never as zero. Subscription routes (ChatGPT/Codex OAuth) are not metered in money: their entry says
// so and a daily call cap bounds them instead. Prices are typed configuration (RULES.md section 1),
// each entry dated; an entry that nobody re-read on the provider's own page says `verified: false`.
import { z } from "zod";

export const priceBillings = ["per_token", "subscription"] as const;
export const PriceBillingSchema = z.enum(priceBillings);
export type PriceBilling = z.infer<typeof PriceBillingSchema>;

const usdPerMillion = z.number().nonnegative().finite();
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const PriceEntrySchema = z
  .object({
    /** The provider kind of the route (`openai-compatible`, `google`, `openai-codex`, `openai-decisions`). */
    provider: z.string().min(1),
    /**
     * The model id, lower case; a dated snapshot of it (`<model>-YYYY-MM-DD`) and the Gemini
     * `models/` prefix match too. `*` covers every model of the provider (subscription entries).
     */
    model: z.string().min(1),
    billing: PriceBillingSchema,
    /** US$ per million input tokens. */
    inputUsdPerM: usdPerMillion,
    /** US$ per million cached input tokens; the ledger prices every input token at the input price. */
    cachedInputUsdPerM: usdPerMillion,
    /** US$ per million output tokens; reasoning tokens count as output. */
    outputUsdPerM: usdPerMillion,
    /** The day the price was read or last checked. */
    checkedAt: isoDay,
    /** True only when the price was read on the provider's own pricing page on `checkedAt`. */
    verified: z.boolean(),
    /** Where the value comes from. */
    source: z.string().min(1)
  })
  .strict();
export type PriceEntry = z.infer<typeof PriceEntrySchema>;

export const PriceTableSchema = z
  .object({
    /** Changes whenever an entry or the unknown-price rule changes. */
    version: z.string().min(1),
    /**
     * A per-token model missing from the table is priced at this multiple of the table's highest
     * input and output prices (cal.): conservative, never zero.
     */
    unknownPriceFactor: z.number().min(1),
    entries: z.array(PriceEntrySchema).min(1)
  })
  .strict()
  .superRefine((table, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of table.entries.entries()) {
      const key = `${entry.provider}\u0000${entry.model}`;
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          path: ["entries", index],
          message: `duplicate price entry ${entry.provider} ${entry.model}`
        });
      seen.add(key);
      if (entry.model !== entry.model.toLowerCase())
        context.addIssue({
          code: "custom",
          path: ["entries", index, "model"],
          message: "model ids are stored lower case"
        });
    }
    if (!table.entries.some((entry) => entry.billing === "per_token" && entry.outputUsdPerM > 0))
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "the unknown price needs at least one priced per-token entry"
      });
  });
export type PriceTable = z.infer<typeof PriceTableSchema>;

export const priceTableVersion = "2026-10-24.1";

const unverified =
  "the provider's published list price as the implementing agent knew it (T76); re-read the provider's page before relying on it";

/**
 * The shipped table. Codex OAuth is a subscription; the Decisions API price is the one its typed
 * limits carry (`@app/ai` `defaultDecisionsLimits`, a test keeps them equal). The per-token entries
 * of the OpenAI API (through an OpenAI-compatible configuration) and of Gemini are unverified list
 * prices (Gemini 2.5 Pro at its tier for prompts up to 200k tokens), the embedding models of the
 * Cloud preset's provider embedding included (input only); every other model is unknown and priced
 * at 1.5 times the highest prices here.
 */
export const defaultPriceTable: PriceTable = PriceTableSchema.parse({
  version: priceTableVersion,
  unknownPriceFactor: 1.5,
  entries: [
    {
      provider: "openai-codex",
      model: "*",
      billing: "subscription",
      inputUsdPerM: 0,
      cachedInputUsdPerM: 0,
      outputUsdPerM: 0,
      checkedAt: "2026-10-23",
      verified: true,
      source: "ChatGPT plan through desktop OAuth: no per-token charge; bounded by a daily call cap"
    },
    {
      provider: "openai-decisions",
      model: "gpt-6-luna",
      billing: "per_token",
      inputUsdPerM: 0.1,
      cachedInputUsdPerM: 0,
      outputUsdPerM: 0,
      checkedAt: "2026-10-14",
      verified: false,
      source: "Decisions API published price as the F3 decider's typed limits carry it"
    },
    {
      // The paid-API option of the hardware tier table (T97, decision 25): its estimate is informative.
      provider: "openai-compatible",
      model: "gpt-6-luna",
      billing: "per_token",
      inputUsdPerM: 0.1,
      cachedInputUsdPerM: 0.01,
      outputUsdPerM: 0.5,
      checkedAt: "2026-10-18",
      verified: false,
      source:
        "OpenAI API list price as the hardware spike read it on 2026-10-18 (docs/spikes/hardware-tiers-and-models.md 9.1); re-read the provider's page before relying on it"
    },
    ...[
      ["gpt-5", 1.25, 0.125, 10],
      ["gpt-5-mini", 0.25, 0.025, 2],
      ["gpt-5-nano", 0.05, 0.005, 0.4],
      ["gpt-4.1", 2, 0.5, 8],
      ["gpt-4.1-mini", 0.4, 0.1, 1.6],
      ["gpt-4o", 2.5, 1.25, 10],
      ["gpt-4o-mini", 0.15, 0.075, 0.6],
      ["text-embedding-3-small", 0.02, 0.02, 0],
      ["text-embedding-3-large", 0.13, 0.13, 0],
      ["text-embedding-ada-002", 0.1, 0.1, 0]
    ].map(([model, input, cached, output]) => ({
      provider: "openai-compatible",
      model,
      billing: "per_token",
      inputUsdPerM: input,
      cachedInputUsdPerM: cached,
      outputUsdPerM: output,
      checkedAt: "2026-10-23",
      verified: false,
      source: unverified
    })),
    ...[
      ["gemini-2.5-pro", 1.25, 0.31, 10],
      ["gemini-2.5-flash", 0.3, 0.075, 2.5],
      ["gemini-2.5-flash-lite", 0.1, 0.025, 0.4],
      ["gemini-embedding-001", 0.15, 0.15, 0]
    ].map(([model, input, cached, output]) => ({
      provider: "google",
      model,
      billing: "per_token",
      inputUsdPerM: input,
      cachedInputUsdPerM: cached,
      outputUsdPerM: output,
      checkedAt: "2026-10-23",
      verified: false,
      source: unverified
    }))
  ]
});

/** The price a call is metered with. */
export interface ResolvedPrice {
  billing: PriceBilling;
  inputUsdPerM: number;
  cachedInputUsdPerM: number;
  outputUsdPerM: number;
  /** False when the model is not in the table and the conservative unknown price applies. */
  known: boolean;
  priceTableVersion: string;
}

/** The model id as the table stores it: lower case, without Gemini's `models/` prefix. */
export function normalizePricedModel(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/^models\//u, "");
}

function matchesModel(entry: PriceEntry, model: string): boolean {
  if (entry.model === "*" || entry.model === model) return true;
  // A dated snapshot of a listed model (`gpt-5-2025-08-07`) has the model's price.
  return (
    model.startsWith(`${entry.model}-`) &&
    /^\d{4}-\d{2}-\d{2}$/u.test(model.slice(entry.model.length + 1))
  );
}

/**
 * The price of a provider's model: its entry when the table lists it, else the unknown price, the
 * table's highest per-token input, cached and output prices times `unknownPriceFactor`.
 */
export function resolvePrice(table: PriceTable, provider: string, modelId: string): ResolvedPrice {
  const model = normalizePricedModel(modelId);
  const entries = table.entries.filter((entry) => entry.provider === provider);
  const entry =
    entries.find((candidate) => candidate.model === model) ??
    entries.find((candidate) => candidate.model !== "*" && matchesModel(candidate, model)) ??
    entries.find((candidate) => candidate.model === "*");
  if (entry)
    return {
      billing: entry.billing,
      inputUsdPerM: entry.inputUsdPerM,
      cachedInputUsdPerM: entry.cachedInputUsdPerM,
      outputUsdPerM: entry.outputUsdPerM,
      known: true,
      priceTableVersion: table.version
    };
  const priced = table.entries.filter((candidate) => candidate.billing === "per_token");
  const highest = (read: (entry: PriceEntry) => number) =>
    Math.max(...priced.map(read)) * table.unknownPriceFactor;
  return {
    billing: "per_token",
    inputUsdPerM: highest((candidate) => candidate.inputUsdPerM),
    cachedInputUsdPerM: highest((candidate) => candidate.inputUsdPerM),
    outputUsdPerM: highest((candidate) => candidate.outputUsdPerM),
    known: false,
    priceTableVersion: table.version
  };
}

/** US$ of a token count at a price; a subscription price costs nothing in money. */
export function tokensCostUsd(
  price: Pick<ResolvedPrice, "billing" | "inputUsdPerM" | "outputUsdPerM">,
  tokens: { inputTokens: number; outputTokens: number }
): number {
  if (price.billing === "subscription") return 0;
  return (
    (Math.max(0, tokens.inputTokens) * price.inputUsdPerM +
      Math.max(0, tokens.outputTokens) * price.outputUsdPerM) /
    1_000_000
  );
}
