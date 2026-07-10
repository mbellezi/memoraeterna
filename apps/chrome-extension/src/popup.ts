const gatewayInput = element<HTMLInputElement>("gatewayBaseUrl");
const clientIdInput = element<HTMLInputElement>("clientId");
const tokenInput = element<HTMLInputElement>("pairingToken");
const status = element<HTMLElement>("status");

for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
  node.textContent = chrome.i18n.getMessage(node.dataset.i18n ?? "");
}

void send({ type: "get-settings" }).then((response) => {
  if (!response.ok) return;
  gatewayInput.value = response.settings.gatewayBaseUrl;
  clientIdInput.value = response.settings.clientId;
  tokenInput.value = response.settings.pairingToken;
});

element<HTMLButtonElement>("save").addEventListener("click", () => run(async () => {
  const response = await send({
    type: "save-settings",
    settings: {
      gatewayBaseUrl: gatewayInput.value.trim(),
      clientId: clientIdInput.value.trim(),
      pairingToken: tokenInput.value.trim()
    }
  });
  if (!response.ok) throw new Error(response.error);
  return "statusConnected";
}));

element<HTMLButtonElement>("capturePage").addEventListener("click", () => run(async () => {
  const response = await send({ type: "capture", mode: "page" });
  if (!response.ok) throw new Error(response.error);
  return "statusCaptured";
}));

element<HTMLButtonElement>("captureSelection").addEventListener("click", () => run(async () => {
  const response = await send({ type: "capture", mode: "selection" });
  if (!response.ok) throw new Error(response.error);
  return "statusCaptured";
}));

async function run(action: () => Promise<string>) {
  status.textContent = chrome.i18n.getMessage("statusWorking");
  try {
    status.textContent = chrome.i18n.getMessage(await action());
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown_error";
    status.textContent = chrome.i18n.getMessage(code === "pairing_required" ? "statusPairingRequired" : "statusDesktopUnavailable");
  }
}

function send(message: unknown): Promise<any> {
  return chrome.runtime.sendMessage(message);
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`missing_${id}`);
  return value as T;
}
