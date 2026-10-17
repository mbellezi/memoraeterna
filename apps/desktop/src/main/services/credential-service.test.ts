import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aiConfigGeneration } from "@app/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^enc:/u, "")
  }
}));

import { CredentialService } from "./credential-service.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "memora-credentials-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the credential service reports its writes (F3 D38)", () => {
  it("moves the AI configuration generation when a credential is saved, replaced or removed", async () => {
    const credentials = new CredentialService(directory);
    let generation = aiConfigGeneration();
    const reference = await credentials.save("first-key");
    expect(aiConfigGeneration()).toBeGreaterThan(generation);
    generation = aiConfigGeneration();
    // An OAuth refresh replaces the secret under the same reference.
    await credentials.save("second-key", reference);
    expect(aiConfigGeneration()).toBeGreaterThan(generation);
    await expect(credentials.get(reference)).resolves.toBe("second-key");
    generation = aiConfigGeneration();
    await expect(credentials.remove(reference)).resolves.toBe(true);
    expect(aiConfigGeneration()).toBeGreaterThan(generation);
  });

  it("leaves it alone for a read and for removing what is not there", async () => {
    const credentials = new CredentialService(directory);
    const reference = await credentials.save("key");
    const generation = aiConfigGeneration();
    await credentials.get(reference);
    await expect(credentials.remove("ai:missing")).resolves.toBe(false);
    expect(aiConfigGeneration()).toBe(generation);
  });
});
