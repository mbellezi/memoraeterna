import { describe, expect, it } from "vitest";

import {
  loginOpenAiCodex,
  openAiCodexOAuthTesting,
  refreshOpenAiCodexCredential
} from "./openai-codex-oauth.js";

describe("OpenAI Codex OAuth", () => {
  it("builds a PKCE authorization URL for the loopback callback", () => {
    const url = new URL(openAiCodexOAuthTesting.buildAuthorizationUrl("challenge", "state"));
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state");
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("refreshes rotating credentials and extracts the ChatGPT account", async () => {
    const token = createToken({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_plan_type: "plus"
      }
    });
    const fetchMock: typeof fetch = async (_input, init) => {
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      expect(String(init?.body)).toContain("refresh_token=old-refresh");
      return Response.json({ access_token: token, refresh_token: "new-refresh", expires_in: 3600 });
    };

    await expect(refreshOpenAiCodexCredential("old-refresh", fetchMock)).resolves.toMatchObject({
      access: token,
      refresh: "new-refresh",
      accountId: "account-1",
      planType: "plus"
    });
  });

  it("completes the loopback callback before exchanging the authorization code", async () => {
    const accessToken = createToken({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-loopback" }
    });
    const credential = await loginOpenAiCodex({
      openExternal: async (authorizationUrl) => {
        const state = new URL(authorizationUrl).searchParams.get("state");
        const response = await fetch(
          `http://localhost:1455/auth/callback?code=authorization-code&state=${encodeURIComponent(state ?? "")}`
        );
        expect(response.status).toBe(200);
      },
      pageText: {
        successTitle: "Connected",
        successDescription: "Return to the app.",
        errorTitle: "Failed",
        closeWindow: "Close this window."
      },
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://auth.openai.com/oauth/token");
        expect(String(init?.body)).toContain("code=authorization-code");
        expect(String(init?.body)).toContain("code_verifier=");
        return Response.json({
          access_token: accessToken,
          refresh_token: "refresh-loopback",
          expires_in: 3600
        });
      }
    });

    expect(credential).toMatchObject({
      access: accessToken,
      refresh: "refresh-loopback",
      accountId: "account-loopback"
    });
  });
});

function createToken(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature"
  ].join(".");
}
