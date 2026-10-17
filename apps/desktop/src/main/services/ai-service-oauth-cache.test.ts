import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpAiConfigGeneration } from "@app/db";

import { AiService } from "./ai-service.js";

const state = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  get: vi.fn(),
  save: vi.fn(),
  refresh: vi.fn(),
  listProviders: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({ listProviders: state.listProviders })
}));
vi.mock("./credential-service.js", () => ({
  CredentialService: class {
    public get = state.get;
    public save = state.save;
    public remove = vi.fn();
  }
}));
vi.mock("./openai-codex-oauth.js", async () => ({
  ...(await vi.importActual("./openai-codex-oauth.js")),
  refreshOpenAiCodexCredential: state.refresh
}));

const configId = "00000000-0000-4000-8000-0000000000c1";
const credential = (access: string, expires: number) =>
  JSON.stringify({ access, refresh: `refresh-of-${access}`, expires, accountId: "account" });
const hour = 60 * 60_000;

const pool = {} as never;

function service() {
  const ai = new AiService({
    userDataPath: "/tmp/oauth-cache-tests",
    getPool: () => pool,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false
  });
  return ai as unknown as { createAdapter(id: string): Promise<object> };
}

describe("the cached adapter of an OAuth provider (F3 D38)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    state.secrets.clear();
    state.secrets.set("ref", credential("token-1", Date.now() + hour));
    state.get.mockReset().mockImplementation(async (ref: string) => state.secrets.get(ref));
    // A save moves the generation, as the real credential service does.
    state.save.mockReset().mockImplementation(async (secret: string, ref: string) => {
      state.secrets.set(ref, secret);
      bumpAiConfigGeneration();
      return ref;
    });
    state.refresh.mockReset().mockImplementation(async () => ({
      access: "token-2",
      refresh: "refresh-of-token-2",
      expires: Date.now() + hour,
      accountId: "account"
    }));
    state.listProviders.mockReset().mockResolvedValue([
      {
        id: configId,
        provider: "openai-codex",
        displayName: "Codex",
        credentialRef: "ref",
        baseUrl: null,
        defaultParameters: {},
        status: "configured",
        metadata: { modelId: "gpt-test", capabilities: ["text-generation"] },
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps one adapter, and one decryption, while the access token is valid", async () => {
    const ai = service();
    const first = await ai.createAdapter(configId);
    expect(await ai.createAdapter(configId)).toBe(first);
    expect(state.get).toHaveBeenCalledTimes(1);
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("refreshes the token once for callers that meet its expiry together, and builds a new adapter", async () => {
    const ai = service();
    const first = await ai.createAdapter(configId);
    // Inside the margin before the token expires.
    vi.setSystemTime(Date.now() + hour - 30_000);
    const adapters = await Promise.all([
      ai.createAdapter(configId),
      ai.createAdapter(configId),
      ai.createAdapter(configId)
    ]);
    expect(state.refresh).toHaveBeenCalledOnce();
    expect(state.refresh).toHaveBeenCalledWith("refresh-of-token-1");
    expect(JSON.parse(state.secrets.get("ref")!)).toMatchObject({ access: "token-2" });
    expect(adapters[0]).not.toBe(first);
    expect(adapters[1]).toBe(adapters[0]);
    expect(adapters[2]).toBe(adapters[0]);
    // The new adapter is the cached one from then on.
    expect(await ai.createAdapter(configId)).toBe(adapters[0]);
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it("fails the way it always did when the refresh fails", async () => {
    const ai = service();
    await ai.createAdapter(configId);
    vi.setSystemTime(Date.now() + hour);
    state.refresh.mockRejectedValue(new Error("refused"));
    await expect(ai.createAdapter(configId)).rejects.toThrow("errors.ai.oauthRefreshFailed");
  });
});
