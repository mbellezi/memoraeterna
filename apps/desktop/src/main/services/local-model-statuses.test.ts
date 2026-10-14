import { beforeEach, describe, expect, it, vi } from "vitest";

import { localModelStatusEntrySchema } from "../../shared/ipc.js";
import { LocalModelService } from "./local-model-service.js";

const repository = vi.hoisted(() => ({
  listModels: vi.fn(),
  upsertModel: vi.fn(),
  listFiles: vi.fn(),
  replaceFiles: vi.fn(),
  updateModel: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createLocalModelRepository: () => repository
}));
vi.mock("./credential-service.js", () => ({ CredentialService: class {} }));

const readyId = "00000000-0000-4000-8000-0000000000a1";
const downloadingId = "00000000-0000-4000-8000-0000000000a2";

beforeEach(() => {
  for (const mock of Object.values(repository)) mock.mockReset();
  repository.listModels.mockResolvedValue([
    { id: readyId, status: "ready", catalogId: "a" },
    { id: downloadingId, status: "downloading", catalogId: "b" }
  ]);
});

describe("local model readiness for screens", () => {
  const service = new LocalModelService({
    getPool: () => ({}) as never,
    userDataPath: "/nonexistent/memora-test"
  });

  it("reads installed models without synchronizing the catalog", async () => {
    const statuses = await service.listStatuses();

    expect(statuses).toEqual([
      { id: readyId, status: "ready" },
      { id: downloadingId, status: "downloading" }
    ]);
    expect(() => localModelStatusEntrySchema.array().parse(statuses)).not.toThrow();
    // Every write goes through these repository calls: a status read makes none of them.
    expect(repository.upsertModel).not.toHaveBeenCalled();
    expect(repository.replaceFiles).not.toHaveBeenCalled();
    expect(repository.updateModel).not.toHaveBeenCalled();
    expect(repository.listFiles).not.toHaveBeenCalled();
  });

  it("fails when the database is not ready instead of reporting models as missing", async () => {
    const unavailable = new LocalModelService({
      getPool: () => null,
      userDataPath: "/nonexistent/memora-test"
    });
    await expect(unavailable.listStatuses()).rejects.toThrow("errors.database.notReady");
  });
});
