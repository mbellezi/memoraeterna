// The ChatGPT / Codex sign-in of a journey (F5 T154, A6): the first-run view's own step 2 calls
// `ai.connectOpenAiCodex`, which opens auth.openai.com in the browser, waits on the loopback
// callback and asks the token and model endpoints. A journey cannot play a browser sign-in and must
// not call OpenAI, so the harness swaps that one ipcMain handler (removeHandler + handle, as
// `stubOpenDialog` rewires the dialog) for a stand-in that runs the product's own handler with the
// sign-in's outside world answered on this machine: the browser hand-off calls the app's own
// loopback callback with the state it was given, and the token and model requests are answered in
// process with the DEV Codex credential stub (`devCodexCredential`) and the cassette's writer
// model. The product then leaves exactly what a completed sign-in leaves (the pending credential
// in the AI service, the model list in the renderer), and `ai.saveProvider` stores the stub in the
// scratch profile's credential file. Every other request goes through untouched, and the browser
// hand-off is restored after the call.
import type { ElectronApplication } from "@playwright/test";

/** The DEV Codex credential stub (`M/services/dev/fake-codex-provider.ts`): a fixed dummy, never a token. */
export const devCodexCredential = {
  access: "dev-fake-codex-access-token",
  refresh: "dev-fake-codex-refresh-token",
  /** 2100-01-01: beyond any refresh margin. */
  expires: 4_102_444_800_000,
  accountId: "dev-fake-codex-account"
} as const;

/** `ipcChannels.aiOpenAiCodexConnect` (`S/ipc.ts`). */
export const codexConnectChannel = "app:ai:openai-codex:connect";

/** What the stand-in answers, computed in the runner and handed to main as plain data. */
export interface CodexStandInPlan {
  channel: string;
  /** The browser hand-off is accepted only for this authorization endpoint. */
  authorizeUrl: string;
  /** The only redirect the hand-off calls back (the product's loopback callback). */
  redirectUri: string;
  tokenUrl: string;
  /** The model list of the Codex backend (`<base>/models?client_version=…`). */
  modelsUrl: string;
  code: string;
  tokenBody: string;
  modelsBody: string;
}

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * The plan for a sign-in that yields `credential` and offers `modelIds`. The access token is
 * JWT-shaped (unsigned) because the product reads the account id from its claims; refresh token,
 * account and expiry are the stub's. No model carries limits, as the first-run harness stores none.
 */
export function codexStandInPlan(input: {
  modelIds: readonly string[];
  credential?: { refresh: string; expires: number; accountId: string };
  now?: number;
}): CodexStandInPlan {
  const credential = input.credential ?? devCodexCredential;
  const now = input.now ?? Date.now();
  if (input.modelIds.length === 0) throw new Error("The stand-in sign-in needs a model to offer");
  const access = [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({ "https://api.openai.com/auth": { chatgpt_account_id: credential.accountId } }),
    "journeys-stand-in"
  ].join(".");
  return {
    channel: codexConnectChannel,
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    redirectUri: "http://localhost:1455/auth/callback",
    tokenUrl: "https://auth.openai.com/oauth/token",
    modelsUrl: "https://chatgpt.com/backend-api/codex/models",
    code: "journeys-stand-in-code",
    tokenBody: JSON.stringify({
      access_token: access,
      refresh_token: credential.refresh,
      expires_in: Math.max(1, Math.floor((credential.expires - now) / 1000))
    }),
    modelsBody: JSON.stringify({
      models: input.modelIds.map((slug) => ({ slug, display_name: slug, visibility: "list" }))
    })
  };
}

interface IpcMainLike {
  _invokeHandlers?: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  removeHandler: (channel: string) => void;
  handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void;
}
interface ElectronLike {
  ipcMain: IpcMainLike;
  shell: { openExternal: (url: string, options?: unknown) => Promise<void> };
}

/**
 * Runs in main (through `electronApp.evaluate`, so it refers to nothing outside itself): replaces the
 * connect handler with the stand-in described above. Exported for its unit test.
 */
export function installCodexStandIn(electron: ElectronLike, plan: CodexStandInPlan): void {
  const { ipcMain, shell } = electron;
  const original = ipcMain._invokeHandlers?.get(plan.channel);
  if (typeof original !== "function")
    throw new Error(`No ipcMain handler is registered for ${plan.channel}`);
  const urlOf = (input: unknown): string =>
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : String((input as { url?: unknown }).url ?? "");
  const json = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  ipcMain.removeHandler(plan.channel);
  ipcMain.handle(plan.channel, async (event: unknown, ...args: unknown[]) => {
    const realFetch = globalThis.fetch;
    const realOpen = shell.openExternal;
    shell.openExternal = async (target: string) => {
      const url = new URL(target);
      if (`${url.origin}${url.pathname}` !== plan.authorizeUrl)
        throw new Error("The stand-in sign-in opens only the authorization page");
      const redirect = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (redirect !== plan.redirectUri || !state)
        throw new Error("The authorization page was asked without the loopback callback");
      const callback = new URL(redirect);
      callback.searchParams.set("code", plan.code);
      callback.searchParams.set("state", state);
      const answer = await realFetch(callback.href);
      if (!answer.ok) throw new Error(`The loopback callback answered ${answer.status}`);
    };
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = urlOf(input);
      if (url === plan.tokenUrl) {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.get("grant_type") !== "authorization_code" || body.get("code") !== plan.code)
          return new Response("{}", { status: 400 });
        return json(plan.tokenBody);
      }
      if (url.startsWith(plan.modelsUrl)) return json(plan.modelsBody);
      return realFetch(input as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;
    try {
      return await original(event, ...args);
    } finally {
      globalThis.fetch = realFetch;
      shell.openExternal = realOpen;
    }
  });
}

/**
 * Makes the app's ChatGPT / Codex sign-in complete at once with the DEV credential stub, offering
 * `modelIds`. Only a journey's scratch profile ever runs it (the harness launches no other).
 */
export async function stubCodexSignIn(
  electronApp: ElectronApplication,
  modelIds: readonly string[]
): Promise<void> {
  const plan = codexStandInPlan({ modelIds });
  await electronApp.evaluate(
    installCodexStandIn as unknown as (
      electron: typeof import("electron"),
      plan: CodexStandInPlan
    ) => void,
    plan
  );
}
