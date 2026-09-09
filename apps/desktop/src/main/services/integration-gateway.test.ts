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

  it('requires an explicit editorial grant rather than upgrading old Obsidian pairings',async()=>{
    const store=createMemoryStore(),gateway=createGateway(vi.fn(async()=>result),store);gateways.push(gateway);const status=await gateway.start();
    const pairing=await gateway.createPairing({clientType:'obsidian-plugin',displayName:'Obsidian'}),record=await store.findById(pairing.clientId);
    const request=()=>fetch(status.baseUrl+'/v1/handshake',{method:'POST',headers:{authorization:'Bearer '+pairing.token,'content-type':'application/json'},body:JSON.stringify({contractVersion:integrationContractVersion,clientId:pairing.clientId,client:{kind:'obsidian-plugin',name:'Obsidian',contractVersion:integrationContractVersion},capabilities:['obsidian-editorial-v1']})});
    const granted=[...record!.scopes];record!.scopes=granted.filter(scope=>scope!=='obsidian-editorial-v1');expect((await request()).status).toBe(403);
    record!.scopes=granted;expect((await request()).status).toBe(200);
    await store.setStatus(pairing.clientId,'revoked');expect((await request()).status).toBe(401);
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

function createGateway(captureWebPage: (input: never) => Promise<typeof result>, store = createMemoryStore()): IntegrationGateway {
  return new IntegrationGateway({
    getPool: () => null,
    preferredPort: 0,
    clientStore: store,
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

it('rejects the old plugin manual-import fallback before ordinary source ingestion',async()=>{
  const gateway=createGateway(async()=>result);gateways.push(gateway);const status=await gateway.start();const pairing=await gateway.createPairing({clientType:'obsidian-plugin',displayName:'Old plugin fixture'});
  const handshake=await fetch(`${status.baseUrl}/v1/handshake`,{method:'POST',headers:{authorization:`Bearer ${pairing.token}`,'content-type':'application/json'},body:JSON.stringify({contractVersion:'1.0.0',clientId:pairing.clientId,client:{kind:'obsidian-plugin',name:'M3b plugin',contractVersion:'1.0.0'},capabilities:['import-obsidian-note','watch-obsidian-files','reconcile-obsidian-vault']})});expect(handshake.status).toBe(200);const session=await handshake.json() as IntegrationHandshakeResponse;
  // The old parser returns null for wiki types; its actual fallback shape omits frontmatter entirely.
  for(const markdown of [`---\nmemora_id: "${randomUUID()}"\nmemora_type: "wiki_page"\nmemora_managed: true\n---\n# My wiki`,`---\n"memora_type": "future_wiki"\n---\n# Future page`]){
    const response=await fetch(`${status.baseUrl}/v1/obsidian/import`,{method:'POST',headers:{authorization:`Bearer ${session.sessionToken}`,'content-type':'application/json'},body:JSON.stringify({requestId:randomUUID(),relativePath:'Memora/Wiki/page.md',title:'Wiki',markdown,contentHash:createHash('sha256').update(markdown).digest('hex'),mtimeMs:1})});expect(response.status).toBe(403);
  }
});
