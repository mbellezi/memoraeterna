import { describe, expect, it } from "vitest";

import {
  captureSelectionRequestSchema,
  captureWebPageRequestSchema,
  integrationContractVersion,
  integrationErrorSchema,
  integrationHandshakeSchema,
  isIntegrationContractVersionCompatible,
  normalizeIntegrationError,
  obsidianFileMovedEventSchema
} from "./index.js";

const clientId = "4b9e88e3-0abc-40ac-969d-8616bf381ce1";

describe("integration contracts", () => {
  it("parses a valid handshake", () => {
    expect(integrationHandshakeSchema.parse({
      contractVersion: integrationContractVersion,
      clientId,
      client: {
        kind: "chrome-extension",
        name: "Chrome",
        contractVersion: integrationContractVersion
      },
      capabilities: ["capture-web-page"]
    }).clientId).toBe(clientId);
  });

  it("rejects an empty web capture and malformed selection", () => {
    const base = {
      requestId: clientId,
      url: "https://example.com/article",
      title: "Article",
      capturedAt: new Date().toISOString(),
      metadata: {}
    };
    expect(captureWebPageRequestSchema.safeParse(base).success).toBe(false);
    expect(captureSelectionRequestSchema.safeParse({ ...base, selection: " " }).success).toBe(false);
  });

  it("rejects unsafe Obsidian paths", () => {
    expect(obsidianFileMovedEventSchema.safeParse({
      eventId: clientId,
      occurredAt: new Date().toISOString(),
      memoraId: clientId,
      previousRelativePath: "../outside.md",
      relativePath: "Memora/note.md",
      syncVersion: 1,
      mtimeMs: 1
    }).success).toBe(false);
  });

  it("checks compatibility by contract major", () => {
    expect(isIntegrationContractVersionCompatible("1.8.2")).toBe(true);
    expect(isIntegrationContractVersionCompatible("2.0.0")).toBe(false);
    expect(isIntegrationContractVersionCompatible("invalid")).toBe(false);
  });

  it("normalizes validation errors without leaking payloads", () => {
    const parsed = integrationHandshakeSchema.safeParse({ clientId: "secret" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const normalized = integrationErrorSchema.parse(normalizeIntegrationError(parsed.error));
    expect(normalized.code).toBe("invalid_request");
    expect(JSON.stringify(normalized)).not.toContain("secret");
  });
});
