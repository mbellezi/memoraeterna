import {
  integrationContractVersion,
  integrationHandshakeResponseSchema,
  type IntegrationCommandResult,
  type IntegrationEvent
} from "@app/integration-contracts";

export interface GatewayClientSettings {
  gatewayBaseUrl: string;
  clientId: string;
  pairingToken: string;
}

export class ChromeGatewayClient {
  private sessionToken: string | null = null;
  private eventUrl: string | null = null;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private shouldReconnect = false;

  public constructor(
    private readonly getSettings: () => Promise<GatewayClientSettings>,
    private readonly onEvent: (event: IntegrationEvent) => void = () => undefined
  ) {}

  public async connect(): Promise<void> {
    const settings = await this.getSettings();
    const response = await fetch(`${trimUrl(settings.gatewayBaseUrl)}/v1/handshake`, {
      method: "POST",
      headers: { authorization: `Bearer ${settings.pairingToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: integrationContractVersion,
        clientId: settings.clientId,
        client: { kind: "chrome-extension", name: "Memora Chrome", contractVersion: integrationContractVersion },
        capabilities: ["capture-web-page", "capture-selection", "capture-youtube-video", "receive-job-progress"],
        instanceId: chrome.runtime.id
      })
    });
    if (!response.ok) throw await responseError(response);
    const handshake = integrationHandshakeResponseSchema.parse(await response.json());
    this.shouldReconnect = true;
    this.sessionToken = handshake.sessionToken;
    this.eventUrl = handshake.eventUrl;
    this.openEventSocket();
  }

  public async post(path: string, payload: unknown): Promise<IntegrationCommandResult> {
    if (!this.sessionToken) await this.connect();
    const settings = await this.getSettings();
    const response = await fetch(`${trimUrl(settings.gatewayBaseUrl)}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (response.status === 401) {
      this.sessionToken = null;
      await this.connect();
      return this.post(path, payload);
    }
    if (!response.ok) throw await responseError(response);
    return await response.json() as IntegrationCommandResult;
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private openEventSocket(): void {
    if (!this.eventUrl) return;
    const previous = this.socket;
    this.socket = null;
    previous?.close();
    const socket = new WebSocket(this.eventUrl);
    this.socket = socket;
    socket.addEventListener("open", () => { this.reconnectAttempt = 0; });
    socket.addEventListener("message", (event) => {
      try { this.onEvent(JSON.parse(String(event.data)) as IntegrationEvent); } catch { /* ignore invalid events */ }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      if (this.shouldReconnect && this.socket === null) this.scheduleReconnect();
    });
    socket.addEventListener("error", () => socket.close());
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { code?: string };
    return new Error(body.code ?? `gateway_${response.status}`);
  } catch {
    return new Error(`gateway_${response.status}`);
  }
}

function trimUrl(value: string): string {
  return value.replace(/\/+$/, "");
}
