import { describe, expect, it } from "vitest";
import {
  databaseStatusSchema,
  defaultStorageSettings,
  storageSettingsSchema,
  storageSettingsUpdateSchema,
  systemInfoSchema
} from "./ipc";

describe("desktop IPC contracts", () => {
  it("parses database lifecycle status responses", () => {
    expect(
      databaseStatusSchema.parse({
        state: "migrating",
        messageKey: "database.status.migrating",
        updatedAt: new Date(0).toISOString()
      })
    ).toMatchObject({
      state: "migrating"
    });

    expect(() =>
      databaseStatusSchema.parse({
        state: "running",
        messageKey: "database.status.ready",
        updatedAt: new Date(0).toISOString()
      })
    ).toThrow();
  });

  it("parses the exposed system info response", () => {
    expect(
      systemInfoSchema.parse({
        appName: "Memora Eterna",
        locale: "en",
        platform: "darwin",
        versions: {
          electron: "43.0.0",
          node: "24.17.0"
        }
      })
    ).toMatchObject({
      platform: "darwin"
    });
  });

  it("accepts partial settings updates and rejects unknown fields", () => {
    expect(storageSettingsUpdateSchema.parse({ managedRoot: "Memora" })).toEqual({
      managedRoot: "Memora"
    });

    expect(() => storageSettingsUpdateSchema.parse({ unknown: true })).toThrow();
  });

  it("parses persisted storage settings", () => {
    expect(
      storageSettingsSchema.parse({
        ...defaultStorageSettings,
        updatedAt: new Date(0).toISOString()
      })
    ).toMatchObject({
      managedRoot: "Memora",
      deletionPolicy: "tombstone"
    });
  });
});
