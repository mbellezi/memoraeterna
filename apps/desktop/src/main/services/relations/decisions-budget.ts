// The daily spend cap of the Decisions API decider (F3 plan decision 30). One counter per local day
// in the setting `relations.decisions.dailySpend`: the input tokens the provider reported for the
// requests sent that day, billed at the typed price (output tokens are free). Background work stops
// using the decider once the day's spend reaches the cap and the local ranker decides until the next
// day. Replayed requests (a DEV cassette) spent nothing and are not counted.
import {
  DecisionsDailySpendSchema,
  relationsDecisionsSpendSettingKey,
  type DecisionsDailySpend
} from "@app/domain";
import type { Queryable } from "@app/db";

import { localDay } from "./relation-call-budget.js";

export interface DecisionsSpendStatus extends DecisionsDailySpend {
  usd: number;
}

export interface DecisionsSpendBudget {
  /** Today's counter (zero on a new day). */
  status(): Promise<DecisionsSpendStatus>;
  /** Adds a request's reported input tokens to today's counter, atomically. */
  add(inputTokens: number): Promise<void>;
}

export function createDecisionsSpendBudget(options: {
  db: () => Queryable;
  /** US$ per million input tokens. */
  pricePerMillionInputTokensUsd: number;
  now?: () => Date;
}): DecisionsSpendBudget {
  const now = options.now ?? (() => new Date());
  const usd = (inputTokens: number) =>
    (inputTokens * options.pricePerMillionInputTokensUsd) / 1_000_000;
  return {
    async status() {
      const day = localDay(now());
      const result = await options
        .db()
        .query<{ value: unknown }>(`select value from settings where key = $1`, [
          relationsDecisionsSpendSettingKey
        ]);
      const parsed = DecisionsDailySpendSchema.safeParse(result.rows[0]?.value);
      const spend =
        parsed.success && parsed.data.day === day
          ? parsed.data
          : { day, inputTokens: 0, requests: 0 };
      return { ...spend, usd: usd(spend.inputTokens) };
    },
    async add(inputTokens) {
      const tokens = Math.max(0, Math.round(inputTokens));
      await options.db().query(
        `insert into settings as s (key, value)
         values ($1, jsonb_build_object('day', $2::text, 'inputTokens', $3::bigint, 'requests', 1))
         on conflict (key) do update set
           value = case
             when s.value->>'day' is distinct from $2::text then excluded.value
             else jsonb_build_object('day', $2::text,
               'inputTokens', coalesce((s.value->>'inputTokens')::bigint, 0) + $3::bigint,
               'requests', coalesce((s.value->>'requests')::int, 0) + 1)
           end,
           updated_at = now()`,
        [relationsDecisionsSpendSettingKey, localDay(now()), tokens]
      );
    }
  };
}
