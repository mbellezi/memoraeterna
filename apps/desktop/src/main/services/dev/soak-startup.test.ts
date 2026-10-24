import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AiModelRegistry, setAiAdapterDecorator, type AiModelAdapter } from "@app/ai";
import { defaultPriceTable, defaultRemoteBudgetConfig } from "@app/domain";
import { afterEach, describe, expect, it } from "vitest";

import { fakeRemoteKnobName, soakKnobName } from "./soak-plan.js";
import { decisionsAdmitKnobName, realWriterKnobName } from "./soak-real-writer.js";
import { prepareSoak } from "./soak-startup.js";

// What the app gets from `prepareSoak` for the 7-day soak (T89): the run folder under the data root,
// the fault layer, the overrides the budget takes, the decorators of the registry's single slot, and
// the refusals that keep the real writer from running without its cap.
const repository = resolve(import.meta.dirname, "../../../../../..");
const planPath = join(repository, "scripts", "soak", "plan.json");
const writerId = "5a1d2f50-3c1e-4d7a-9b38-0d2f2f6a7c11";
const quiet = { error: () => undefined, info: () => undefined };

const scratch: string[] = [];
afterEach(() => {
  setAiAdapterDecorator(null);
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup() {
  const worktree = mkdtempSync(join(tmpdir(), "soak7-worktree-"));
  const dataRoot = mkdtempSync(join(tmpdir(), "soak7-data-"));
  scratch.push(worktree, dataRoot);
  mkdirSync(join(worktree, "scripts", "soak"), { recursive: true });
  writeFileSync(join(worktree, "scripts", "soak", "plan.json"), readFileSync(planPath, "utf8"));
  mkdirSync(join(dataRoot, "profiles", "env-soak7"), { recursive: true });
  const options = {
    isPackaged: false,
    workspaceRoot: worktree,
    userDataPath: join(dataRoot, "profiles", "env-soak7"),
    now: () => new Date("2026-10-28T00:00:00Z"),
    logger: quiet
  };
  const env = (extra: Record<string, string> = {}) => ({
    [soakKnobName]: "scripts/soak/plan.json",
    MEMORA_SOAK_PROFILE: "soak7",
    MEMORA_SOAK_DATA_ROOT: dataRoot,
    [realWriterKnobName]: writerId,
    ...extra
  });
  return { worktree, dataRoot, options, env };
}

const adapter = (providerId: string, modelId: string): AiModelAdapter => ({
  describe: () => ({
    providerId,
    modelId,
    runtime: providerId === "local-gguf" ? "local" : "remote",
    capabilities: ["structured-output", "embedding"],
    parameterCapabilities: {},
    limits: {},
    requirements: {}
  }),
  canHandle: () => true,
  run: async () => {
    throw new Error("not called");
  }
});

describe("preparing the 7-day soak", () => {
  it("writes the run under the data root's f4 folder and prepares the overrides of the app", () => {
    const { dataRoot, options, env } = setup();
    const prepared = prepareSoak({ ...options, env: env() })!;
    expect(prepared.mode).toBe("soak");
    expect(prepared.honourTreatAsRemote).toBe(true);
    expect(prepared.directory).toBe(join(dataRoot, "f4", "soak", "soak7-20261028T000000"));
    // The fault layer in front of the real Codex adapter.
    expect(prepared.codexFetch).toBeTypeOf("function");
    // The Codex daily cap is the typed one until a window overrides it.
    expect(prepared.subscriptionDailyCalls?.()).toBe(
      defaultRemoteBudgetConfig.subscriptionDailyCalls
    );
    // The money window's fake is priced in the soak's copy of the table, not in the product's.
    const table = prepared.priceTable(defaultPriceTable);
    expect(table.entries.some((entry) => entry.model === "dev-fake-priced-1")).toBe(true);
    expect(defaultPriceTable.entries.some((entry) => entry.model === "dev-fake-priced-1")).toBe(
      false
    );
  });

  it("names the run as the knob says", () => {
    const { dataRoot, options, env } = setup();
    const prepared = prepareSoak({ ...options, env: env({ MEMORA_SOAK_RUN: "soak7-gate-1" }) })!;
    expect(prepared.directory).toBe(join(dataRoot, "f4", "soak", "soak7-gate-1"));
  });

  it("puts the token cap on the real Codex writer through the registry's one slot, beside the GGUF abort", () => {
    const { options, env } = setup();
    prepareSoak({ ...options, env: env() })!.installAdapterDecorator();
    const registry = new AiModelRegistry();
    const codex = adapter("openai-codex", "gpt-5.6-luna");
    const fake = adapter("openai-codex", "dev-fake-explain-1");
    const gguf = adapter("local-gguf", "qwen3-embedding");
    const other = adapter("openai-compatible", "gpt-5");
    // The real writer is wrapped by the cap; the fake Codex wire, another provider and the
    // embedder (wrapped by the abort decorator, not the cap) are not capped.
    expect(registry.register(codex)).not.toBe(codex);
    expect(registry.register(fake)).toBe(fake);
    expect(registry.register(other)).toBe(other);
    expect(registry.register(gguf)).not.toBe(gguf);
  });

  it("leaves F3's soaks as they were: no fault layer, no cap, no override, the run in f3", () => {
    const worktree = mkdtempSync(join(tmpdir(), "soak24-"));
    scratch.push(worktree);
    mkdirSync(join(worktree, "scripts", "soak"), { recursive: true });
    writeFileSync(join(worktree, "scripts", "soak", "plan.json"), readFileSync(planPath, "utf8"));
    mkdirSync(join(worktree, ".cache", "profiles", "env-soak"), { recursive: true });
    const prepared = prepareSoak({
      env: {
        [fakeRemoteKnobName]: "scripts/soak/plan.json",
        [soakKnobName]: "scripts/soak/plan.json"
      },
      isPackaged: false,
      workspaceRoot: worktree,
      userDataPath: join(worktree, ".cache", "profiles", "env-soak"),
      now: () => new Date("2026-10-18T10:00:00Z"),
      logger: quiet
    })!;
    expect(prepared.codexFetch).toBeUndefined();
    expect(prepared.subscriptionDailyCalls).toBeUndefined();
    expect(prepared.priceTable(defaultPriceTable)).toBe(defaultPriceTable);
    expect(prepared.directory).toBe(
      join(worktree, ".cache", "f3", "soak", "soak24-20261018T100000")
    );
  });

  it("refuses the real writer without the soak: it runs only under the soak's token cap", () => {
    const { options, env } = setup();
    const withoutSoak = env({ [fakeRemoteKnobName]: "scripts/soak/plan.json" });
    delete (withoutSoak as Record<string, string | undefined>)[soakKnobName];
    expect(() => prepareSoak({ ...options, env: withoutSoak })).toThrow(
      expect.objectContaining({ code: "realWriter" })
    );
  });

  it("refuses the 7-day profile without the real writer, the discovery neighbours knob, and the Decisions admission its plan keeps off", () => {
    const { options, env } = setup();
    const noWriter = env();
    delete (noWriter as Record<string, string | undefined>)[realWriterKnobName];
    expect(() => prepareSoak({ ...options, env: noWriter })).toThrow(
      expect.objectContaining({ code: "needsRealWriter" })
    );
    expect(() =>
      prepareSoak({ ...options, env: env({ MEMORA_RELATIONS_DISCOVERY_NEIGHBOURS: "2" }) })
    ).toThrow(expect.objectContaining({ code: "conflictingKnob" }));
    expect(() =>
      prepareSoak({
        ...options,
        env: env({ [decisionsAdmitKnobName]: "1", MEMORA_RELATIONS_DECISIONS: "on" })
      })
    ).toThrow(expect.objectContaining({ code: "decisions" }));
  });
});
