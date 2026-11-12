import { describe, expect, it } from "vitest";

import { createAiConfigRepository } from "./aiConfigRepository.js";
import type { Queryable } from "./types.js";

const profileRow = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "p",
  description: null,
  isDefault: false,
  privacyMode: "allow_remote",
  outputLanguage: "ui",
  providerConfigId: null,
  localModelId: null,
  modelId: null,
  runtime: null,
  capabilities: [],
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date()
};

/** A database that records every statement with its parameters. */
function recordingDb() {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [profileRow], rowCount: 1 };
    }
  } as unknown as Queryable;
  return { db, calls };
}

/** The statement text before its `returning` list, which still reads `privacy_mode` until F6. */
const writePart = (sql: string): string => sql.split(/returning/iu)[0] ?? sql;

describe("the dead columns privacy_mode and fallback_policy are not written (F5 T172, D8)", () => {
  it("createProfile omits privacy_mode and ignores the deprecated input", async () => {
    const { db, calls } = recordingDb();
    await createAiConfigRepository(db).createProfile({ name: "p", privacyMode: "offline_only" });
    const call = calls[0];
    expect(writePart(call?.sql ?? "")).not.toMatch(/privacy_mode/u);
    expect(call?.params).not.toContain("offline_only");
    expect(call?.params).toEqual(["p", null, false, "ui"]);
  });

  it("updateProfile omits privacy_mode and ignores the deprecated input", async () => {
    const { db, calls } = recordingDb();
    await createAiConfigRepository(db).updateProfile({
      id: profileRow.id,
      name: "q",
      privacyMode: "offline_only"
    });
    const call = calls[0];
    expect(writePart(call?.sql ?? "")).not.toMatch(/privacy_mode/u);
    expect(call?.params).not.toContain("offline_only");
  });

  it("cloneProfile copies neither privacy_mode nor fallback_policy", async () => {
    const { db, calls } = recordingDb();
    await createAiConfigRepository(db).cloneProfile(profileRow.id, "copy");
    expect(writePart(calls[0]?.sql ?? "")).not.toMatch(/privacy_mode|fallback_policy/u);
  });

  it("setProfileTask and seedTaskRoute leave fallback_policy to its default", async () => {
    const { db, calls } = recordingDb();
    const repository = createAiConfigRepository(db);
    await repository.setProfileTask({ profileId: profileRow.id, task: "decide" });
    await repository.seedTaskRoute("class:fast", profileRow.id);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.sql).not.toMatch(/fallback_policy/u);
  });
});
