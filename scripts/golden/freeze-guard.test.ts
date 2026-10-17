import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  frozenFileEnvironmentVariable,
  frozenFileLocation,
  frozenFilePath,
  readHeldOutAccess,
  requireHeldOut,
  sealedNotice
} from "./freeze-guard.ts";

const validFreeze = {
  configHash: "sha256:0123456789abcdef",
  calibrationIdentity: "decide/mlx/qwen3-reranker-0.6b",
  parity: { maxAbsoluteDifference: 0.0625 },
  inputHashes: { labels: "abc", candidates: "def" },
  frozenAt: "2026-10-30T12:00:00Z"
};

describe("the freeze guard (decision D3)", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-freeze-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps the held-out partition sealed without a freeze record", async () => {
    const access = await readHeldOutAccess(join(directory, "missing.json"));
    expect(access).toEqual({ open: false, reason: `no ${join(directory, "missing.json")}` });
    expect(() => requireHeldOut(access)).toThrow("held-out sealed until the freeze");
  });

  it("stays sealed for a file that is not JSON or not a freeze record", async () => {
    const notJson = join(directory, "not-json.json");
    await writeFile(notJson, "{ nope");
    expect(await readHeldOutAccess(notJson)).toMatchObject({ open: false });
    const incomplete = join(directory, "incomplete.json");
    await writeFile(incomplete, JSON.stringify({ configHash: "sha256:0123456789abcdef" }));
    expect(await readHeldOutAccess(incomplete)).toMatchObject({
      open: false,
      reason: expect.stringContaining("not a valid freeze record")
    });
    const localTime = join(directory, "local-time.json");
    await writeFile(localTime, JSON.stringify({ ...validFreeze, frozenAt: "2026-10-30 12:00" }));
    expect(await readHeldOutAccess(localTime)).toMatchObject({ open: false });
  });

  it("opens for a complete freeze record and keeps its extra fields", async () => {
    const file = join(directory, "frozen.json");
    await writeFile(file, JSON.stringify({ ...validFreeze, escalation: "none" }));
    const access = await readHeldOutAccess(file);
    expect(access.open).toBe(true);
    expect(requireHeldOut(access)).toMatchObject({ configHash: validFreeze.configHash });
  });

  it("looks for the record where T58 writes it unless the environment says otherwise", () => {
    expect(frozenFileLocation({})).toBe(frozenFilePath);
    expect(frozenFilePath).toBe(".cache/f3/freeze/frozen.json");
    expect(frozenFileLocation({ [frozenFileEnvironmentVariable]: "/x/frozen.json" })).toBe(
      "/x/frozen.json"
    );
  });

  it("words the notice the reports print", () => {
    expect(sealedNotice("no file")).toBe("held-out sealed until the freeze (decision D3): no file");
  });
});
