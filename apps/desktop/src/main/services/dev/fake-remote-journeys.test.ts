import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  providers: [] as { id: string; provider: string; credentialRef: string | null }[],
  listProviders: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({ listProviders: state.listProviders })
}));

import {
  appIsPackaged,
  journeysAdmitWriterKnobName,
  journeysAdmittedConfigIds,
  readJourneysAdmission
} from "./fake-remote-journeys.js";
import { SoakKnobRefusal } from "./soak-refusal.js";

const writerId = "5f0c2b0e-7a53-4c33-9b9e-0d5f1f3a1b11";
const db = {} as never;

beforeEach(() => {
  state.providers = [{ id: writerId, provider: "openai-codex", credentialRef: "ai:writer" }];
  state.listProviders.mockReset();
  state.listProviders.mockImplementation(async () => state.providers);
});

const refusal = async (promise: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    return error;
  }
  return null;
};

describe("the journeys mode of the fake remote providers", () => {
  it("is switched on only by its variable: with it unset nothing is admitted and nothing is read", async () => {
    expect(readJourneysAdmission({}, { isPackaged: false })).toBeNull();
    expect(
      readJourneysAdmission({ [journeysAdmitWriterKnobName]: "  " }, { isPackaged: false })
    ).toBeNull();
    // Other fake-remote and soak knobs never turn it on.
    expect(
      readJourneysAdmission(
        {
          MEMORA_FAKE_REMOTE: "e2e/support/fake-remote-plan.json",
          MEMORA_SOAK_REAL_WRITER: writerId
        },
        { isPackaged: false }
      )
    ).toBeNull();
    expect(await journeysAdmittedConfigIds(db, {}, { isPackaged: false })).toEqual([]);
    expect(state.listProviders).not.toHaveBeenCalled();
  });

  it("admits exactly the Codex configuration the variable names, once it is signed in", async () => {
    const env = { [journeysAdmitWriterKnobName]: writerId.toUpperCase() };
    expect(readJourneysAdmission(env, { isPackaged: false })).toEqual({
      providerConfigId: writerId
    });
    expect(await journeysAdmittedConfigIds(db, env, { isPackaged: false })).toEqual([writerId]);

    // It names nothing in this profile, a provider that is not Codex, or a Codex one with no sign-in.
    state.providers = [];
    expect(await refusal(journeysAdmittedConfigIds(db, env, { isPackaged: false }))).toMatchObject({
      code: "realWriter"
    });
    state.providers = [{ id: writerId, provider: "openai-compatible", credentialRef: "ai:other" }];
    expect(await refusal(journeysAdmittedConfigIds(db, env, { isPackaged: false }))).toMatchObject({
      code: "realWriter"
    });
    state.providers = [{ id: writerId, provider: "openai-codex", credentialRef: null }];
    expect(await refusal(journeysAdmittedConfigIds(db, env, { isPackaged: false }))).toMatchObject({
      code: "realWriter"
    });
    // Anything but a provider configuration id is refused before the profile is read.
    state.listProviders.mockClear();
    const bad = { [journeysAdmitWriterKnobName]: "1" };
    expect(await refusal(() => readJourneysAdmission(bad, { isPackaged: false }))).toMatchObject({
      code: "invalidValue"
    });
    expect(await refusal(journeysAdmittedConfigIds(db, bad, { isPackaged: false }))).toBeInstanceOf(
      SoakKnobRefusal
    );
    expect(state.listProviders).not.toHaveBeenCalled();
  });

  it("is refused in a packaged build, as the fake remote knob is, and a build that cannot be read counts as packaged", async () => {
    const env = { [journeysAdmitWriterKnobName]: writerId };
    expect(await refusal(() => readJourneysAdmission(env, { isPackaged: true }))).toMatchObject({
      name: "SoakKnobRefusal",
      code: "packaged"
    });
    expect(await refusal(journeysAdmittedConfigIds(db, env, { isPackaged: true }))).toMatchObject({
      code: "packaged"
    });
    expect(state.listProviders).not.toHaveBeenCalled();
    // A packaged build with the variable unset is not an error: the variable is the only switch.
    expect(await journeysAdmittedConfigIds(db, {}, { isPackaged: true })).toEqual([]);
    // Under vitest `electron` is a path, not the app object: the default reading is "packaged".
    expect(appIsPackaged()).toBe(true);
  });
});
