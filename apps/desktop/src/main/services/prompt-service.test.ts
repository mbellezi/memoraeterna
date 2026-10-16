import { describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";
import { PromptOverviewSchema, promptDefinitions } from "@app/domain";

import { PromptService } from "./prompt-service.js";

/** Only the prompt catalog's own tables are read: any other repository method fails the test. */
const catalogOnly = vi.hoisted(() => {
  const allowed = new Set(["publish", "revisions", "history"]);
  const calls: string[] = [];
  const repository = new Proxy(
    {
      publish: async (publish: (rows: unknown[]) => unknown) => {
        publish([]);
        return [];
      },
      revisions: async () => [],
      history: async () => []
    } as Record<string, unknown>,
    {
      get(target, name) {
        if (typeof name !== "string" || !allowed.has(name))
          throw new Error(`the catalog read ${String(name)}`);
        calls.push(name);
        return target[name];
      }
    }
  );
  return { repository, calls };
});
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createPromptRepository: () => catalogOnly.repository,
  createSettingsRepository: () => {
    throw new Error("the catalog reads no settings");
  }
}));

const service = () => new PromptService({ getPool: () => ({}) as PgPool });

describe("prompt service after the legacy wiki", () => {
  it("starts from the catalog alone, with no organization settings to migrate", async () => {
    const prompts = service();
    await prompts.initialize();
    expect(catalogOnly.calls).toEqual(["publish"]);
    expect("migrateLegacy" in prompts).toBe(false);
  });

  it("lists the catalog without organization domains", async () => {
    const prompts = service();
    await prompts.initialize();
    const overview = PromptOverviewSchema.parse(await prompts.command({ command: "list" }));
    expect(overview.domains).toEqual([]);
    expect(overview.definitions).toHaveLength(promptDefinitions.length);
    expect(overview.definitions.filter((d) => /^(organization|maintenance)\./.test(d.id))).toEqual(
      []
    );
  });
});
