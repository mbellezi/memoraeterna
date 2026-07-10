import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  captureSelectionRequestSchema,
  captureWebPageRequestSchema,
  captureYouTubeVideoRequestSchema,
  integrationContractVersion,
  integrationErrorSchema,
  integrationHandshakeResponseSchema,
  integrationHandshakeSchema,
  isIntegrationContractVersionCompatible,
  normalizeIntegrationError,
  importObsidianNoteRequestSchema,
  obsidianFileChangedEventSchema,
  obsidianFileDeletedEventSchema,
  obsidianFileMovedEventSchema,
  obsidianReconciliationRequestSchema,
  type IntegrationCapability,
  type IntegrationError,
  type IntegrationEvent
} from "@app/integration-contracts";
import {
  createIntegrationClientRepository,
  type IntegrationClientRecord,
  type IntegrationClientStatus,
  type PgPool
} from "@app/db";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import type { IngestionService } from "./ingestion-service.js";
import type { JobSupervisor } from "./job-supervisor.js";
import type { ObsidianSyncService } from "./obsidian-sync-service.js";

export interface IntegrationGatewayStatus {
  state: "stopped" | "starting" | "ready" | "failed";
  host: "127.0.0.1";
  port: number | null;
  baseUrl: string | null;
}

export interface PairingResult {
  clientId: string;
  token: string;
}

export interface IntegrationClientStore {
  create(input: {
    clientType: string;
    displayName: string;
    tokenHash: string;
    scopes: string[];
    capabilities: string[];
    contractVersion: string;
  }): Promise<IntegrationClientRecord>;
  findById(id: string): Promise<IntegrationClientRecord | null>;
  findAuthorizedByTokenHash(tokenHash: string): Promise<IntegrationClientRecord | null>;
  touch(id: string, input: { capabilities: string[]; contractVersion: string }): Promise<void>;
  setStatus(id: string, status: IntegrationClientStatus): Promise<IntegrationClientRecord | null>;
  list(): Promise<IntegrationClientRecord[]>;
}

export interface IntegrationGatewayOptions {
  getPool: () => PgPool | null;
  ingestionService: Pick<IngestionService, "captureWebPage" | "captureSelection" | "captureYouTube" | "importObsidianNote">;
  obsidianSyncService: Pick<
    ObsidianSyncService,
    "handleChanged" | "handleMoved" | "handleDeleted" | "reconcileSnapshot" | "reconcileVault"
  >;
  jobSupervisor: Pick<JobSupervisor, "list">;
  preferredPort?: number;
  clientStore?: IntegrationClientStore;
  logger?: Pick<Console, "warn" | "error">;
}

interface Session {
  clientId: string;
  capabilities: Set<IntegrationCapability>;
  expiresAt: number;
}

interface SocketClient {
  socket: WebSocket;
  session: Session;
}

const handshakePath = "/v1/handshake";
const maxBodyBytes = 10 * 1024 * 1024;
const sessionLifetimeMs = 24 * 60 * 60 * 1000;

export class IntegrationGateway {
  private server: Server | null = null;
  private webSockets: WebSocketServer | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly sockets = new Set<SocketClient>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollPromise: Promise<void> | null = null;
  private stopping = false;
  private readonly jobSignatures = new Map<string, string>();
  private status: IntegrationGatewayStatus = { state: "stopped", host: "127.0.0.1", port: null, baseUrl: null };

  public constructor(private readonly options: IntegrationGatewayOptions) {}

  public getStatus(): IntegrationGatewayStatus {
    return { ...this.status };
  }

  public async start(): Promise<IntegrationGatewayStatus> {
    if (this.server) return this.getStatus();
    this.stopping = false;
    this.status = { ...this.status, state: "starting" };
    const server = createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    const webSockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      const session = this.readWebSocketSession(request);
      if (!session) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        const client = { socket: webSocket, session };
        this.sockets.add(client);
        webSocket.on("close", () => this.sockets.delete(client));
        webSocket.on("error", () => this.sockets.delete(client));
      });
    });
    try {
      const preferred = normalizePort(this.options.preferredPort) ?? 47831;
      let port: number;
      try {
        port = await listen(server, preferred);
      } catch (error) {
        if (!isAddressInUse(error)) throw error;
        this.options.logger?.warn("integration_gateway_port_conflict");
        port = await listen(server, 0);
      }
      this.server = server;
      this.webSockets = webSockets;
      this.status = {
        state: "ready",
        host: "127.0.0.1",
        port,
        baseUrl: `http://127.0.0.1:${port}`
      };
      this.scheduleJobPolling(0);
      return this.getStatus();
    } catch (error) {
      this.status = { state: "failed", host: "127.0.0.1", port: null, baseUrl: null };
      server.close();
      webSockets.close();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    for (const client of this.sockets) client.socket.close(1001, "gateway_stopping");
    this.sockets.clear();
    this.sessions.clear();
    await this.pollPromise;
    this.webSockets?.close();
    this.webSockets = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.status = { state: "stopped", host: "127.0.0.1", port: null, baseUrl: null };
  }

  public async createPairing(input: {
    clientType: "chrome-extension" | "obsidian-plugin";
    displayName: string;
  }): Promise<PairingResult> {
    const token = `memora_${randomBytes(32).toString("base64url")}`;
    const capabilities = capabilitiesForClient(input.clientType);
    const client = await this.store().create({
      clientType: input.clientType,
      displayName: input.displayName,
      tokenHash: hashToken(token),
      scopes: capabilities,
      capabilities,
      contractVersion: integrationContractVersion
    });
    return { clientId: client.id, token };
  }

  public async listClients(): Promise<Array<Omit<IntegrationClientRecord, "tokenHash">>> {
    return (await this.store().list()).map(({ tokenHash: _tokenHash, ...client }) => client);
  }

  public async revokeClient(clientId: string): Promise<boolean> {
    const revoked = Boolean(await this.store().setStatus(clientId, "revoked"));
    if (!revoked) return false;
    for (const [tokenHash, session] of this.sessions) {
      if (session.clientId === clientId) this.sessions.delete(tokenHash);
    }
    for (const client of this.sockets) {
      if (client.session.clientId === clientId) client.socket.close(1008, "client_revoked");
    }
    return true;
  }

  public publish(event: IntegrationEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.sockets) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (event.type === "job-progress" && !client.session.capabilities.has("receive-job-progress")) continue;
      client.socket.send(payload);
    }
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const path = safePath(request.url);
    try {
      if (request.method === "GET" && path === "/health") {
        this.sendJson(response, 200, { status: "ready", contractVersion: integrationContractVersion });
        return;
      }
      if (request.method === "POST" && path === handshakePath) {
        await this.handleHandshake(request, response);
        return;
      }
      const session = this.authenticateSession(request);
      if (!session) throw new GatewayError("unauthorized", "integrations.errors.unauthorized", false, 401);
      if (request.method !== "POST") throw new GatewayError("not_found", "integrations.errors.notFound", false, 404);
      const body = await readJson(request);
      if (path === "/v1/capture/web-page") {
        requireCapability(session, "capture-web-page");
        const input = captureWebPageRequestSchema.parse(body);
        const result = await this.options.ingestionService.captureWebPage(input);
        this.sendJson(response, 202, { requestId: input.requestId, accepted: true, ...result });
        return;
      }
      if (path === "/v1/capture/selection") {
        requireCapability(session, "capture-selection");
        const input = captureSelectionRequestSchema.parse(body);
        const result = await this.options.ingestionService.captureSelection(input);
        this.sendJson(response, 202, { requestId: input.requestId, accepted: true, ...result });
        return;
      }
      if (path === "/v1/capture/youtube") {
        requireCapability(session, "capture-youtube-video");
        const input = captureYouTubeVideoRequestSchema.parse(body);
        const result = await this.options.ingestionService.captureYouTube(input);
        this.sendJson(response, 202, { requestId: input.requestId, accepted: true, ...result });
        return;
      }
      if (path === "/v1/obsidian/file-changed") {
        requireCapability(session, "watch-obsidian-files");
        this.sendJson(response, 200, await this.options.obsidianSyncService.handleChanged(obsidianFileChangedEventSchema.parse(body)));
        return;
      }
      if (path === "/v1/obsidian/import") {
        requireCapability(session, "import-obsidian-note");
        const input = importObsidianNoteRequestSchema.parse(body);
        if (input.frontmatter) {
          this.sendJson(response, 200, await this.options.obsidianSyncService.handleChanged({
            eventId: input.requestId,
            kind: "modified",
            occurredAt: new Date().toISOString(),
            note: { ...input, frontmatter: input.frontmatter }
          }));
        } else {
          const result = await this.options.ingestionService.importObsidianNote(input);
          this.sendJson(response, 202, { requestId: input.requestId, accepted: true, ...result });
        }
        return;
      }
      if (path === "/v1/obsidian/file-moved") {
        requireCapability(session, "watch-obsidian-files");
        this.sendJson(response, 200, await this.options.obsidianSyncService.handleMoved(obsidianFileMovedEventSchema.parse(body)));
        return;
      }
      if (path === "/v1/obsidian/file-deleted") {
        requireCapability(session, "watch-obsidian-files");
        this.sendJson(response, 200, await this.options.obsidianSyncService.handleDeleted(obsidianFileDeletedEventSchema.parse(body)));
        return;
      }
      if (path === "/v1/obsidian/reconcile") {
        requireCapability(session, "reconcile-obsidian-vault");
        this.sendJson(response, 200, await this.options.obsidianSyncService.reconcileSnapshot(obsidianReconciliationRequestSchema.parse(body)));
        return;
      }
      throw new GatewayError("not_found", "integrations.errors.notFound", false, 404);
    } catch (error) {
      const normalized = gatewayError(error);
      this.options.logger?.warn("integration_gateway_request_failed", path, normalized.body.code);
      this.sendJson(response, normalized.status, integrationErrorSchema.parse(normalized.body));
    }
  }

  private async handleHandshake(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = readBearerToken(request);
    if (!token) throw new GatewayError("unauthorized", "integrations.errors.unauthorized", false, 401);
    const client = await this.store().findAuthorizedByTokenHash(hashToken(token));
    if (!client) throw new GatewayError("unauthorized", "integrations.errors.unauthorized", false, 401);
    const input = integrationHandshakeSchema.parse(await readJson(request));
    if (client.id !== input.clientId || client.clientType !== input.client.kind) {
      throw new GatewayError("forbidden", "integrations.errors.forbidden", false, 403);
    }
    if (!isIntegrationContractVersionCompatible(input.contractVersion)
        || !isIntegrationContractVersionCompatible(input.client.contractVersion)) {
      throw new GatewayError("incompatible_contract", "integrations.errors.incompatibleContract", false, 409);
    }
    const allowed = new Set(client.scopes);
    const capabilities = input.capabilities.filter((capability) => allowed.has(capability));
    if (capabilities.length !== input.capabilities.length) {
      throw new GatewayError("forbidden", "integrations.errors.forbidden", false, 403);
    }
    await this.store().touch(client.id, { capabilities, contractVersion: input.contractVersion });
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + sessionLifetimeMs;
    this.sessions.set(hashToken(sessionToken), {
      clientId: client.id,
      capabilities: new Set(capabilities),
      expiresAt
    });
    const baseUrl = this.status.baseUrl;
    if (!baseUrl) throw new Error("integration_gateway_not_ready");
    const eventUrl = `${baseUrl.replace(/^http/, "ws")}/v1/events?session=${encodeURIComponent(sessionToken)}`;
    this.sendJson(response, 200, integrationHandshakeResponseSchema.parse({
      contractVersion: integrationContractVersion,
      clientId: client.id,
      sessionToken,
      sessionExpiresAt: new Date(expiresAt).toISOString(),
      eventUrl,
      capabilities
    }));
    if (client.clientType === "obsidian-plugin") {
      void this.options.obsidianSyncService.reconcileVault().catch(() => undefined);
    }
  }

  private authenticateSession(request: IncomingMessage): Session | null {
    const token = readBearerToken(request);
    if (!token) return null;
    const key = hashToken(token);
    const session = this.sessions.get(key);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  private readWebSocketSession(request: IncomingMessage): Session | null {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/v1/events") return null;
    const token = url.searchParams.get("session");
    if (!token) return null;
    const session = this.sessions.get(hashToken(token));
    return session && session.expiresAt > Date.now() ? session : null;
  }

  private store(): IntegrationClientStore {
    if (this.options.clientStore) return this.options.clientStore;
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return createIntegrationClientRepository(pool);
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body)
    });
    response.end(body);
  }

  private scheduleJobPolling(delay: number): void {
    if (!this.server || this.stopping) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.pollPromise = this.pollJobs()
        .catch(() => this.options.logger?.warn("integration_gateway_job_poll_failed"))
        .finally(() => {
          this.pollPromise = null;
          this.scheduleJobPolling(500);
        });
    }, delay);
  }

  private async pollJobs(): Promise<void> {
    if (this.sockets.size === 0) return;
    for (const job of await this.options.jobSupervisor.list(100)) {
      const signature = `${job.status}:${job.progress}:${job.error ?? ""}`;
      if (this.jobSignatures.get(job.id) === signature) continue;
      this.jobSignatures.set(job.id, signature);
      this.publish({
        eventId: randomUUID(),
        type: "job-progress",
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        emittedAt: new Date().toISOString(),
        ...(job.error ? { errorCode: job.error.slice(0, 120) } : {})
      });
    }
  }
}

class GatewayError extends Error {
  public constructor(
    public readonly code: IntegrationError["code"],
    public readonly messageKey: string,
    public readonly retryable: boolean,
    public readonly status: number
  ) {
    super(code);
  }
}

function gatewayError(error: unknown): { status: number; body: IntegrationError } {
  if (error instanceof GatewayError) {
    return { status: error.status, body: { code: error.code, messageKey: error.messageKey, retryable: error.retryable } };
  }
  if (error instanceof z.ZodError) return { status: 400, body: normalizeIntegrationError(error) };
  return { status: 500, body: normalizeIntegrationError(error) };
}

function requireCapability(session: Session, capability: IntegrationCapability): void {
  if (!session.capabilities.has(capability)) {
    throw new GatewayError("forbidden", "integrations.errors.forbidden", false, 403);
  }
}

function capabilitiesForClient(kind: "chrome-extension" | "obsidian-plugin"): IntegrationCapability[] {
  return kind === "chrome-extension"
    ? ["capture-web-page", "capture-selection", "capture-youtube-video", "receive-job-progress"]
    : ["import-obsidian-note", "watch-obsidian-files", "reconcile-obsidian-vault", "receive-job-progress"];
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() || null : null;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new GatewayError("invalid_request", "integrations.errors.payloadTooLarge", false, 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GatewayError("invalid_request", "integrations.errors.invalidRequest", false, 400);
  }
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("cache-control", "no-store");
}

function safePath(url: string | undefined): string {
  try { return new URL(url ?? "/", "http://127.0.0.1").pathname; } catch { return "/"; }
}

function normalizePort(port: number | undefined): number | null {
  return typeof port === "number" && Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("integration_gateway_address_unavailable"));
      else resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
