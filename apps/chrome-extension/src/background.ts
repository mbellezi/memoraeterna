import {
  createSelectionCapture,
  createWebCapture,
  createYouTubeCapture,
  parseYouTubeVideoId,
  type ExtractedPage
} from "./capture.js";
import { ChromeGatewayClient, type GatewayClientSettings } from "./integration-client.js";

const client = new ChromeGatewayClient(loadSettings, (event) => {
  void chrome.storage.local.set({ latestGatewayEvent: event });
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get(["gatewayBaseUrl"]).then((stored) => {
    if (!stored.gatewayBaseUrl) return chrome.storage.local.set({ gatewayBaseUrl: "http://127.0.0.1:47831" });
    return undefined;
  });
});

chrome.runtime.onStartup.addListener(() => {
  void client.connect().catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message: { type?: string; mode?: string; settings?: GatewayClientSettings }, _sender, sendResponse) => {
  if (message.type === "save-settings" && message.settings) {
    void chrome.storage.local.set(message.settings).then(() => client.connect()).then(
      () => sendResponse({ ok: true }),
      (error: unknown) => sendResponse({ ok: false, error: normalizeError(error) })
    );
    return true;
  }
  if (message.type === "get-settings") {
    void loadStoredSettings().then(
      (settings) => sendResponse({ ok: true, settings }),
      (error: unknown) => sendResponse({ ok: false, error: normalizeError(error) })
    );
    return true;
  }
  if (message.type === "capture") {
    void captureActiveTab(message.mode === "selection").then(
      (result) => sendResponse({ ok: true, result }),
      (error: unknown) => sendResponse({ ok: false, error: normalizeError(error) })
    );
    return true;
  }
  return false;
});

async function captureActiveTab(selectionOnly: boolean) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("active_tab_unavailable");
  const page = await chrome.tabs.sendMessage(tab.id, { type: "extract-page" }) as ExtractedPage;
  if (selectionOnly) return client.post("/v1/capture/selection", createSelectionCapture(page));
  const videoId = parseYouTubeVideoId(page.url);
  return videoId
    ? client.post("/v1/capture/youtube", createYouTubeCapture(page, videoId))
    : client.post("/v1/capture/web-page", createWebCapture(page));
}

async function loadSettings(): Promise<GatewayClientSettings> {
  const stored = await loadStoredSettings();
  if (!stored.gatewayBaseUrl || !stored.clientId || !stored.pairingToken) throw new Error("pairing_required");
  return stored;
}

async function loadStoredSettings(): Promise<GatewayClientSettings> {
  const stored = await chrome.storage.local.get(["gatewayBaseUrl", "clientId", "pairingToken"]);
  return {
    gatewayBaseUrl: String(stored.gatewayBaseUrl ?? "http://127.0.0.1:47831"),
    clientId: String(stored.clientId ?? ""),
    pairingToken: String(stored.pairingToken ?? "")
  };
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}
