import { createHash, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { integrationContractVersion, type IntegrationHandshakeResponse } from "@app/integration-contracts";
import type { IntegrationClientRecord, IntegrationClientStatus } from "@app/db";

import {
  IntegrationGateway,
  type IntegrationClientStore
} from "./integration-gateway.js";

const gateways: IntegrationGateway[] = [];
const result = {
  sourceItemId: "967fca99-270a-4309-bff8-cad98f24a670",
  documentId: "83f7509d-71ea-4276-922c-c305eb9f7420",
  ingestionRunId: "1a53c3d9-6bda-4c72-b82c-36dcac71ff13",
  jobId: "7d18118a-6c6d-484a-930c-7d819d33e288",
  batchId: "f03b81bd-3c8b-4d04-a0c1-21bc199ade08",
  structureId: null,
  requiresStructureReview: false,
  duplicate: false
};

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
});

describe("IntegrationGateway", () => {
  it("authorizes a handshake and rejects invalid clients and payloads", async () => {
    const captureWebPage = vi.fn(async () => result);
    const gateway = createGateway(captureWebPage);
    gateways.push(gateway);
    const status = await gateway.start();
    const pairing = await gateway.createPairing({ clientType: "chrome-extension", displayName: "Chrome" });
    const unauthorized = await fetch(`${status.baseUrl}/v1/handshake`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);
    const handshake = await createSession(status.baseUrl!, pairing);
    const invalid = await fetch(`${status.baseUrl}/v1/capture/web-page`, {
      method: "POST",
      headers: { authorization: `Bearer ${handshake.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID() })
    });
    expect(invalid.status).toBe(400);
    const accepted = await fetch(`${status.baseUrl}/v1/capture/web-page`, {
      method: "POST",
      headers: { authorization: `Bearer ${handshake.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: randomUUID(),
        url: "https://example.com/article",
        title: "Article",
        capturedAt: new Date().toISOString(),
        textContent: "Useful content",
        metadata: {}
      })
    });
    expect(accepted.status).toBe(202);
    expect(captureWebPage).toHaveBeenCalledOnce();
  });

  it("delivers events after a WebSocket reconnect", async () => {
    const gateway = createGateway(vi.fn(async () => result));
    gateways.push(gateway);
    const status = await gateway.start();
    const pairing = await gateway.createPairing({ clientType: "chrome-extension", displayName: "Chrome" });
    const handshake = await createSession(status.baseUrl!, pairing);
    const first = await openSocket(handshake.eventUrl);
    first.close();
    await new Promise<void>((resolve) => first.once("close", () => resolve()));
    const second = await openSocket(handshake.eventUrl);
    const message = new Promise<string>((resolve) => second.once("message", (data) => resolve(data.toString())));
    gateway.publish({
      eventId: randomUUID(),
      type: "job-progress",
      jobId: result.jobId,
      status: "running",
      progress: 0.5,
      emittedAt: new Date().toISOString()
    });
    expect(JSON.parse(await message)).toMatchObject({ type: "job-progress", progress: 0.5 });
    second.close();
  });
});

function createGateway(captureWebPage: (input: never) => Promise<typeof result>): IntegrationGateway {
  return new IntegrationGateway({
    getPool: () => null,
    preferredPort: 0,
    clientStore: createMemoryStore(),
    ingestionService: {
      captureWebPage,
      captureSelection: async () => result,
      captureYouTube: async () => result,
      importObsidianNote: async () => result
    },
    obsidianSyncService: {
      handleChanged: async (event) => ({ requestId: event.eventId, accepted: true, syncStatus: "synced" }),
      handleMoved: async (event) => ({ requestId: event.eventId, accepted: true, syncStatus: "synced" }),
      handleDeleted: async (event) => ({ requestId: event.eventId, accepted: true, syncStatus: "deleted" }),
      reconcileSnapshot: async () => ({ synced: 0, conflicts: 0, deleted: 0 }),
      reconcileVault: async () => ({ synced: 0, conflicts: 0, deleted: 0 })
    },
    jobSupervisor: { list: async () => [] }
  });
}

async function createSession(baseUrl: string, pairing: { clientId: string; token: string }): Promise<IntegrationHandshakeResponse> {
  const response = await fetch(`${baseUrl}/v1/handshake`, {
    method: "POST",
    headers: { authorization: `Bearer ${pairing.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      contractVersion: integrationContractVersion,
      clientId: pairing.clientId,
      client: { kind: "chrome-extension", name: "Chrome", contractVersion: integrationContractVersion },
      capabilities: ["capture-web-page", "capture-selection", "capture-youtube-video", "receive-job-progress"]
    })
  });
  expect(response.status).toBe(200);
  return await response.json() as IntegrationHandshakeResponse;
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function createMemoryStore(): IntegrationClientStore {
  const records = new Map<string, IntegrationClientRecord>();
  return {
    async create(input) {
      const now = new Date();
      const record: IntegrationClientRecord = {
        id: randomUUID(),
        clientType: input.clientType,
        displayName: input.displayName,
        tokenHash: input.tokenHash,
        scopes: input.scopes,
        capabilities: input.capabilities,
        contractVersion: input.contractVersion,
        status: "paired",
        lastSeenAt: null,
        createdAt: now,
        updatedAt: now
      };
      records.set(record.id, record);
      return record;
    },
    async findById(id) { return records.get(id) ?? null; },
    async findAuthorizedByTokenHash(tokenHash) {
      return [...records.values()].find((record) => record.tokenHash === tokenHash && record.status === "paired") ?? null;
    },
    async touch(id, input) {
      const record = records.get(id);
      if (record) records.set(id, { ...record, ...input, lastSeenAt: new Date() });
    },
    async setStatus(id, status: IntegrationClientStatus) {
      const record = records.get(id);
      if (!record) return null;
      const updated = { ...record, status };
      records.set(id, updated);
      return updated;
    },
    async list() { return [...records.values()]; }
  };
}

void createHash;
