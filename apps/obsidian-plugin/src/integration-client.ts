import {
  integrationContractVersion,
  integrationHandshakeResponseSchema,
  type IntegrationCommandResult,
  type IntegrationEvent,
  type ObsidianFileChangedEvent,
  type ObsidianFileDeletedEvent,
  type ObsidianFileMovedEvent,
  type ObsidianReconciliationRequest,
  type ImportObsidianNoteRequest
} from "@app/integration-contracts";

export interface ObsidianGatewaySettings {
  gatewayBaseUrl: string;
  clientId: string;
  pairingToken: string;
}

export class ObsidianGatewayClient {
  private sessionToken: string | null = null;
  private socket: WebSocket | null = null;
  private eventUrl: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private shouldReconnect = false;

  public constructor(
    private readonly getSettings: () => ObsidianGatewaySettings,
    private readonly onStatus: (connected: boolean) => void,
    private readonly onEvent: (event: IntegrationEvent) => void = () => undefined
  ) {}

  public async connect(): Promise<void> {
    const settings = this.getSettings();
    const response = await fetch(`${trimUrl(settings.gatewayBaseUrl)}/v1/handshake`, {
      method: "POST",
      headers: { authorization: `Bearer ${settings.pairingToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: integrationContractVersion,
        clientId: settings.clientId,
        client: { kind: "obsidian-plugin", name: "Memora Obsidian", contractVersion: integrationContractVersion },
        capabilities: ["import-obsidian-note", "watch-obsidian-files", "reconcile-obsidian-vault", "receive-job-progress"],
        instanceId: "obsidian"
      })
    });
    if (!response.ok) throw await responseError(response);
    const handshake = integrationHandshakeResponseSchema.parse(await response.json());
    this.shouldReconnect = true;
    this.sessionToken = handshake.sessionToken;
    this.eventUrl = handshake.eventUrl;
    this.openEvents();
  }

  public importNote(input: ImportObsidianNoteRequest): Promise<IntegrationCommandResult> {
    return this.post("/v1/obsidian/import", input) as Promise<IntegrationCommandResult>;
  }

  public fileChanged(event: ObsidianFileChangedEvent): Promise<IntegrationCommandResult> {
    return this.post("/v1/obsidian/file-changed", event) as Promise<IntegrationCommandResult>;
  }

  public fileMoved(event: ObsidianFileMovedEvent): Promise<IntegrationCommandResult> {
    return this.post("/v1/obsidian/file-moved", event) as Promise<IntegrationCommandResult>;
  }

  public fileDeleted(event: ObsidianFileDeletedEvent): Promise<IntegrationCommandResult> {
    return this.post("/v1/obsidian/file-deleted", event) as Promise<IntegrationCommandResult>;
  }

  public reconcile(input: ObsidianReconciliationRequest): Promise<{ synced: number; conflicts: number; deleted: number }> {
    return this.post("/v1/obsidian/reconcile", input) as Promise<{ synced: number; conflicts: number; deleted: number }>;
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.onStatus(false);
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    if (!this.sessionToken) await this.connect();
    const settings = this.getSettings();
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
    return response.json();
  }

  private openEvents(): void {
    if (!this.eventUrl) return;
    const previous = this.socket;
    this.socket = null;
    previous?.close();
    const socket = new WebSocket(this.eventUrl);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.onStatus(true);
    });
    socket.addEventListener("message", (event) => {
      try { this.onEvent(JSON.parse(String(event.data)) as IntegrationEvent); } catch { /* invalid events are ignored */ }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onStatus(false);
      this.scheduleReconnect();
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
