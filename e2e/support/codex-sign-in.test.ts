import { afterEach, describe, expect, it } from "vitest";

import { loginOpenAiCodex } from "../../apps/desktop/src/main/services/openai-codex-oauth.js";
import {
  codexConnectChannel,
  codexStandInPlan,
  devCodexCredential,
  installCodexStandIn
} from "./codex-sign-in.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeElectron(
  original: (shell: { openExternal: (url: string) => Promise<void> }) => Handler
) {
  const handlers = new Map<string, Handler>();
  const shell = {
    openExternal: async (url: string): Promise<void> => {
      void url;
      throw new Error("the real browser was opened");
    }
  };
  const ipcMain = {
    _invokeHandlers: handlers,
    removeHandler: (channel: string) => void handlers.delete(channel),
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
      handlers.set(channel, handler);
    }
  };
  handlers.set(codexConnectChannel, original(shell));
  return { ipcMain, shell, handlers };
}

const pageText = {
  successTitle: "ok",
  successDescription: "ok",
  errorTitle: "no",
  closeWindow: "x"
};
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the stand-in Codex sign-in", () => {
  it("is refused when no connect handler is registered", () => {
    const electron = fakeElectron(() => async () => []);
    electron.handlers.clear();
    expect(() => installCodexStandIn(electron, codexStandInPlan({ modelIds: ["m"] }))).toThrow(
      /No ipcMain handler/
    );
  });

  it("drives the product's own OAuth login to the stub credential and the offered models, and restores the hand-off", async () => {
    // The original handler: what `connectOpenAiCodex` does (the login, then the model discovery).
    let credential: unknown = null;
    const electron = fakeElectron((shell) => async () => {
      credential = await loginOpenAiCodex({
        openExternal: (url) => shell.openExternal(url),
        pageText
      });
      const response = await fetch(
        "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0"
      );
      const payload = (await response.json()) as { models: { slug: string }[] };
      return payload.models.map((model) => model.slug);
    });
    const openBefore = electron.shell.openExternal;
    const now = Date.now();
    installCodexStandIn(electron, codexStandInPlan({ modelIds: ["gpt-writer"], now }));
    const handler = electron.handlers.get(codexConnectChannel)!;
    await expect(handler({})).resolves.toEqual(["gpt-writer"]);
    expect(credential).toMatchObject({
      refresh: devCodexCredential.refresh,
      accountId: devCodexCredential.accountId
    });
    const expires = (credential as { expires: number }).expires;
    expect(Math.abs(expires - devCodexCredential.expires)).toBeLessThan(60_000);
    expect(globalThis.fetch).toBe(realFetch);
    expect(electron.shell.openExternal).toBe(openBefore);
  });

  it("refuses a hand-off to anything but the authorization page", async () => {
    const electron = fakeElectron(
      (shell) => async () => shell.openExternal("https://example.com/")
    );
    installCodexStandIn(electron, codexStandInPlan({ modelIds: ["m"] }));
    await expect(electron.handlers.get(codexConnectChannel)!({})).rejects.toThrow(
      /only the authorization page/
    );
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("answers a token request only for its own code", async () => {
    const plan = codexStandInPlan({ modelIds: ["m"] });
    const electron = fakeElectron(() => async () => {
      const wrong = await fetch(plan.tokenUrl, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "authorization_code", code: "other" })
      });
      return wrong.status;
    });
    installCodexStandIn(electron, plan);
    await expect(electron.handlers.get(codexConnectChannel)!({})).resolves.toBe(400);
  });
});
