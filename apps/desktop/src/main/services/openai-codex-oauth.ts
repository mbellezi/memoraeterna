import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const authorizeUrl = "https://auth.openai.com/oauth/authorize";
const tokenUrl = "https://auth.openai.com/oauth/token";
const redirectUri = "http://localhost:1455/auth/callback";
const callbackHost = "localhost";
const callbackPort = 1455;
const callbackPath = "/auth/callback";
const tokenTimeoutMs = 30_000;
const loginTimeoutMs = 5 * 60_000;
const maximumTokenResponseBytes = 1024 * 1024;

export interface OpenAiCodexCredential {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
  planType?: string;
}

export interface OpenAiCodexOAuthPageText {
  successTitle: string;
  successDescription: string;
  errorTitle: string;
  closeWindow: string;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export async function loginOpenAiCodex(options: {
  openExternal: (url: string) => Promise<void>;
  pageText: OpenAiCodexOAuthPageText;
  fetch?: typeof fetch;
}): Promise<OpenAiCodexCredential> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const url = buildAuthorizationUrl(challenge, state);
  const callback = await waitForCallback(state, options.pageText);
  try {
    await options.openExternal(url);
    const code = await callback.code;
    return exchangeAuthorizationCode(code, verifier, options.fetch ?? fetch);
  } finally {
    callback.cancel();
    callback.close();
  }
}

export async function refreshOpenAiCodexCredential(
  refreshToken: string,
  fetchImplementation: typeof fetch = fetch
): Promise<OpenAiCodexCredential> {
  return requestTokens(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId
  }), fetchImplementation);
}

export function parseOpenAiCodexCredential(value: string): OpenAiCodexCredential {
  const parsed = JSON.parse(value) as Partial<OpenAiCodexCredential>;
  if (typeof parsed.access !== "string" || typeof parsed.refresh !== "string"
      || typeof parsed.expires !== "number" || typeof parsed.accountId !== "string") {
    throw new Error("errors.ai.oauthCredentialInvalid");
  }
  return {
    access: parsed.access,
    refresh: parsed.refresh,
    expires: parsed.expires,
    accountId: parsed.accountId,
    ...(typeof parsed.planType === "string" ? { planType: parsed.planType } : {})
  };
}

function buildAuthorizationUrl(challenge: string, state: string): string {
  const url = new URL(authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "memora-eterna");
  return url.toString();
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  fetchImplementation: typeof fetch
): Promise<OpenAiCodexCredential> {
  return requestTokens(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri
  }), fetchImplementation);
}

async function requestTokens(
  body: URLSearchParams,
  fetchImplementation: typeof fetch
): Promise<OpenAiCodexCredential> {
  const response = await fetchImplementation(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(tokenTimeoutMs)
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumTokenResponseBytes) throw new Error("errors.ai.oauthTokenResponseInvalid");
  if (!response.ok) throw new Error(`errors.ai.oauthTokenExchangeFailed:${response.status}`);
  const payload = JSON.parse(text) as TokenResponse;
  if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string"
      || typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in)
      || payload.expires_in <= 0) {
    throw new Error("errors.ai.oauthTokenResponseInvalid");
  }
  const identity = readTokenIdentity(payload.access_token);
  if (!identity.accountId) throw new Error("errors.ai.oauthTokenResponseInvalid");
  return {
    access: payload.access_token,
    refresh: payload.refresh_token,
    expires: Date.now() + payload.expires_in * 1000,
    accountId: identity.accountId,
    ...(identity.planType ? { planType: identity.planType } : {})
  };
}

function readTokenIdentity(accessToken: string): { accountId?: string; planType?: string } {
  const tokenParts = accessToken.split(".");
  if (tokenParts.length !== 3) return {};
  try {
    const payload = JSON.parse(Buffer.from(tokenParts[1] ?? "", "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown; chatgpt_plan_type?: unknown };
    };
    const auth = payload["https://api.openai.com/auth"];
    return {
      ...(typeof auth?.chatgpt_account_id === "string" ? { accountId: auth.chatgpt_account_id } : {}),
      ...(typeof auth?.chatgpt_plan_type === "string" ? { planType: auth.chatgpt_plan_type } : {})
    };
  } catch {
    return {};
  }
}

async function waitForCallback(
  expectedState: string,
  pageText: OpenAiCodexOAuthPageText
): Promise<{ code: Promise<string>; cancel: () => void; close: () => void }> {
  let server: Server;
  let timeout: ReturnType<typeof setTimeout>;
  let cancel = () => {};
  const code = new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };
    cancel = () => settle(() => reject(new Error("errors.ai.oauthLoginFailed")));
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
      if (url.pathname !== callbackPath) {
        response.statusCode = 404;
        response.end(renderPage(pageText.errorTitle, pageText.closeWindow));
        return;
      }
      const oauthError = url.searchParams.get("error");
      const state = url.searchParams.get("state");
      const authorizationCode = url.searchParams.get("code");
      if (oauthError || state !== expectedState || !authorizationCode) {
        response.statusCode = 400;
        response.end(renderPage(pageText.errorTitle, pageText.closeWindow));
        settle(() => reject(new Error(state !== expectedState
          ? "errors.ai.oauthStateMismatch"
          : "errors.ai.oauthLoginFailed")));
        return;
      }
      response.statusCode = 200;
      response.end(renderPage(pageText.successTitle, pageText.successDescription));
      settle(() => resolve(authorizationCode));
    });
    server.once("error", () => settle(() => reject(new Error("errors.ai.oauthCallbackUnavailable"))));
    server.listen(callbackPort, callbackHost);
    timeout = setTimeout(() => settle(() => reject(new Error("errors.ai.oauthTimedOut"))), loginTimeoutMs);
    timeout.unref?.();
  });
  void code.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    if (server!.listening) { resolve(); return; }
    server!.once("listening", resolve);
    server!.once("error", reject);
  }).catch(() => {
    throw new Error("errors.ai.oauthCallbackUnavailable");
  });
  return { code, cancel, close: () => server!.close() };
}

function renderPage(title: string, description: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;min-height:100vh;place-items:center;margin:0}main{max-width:32rem;padding:2rem;border:1px solid #334155;border-radius:1rem;background:#111827}h1{font-size:1.25rem}p{color:#94a3b8}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character] ?? character);
}

export const openAiCodexOAuthTesting = {
  buildAuthorizationUrl,
  readTokenIdentity,
  requestTokens
};
