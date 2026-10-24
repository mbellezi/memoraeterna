import {
  bumpAiConfigGeneration,
  createAiConfigRepository,
  createJobRepository,
  operationRouteKey,
  type PgPool
} from "@app/db";
import {
  PriceTableSchema,
  relationExplainBackfillJobType,
  type BudgetSnapshot,
  type PriceTable
} from "@app/domain";

import { explanationText } from "./fake-codex-provider.js";
import {
  FakeProviderServer,
  fixedLatency,
  type FakeCallContext,
  type FakeHttpRequest,
  type FakeProviderKind
} from "./fake-remote-core.js";
import { installProvider } from "./fake-remote-install.js";
import { devFakeApiKey, openAiCompatibleKind } from "./fake-remote-provider.js";
import type { SoakF4Plan } from "./soak-plan-f4.js";
import { pickRelationsToExplain } from "./soak-queries.js";
import type { SoakEventSink } from "./soak-records.js";
import type { MoneyPort } from "./soak-windows.js";

/**
 * The money window of the 7-day soak (F4 T89, spec 5.4, E4(c)): the explanation backfill is routed
 * to a priced loopback fake, so the monthly money cap, which Codex (a subscription) never meets, is
 * exercised without a cent: the cap is set to the month's spend plus eight attempts' estimate, a
 * pass of ten relations is queued, the budget reaches its 80% (`cap.money_80`, background remote
 * work waits for the person), the driver continues, and it reaches its cap (`cap.money_100`:
 * generative background waits, placement and deciding go on). The window ends by putting the routes
 * and the cap back.
 *
 * The fake is an OpenAI-compatible server on loopback whose model has a price in the soak's price
 * table (a copy of the product's with one more entry), so its usage is priced like a paid route.
 * It answers an explanation prompt (it names the notes n1 and n2) with a valid short sentence.
 */

export const moneyProviderName = "DEV fake priced (soak money window)";
/**
 * The operations the explanation backfill may call under (user opens use the first). The backfill
 * is T84's: when it merges, check its operation name is in this list. User opens in the window go to
 * the fake too, at zero cost: an interactive call is never counted against the money cap.
 */
export const moneyWindowOperations = ["relation_explanation", "relation_explanation_backfill"];

/** The product's price table plus the fake's model, priced as a paid per-token route. */
export function soakPriceTable(
  base: PriceTable,
  money: NonNullable<SoakF4Plan["money"]>,
  today = new Date().toISOString().slice(0, 10)
): PriceTable {
  return PriceTableSchema.parse({
    ...base,
    version: `${base.version}+soak-money`,
    entries: [
      ...base.entries,
      {
        provider: "openai-compatible",
        model: money.model.toLowerCase(),
        billing: "per_token",
        inputUsdPerM: money.inputUsdPerM,
        cachedInputUsdPerM: money.inputUsdPerM,
        outputUsdPerM: money.outputUsdPerM,
        checkedAt: today,
        verified: false,
        source: "the soak's priced loopback fake (money window); not a provider price"
      }
    ]
  });
}

/** The OpenAI-compatible protocol with explanation answers for the prompts that ask for one. */
export function pricedFakeKind(options: {
  seed: number;
  latencyMs: number;
  model: string;
}): FakeProviderKind {
  const base = openAiCompatibleKind({
    seed: options.seed,
    latency: fixedLatency(options.latencyMs),
    modelId: options.model
  });
  return {
    ...base,
    reply(request: FakeHttpRequest, context: FakeCallContext) {
      if (request.method === "POST" && request.path.endsWith("/chat/completions")) {
        const prompt = request.body;
        const explains = /\bn1\b/u.test(prompt) && /\bn2\b/u.test(prompt);
        return base.replyWithText(
          request,
          context,
          explains ? explanationText(options.seed, context.seq) : "OK"
        );
      }
      return base.reply(request, context);
    }
  };
}

export interface MoneyPortDeps {
  pool: PgPool;
  credentials: { save(secret: string, existingRef?: string | null): Promise<string> };
  budget: {
    snapshot(): Promise<BudgetSnapshot>;
    continuePastPause(): Promise<unknown>;
  };
  controls: { current(): { monthlyCapUsd: number } };
  money: NonNullable<SoakF4Plan["money"]>;
  seed: number;
  sink: SoakEventSink;
  jobs: { wake(): void };
  logger?: Pick<Console, "info">;
}

export function createMoneyPort(deps: MoneyPortDeps): MoneyPort & { stop(): Promise<void> } {
  let server: FakeProviderServer | null = null;
  let previous: Map<string, string | null> | null = null;
  const repository = createAiConfigRepository(deps.pool);

  return {
    async routeToFake() {
      if (!server) {
        server = new FakeProviderServer({
          kind: pricedFakeKind({
            seed: deps.seed,
            latencyMs: deps.money.latencyMs,
            model: deps.money.model
          }),
          sink: deps.sink
        });
        await server.start();
      }
      const baseUrl = `${server.origin}/v1`;
      const { profile } = await installProvider(repository, deps, {
        displayName: moneyProviderName,
        provider: "openai-compatible",
        baseUrl,
        modelId: deps.money.model,
        capabilities: ["text-generation"],
        secret: devFakeApiKey
      });
      const routes = await repository.listTaskRoutes();
      previous ??= new Map(
        moneyWindowOperations.map((operation) => {
          const key = operationRouteKey(operation);
          return [key, routes.find((route) => route.task === key)?.profileId ?? null];
        })
      );
      for (const key of previous.keys()) {
        await repository.setProfileTask({ profileId: profile.id, task: key, parameters: {} });
        await repository.setTaskRoute(key, profile.id);
      }
      bumpAiConfigGeneration();
      deps.logger?.info(`SOAK money window: the explanation backfill is routed to ${baseUrl}`);
      return { baseUrl, model: deps.money.model };
    },

    async restoreRoute() {
      const saved = previous;
      previous = null;
      if (!saved) return;
      for (const [key, profileId] of saved)
        if (profileId) await repository.setTaskRoute(key, profileId);
        else await repository.deleteTaskRoute(key);
      bumpAiConfigGeneration();
      deps.logger?.info("SOAK money window: the explanation routes are back");
    },

    spentUsd: async () => (await deps.budget.snapshot()).money.spentUsd,
    monthlyCapUsd: () => deps.controls.current().monthlyCapUsd,
    state: async () => (await deps.budget.snapshot()).money.state,
    continuePastPause: async () => void (await deps.budget.continuePastPause()),

    async enqueueBackfill(count) {
      const picked = await pickRelationsToExplain(deps.pool, count, deps.seed);
      const jobs = createJobRepository(deps.pool);
      let queued = 0;
      for (const relation of picked) {
        const result = await jobs.enqueueDeduped({
          type: relationExplainBackfillJobType,
          lane: "light",
          dedupeKey: `${relationExplainBackfillJobType}:${relation.id}`,
          payload: { relationId: relation.id },
          priority: 0,
          debounce: { delayMs: 0, maxDelayMs: 0 }
        });
        if (result.created) queued += 1;
      }
      deps.jobs.wake();
      return queued;
    },

    async stop() {
      await server?.stop();
      server = null;
    }
  };
}
