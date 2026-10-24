import {
  defaultPriceTable,
  defaultRemoteBudgetConfig,
  moneyAdmission,
  resolvePrice,
  tokensCostUsd
} from "@app/domain";
import { describe, expect, it } from "vitest";

import { profileGenerationMaxTokens } from "../ai-task-parameters.js";
import { attemptTokenEstimate } from "../gardener/remote-budget.js";
import { attemptEstimateUsd, pricedFakeKind, soakPriceTable } from "./soak-money.js";

// The money window of the 7-day soak (F4 T89, E4(c)) against the product's own estimator, price
// table and admission rule: the cap is the spend plus eight attempts' estimate, a pass of ten
// relations reaches the 80% item, the driver continues, and the pass reaches the cap.
const money = { model: "dev-fake-priced-1", inputUsdPerM: 1, outputUsdPerM: 4, latencyMs: 0 };
const table = soakPriceTable(defaultPriceTable, money, "2026-10-28");
const price = resolvePrice(table, "openai-compatible", money.model);

/** An explanation prompt of `bytes` that names the two notes. */
const prompt = (bytes: number) => {
  const head = "Explain how n1 and n2 relate. ";
  return `${head}${"x".repeat(bytes - head.length)}`;
};

/** What the priced fake bills for one call with this prompt (the usage of its reply). */
function billed(text: string): { inputTokens: number; outputTokens: number } {
  const reply = pricedFakeKind({ seed: 1, latencyMs: 0, model: money.model }).reply(
    {
      method: "POST",
      path: "/v1/chat/completions",
      headers: {},
      body: JSON.stringify({
        model: money.model,
        messages: [{ role: "user", content: text }],
        max_tokens: profileGenerationMaxTokens
      })
    },
    { seq: 1, elapsedMs: 0 }
  );
  const body = JSON.parse(reply.parts.map((part) => part.data).join("")) as {
    usage: { prompt_tokens: number; completion_tokens: number };
  };
  return { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens };
}

describe("the money window's arithmetic", () => {
  it("bills each call what the budget reserved for it", () => {
    const text = prompt(2_500);
    const reserved = attemptTokenEstimate(text, "", profileGenerationMaxTokens);
    expect(billed(text)).toEqual(reserved);
    expect(tokensCostUsd(price, billed(text))).toBeCloseTo(tokensCostUsd(price, reserved), 12);
  });

  it("estimates an attempt as the product does, at the fake's price", () => {
    const text = prompt(3_000);
    expect(attemptEstimateUsd(money, 3_000)).toBeCloseTo(
      tokensCostUsd(price, attemptTokenEstimate(text, "", profileGenerationMaxTokens)),
      12
    );
  });

  it.each([1_500, 3_000, 5_000])(
    "reaches the 80%% item, then the cap after the continue, within ten relations (prompts of %i bytes)",
    (bytes) => {
      const spentBefore = 0.37;
      const capUsd = spentBefore + 8 * attemptEstimateUsd(money, 3_000);
      const estimateUsd = tokensCostUsd(
        price,
        attemptTokenEstimate(prompt(bytes), "", profileGenerationMaxTokens)
      );
      let spentUsd = spentBefore;
      let continued = false;
      const verdicts: string[] = [];
      for (let relation = 0; relation < 10; relation += 1) {
        let verdict = moneyAdmission({
          spentUsd,
          reservedUsd: 0,
          estimateUsd,
          capUsd,
          pauseShare: defaultRemoteBudgetConfig.pauseShare,
          continued
        });
        if (verdict === "money_80") {
          verdicts.push("money_80");
          // The driver presses continue; the attempt is admitted again afterwards.
          continued = true;
          verdict = moneyAdmission({
            spentUsd,
            reservedUsd: 0,
            estimateUsd,
            capUsd,
            pauseShare: defaultRemoteBudgetConfig.pauseShare,
            continued
          });
        }
        if (verdict === "money_100") {
          verdicts.push("money_100");
          break;
        }
        verdicts.push("admit");
        spentUsd += tokensCostUsd(price, billed(prompt(bytes)));
      }
      expect(verdicts).toContain("money_80");
      expect(verdicts.at(-1)).toBe("money_100");
      expect(verdicts.indexOf("money_80")).toBeLessThan(verdicts.indexOf("money_100"));
      // E4(c): the spend never passes the cap by more than one attempt's estimation error.
      expect(spentUsd - capUsd).toBeLessThanOrEqual(estimateUsd);
    }
  );
});
