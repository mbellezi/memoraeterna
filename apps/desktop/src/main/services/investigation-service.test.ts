import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";

import { InvestigationService } from "./investigation-service.js";

const mocks = vi.hoisted(() => ({
  investigations: { recover: vi.fn(), list: vi.fn(), get: vi.fn(), candidates: vi.fn() }
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createInvestigationRepository: () => mocks.investigations
}));

const service = () => new InvestigationService({ getPool: () => ({}) as PgPool });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("followed questions after Ask lost its page scope", () => {
  it("still lists and reads stored rows and recovers once", async () => {
    mocks.investigations.list.mockResolvedValue([{ id: "a" }, null, { id: "b" }]);
    mocks.investigations.get.mockResolvedValue({ id: "a" });
    const followed = service();
    await followed.initialize();
    await followed.initialize();
    expect(mocks.investigations.recover).toHaveBeenCalledOnce();
    expect(await followed.list()).toEqual([{ id: "a" }, { id: "b" }]);
    expect(await followed.get("a")).toEqual({ id: "a" });
  });
  it("refreshes nothing when the maintenance owner ticks", async () => {
    await service().tick();
    expect(mocks.investigations.candidates).not.toHaveBeenCalled();
  });
  it("reports an unavailable database with the Ask error key", async () => {
    await expect(new InvestigationService({ getPool: () => null }).list()).rejects.toThrow(
      "consultation.errors.unavailable"
    );
  });
});
