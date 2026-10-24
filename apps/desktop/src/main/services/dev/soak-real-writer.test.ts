import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSoakPaths } from "./soak-data-root.js";
import {
  decisionsAdmitKnobName,
  decisionsKnobsSet,
  readDecisionsAdmission,
  readRealWriterKnob,
  realWriterKnobName,
  soakDecisionsCapMaxUsd
} from "./soak-real-writer.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

const writerId = "5a1d2f50-3c1e-4d7a-9b38-0d2f2f6a7c11";

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "soak-writer-"));
  scratch.push(dataRoot);
  mkdirSync(join(dataRoot, "profiles", "env-soak7"), { recursive: true });
  const paths = resolveSoakPaths(
    { MEMORA_SOAK_DATA_ROOT: dataRoot },
    { workspaceRoot: tmpdir(), isPackaged: false }
  );
  return { dataRoot, paths, userDataPath: join(dataRoot, "profiles", "env-soak7") };
}

describe("MEMORA_SOAK_REAL_WRITER", () => {
  it("is off when unset and names the Codex configuration when set", () => {
    const { paths, userDataPath } = setup();
    const options = { isPackaged: false, userDataPath, paths };
    expect(readRealWriterKnob({}, options)).toBeNull();
    expect(readRealWriterKnob({ [realWriterKnobName]: " " }, options)).toBeNull();
    expect(readRealWriterKnob({ [realWriterKnobName]: writerId.toUpperCase() }, options)).toEqual({
      providerConfigId: writerId
    });
  });

  it("is honoured only unpackaged", () => {
    const { paths, userDataPath } = setup();
    expect(() =>
      readRealWriterKnob(
        { [realWriterKnobName]: writerId },
        { isPackaged: true, userDataPath, paths }
      )
    ).toThrow(expect.objectContaining({ code: "packaged" }));
  });

  it("is honoured only under the data root's profiles/", () => {
    const { dataRoot, paths } = setup();
    for (const userDataPath of [
      join(dataRoot, "elsewhere"),
      join(dataRoot, "profiles"),
      join(tmpdir(), "library")
    ])
      expect(() =>
        readRealWriterKnob(
          { [realWriterKnobName]: writerId },
          { isPackaged: false, userDataPath, paths }
        )
      ).toThrow(expect.objectContaining({ code: "outsideProfiles" }));
  });

  it("refuses a value that is not a provider configuration id, so a key or a name never reaches the knob", () => {
    const { paths, userDataPath } = setup();
    for (const value of ["codex", "sk-live-123", "5a1d2f50", "../x"])
      expect(() =>
        readRealWriterKnob(
          { [realWriterKnobName]: value },
          { isPackaged: false, userDataPath, paths }
        )
      ).toThrow(expect.objectContaining({ code: "invalidValue" }));
  });
});

describe("the dormant admission of the Decisions configuration", () => {
  const writer = { providerConfigId: writerId };

  function keyFile(mode = 0o600) {
    const directory = mkdtempSync(join(tmpdir(), "soak-key-"));
    scratch.push(directory);
    const path = join(directory, "decisions.key");
    writeFileSync(path, "not-a-real-key\n");
    chmodSync(path, mode);
    return path;
  }
  const admitting = (overrides: Record<string, string> = {}) => ({
    [decisionsAdmitKnobName]: "1",
    MEMORA_RELATIONS_DECISIONS: "on",
    MEMORA_RELATIONS_DECISIONS_CAP_USD: "0.5",
    MEMORA_RELATIONS_DECISIONS_KEY_FILE: keyFile(),
    ...overrides
  });
  const options: Parameters<typeof readDecisionsAdmission>[1] = {
    isPackaged: false,
    realWriter: writer,
    profileDecisions: "admitted"
  };

  it("is off by default: nothing admits the Decisions decider when the knob is unset", () => {
    expect(readDecisionsAdmission({}, options)).toBeNull();
    expect(readDecisionsAdmission({ MEMORA_RELATIONS_DECISIONS: "on" }, options)).toBeNull();
    expect(decisionsKnobsSet({ MEMORA_RELATIONS_DECISIONS: "on" })).toEqual([
      "MEMORA_RELATIONS_DECISIONS"
    ]);
    expect(decisionsKnobsSet({})).toEqual([]);
  });

  it("admits the run once the real writer, the plan, the opt-in, a private key file and a cap are all there", () => {
    expect(readDecisionsAdmission(admitting(), options)).toEqual({ capUsd: 0.5 });
    expect(
      readDecisionsAdmission(admitting({ MEMORA_RELATIONS_DECISIONS_CAP_USD: "0.25" }), options)
    ).toEqual({ capUsd: 0.25 });
  });

  it("refuses each missing condition, and a plan that keeps Decisions off (the 7-day soak's)", () => {
    const refused = (env: Record<string, string>, overrides: Partial<typeof options> = {}) =>
      expect(() => readDecisionsAdmission(env, { ...options, ...overrides })).toThrow(
        expect.objectContaining({ code: "decisions" })
      );
    refused(admitting(), { realWriter: null });
    refused(admitting(), { profileDecisions: "off" });
    refused(admitting({ [decisionsAdmitKnobName]: "yes" }));
    refused(admitting({ MEMORA_RELATIONS_DECISIONS: "off" }));
    for (const cap of ["", "0", "-1", "0.51", "1000", "abc"])
      refused(admitting({ MEMORA_RELATIONS_DECISIONS_CAP_USD: cap }));
    refused(admitting({ MEMORA_RELATIONS_DECISIONS_KEY_FILE: "relative.key" }));
    refused(admitting({ MEMORA_RELATIONS_DECISIONS_KEY_FILE: join(tmpdir(), "no-such.key") }));
    // A key file the group or others can read is refused.
    refused(admitting({ MEMORA_RELATIONS_DECISIONS_KEY_FILE: keyFile(0o644) }));
    expect(soakDecisionsCapMaxUsd).toBe(0.5);
  });

  it("is refused when packaged", () => {
    expect(() => readDecisionsAdmission(admitting(), { ...options, isPackaged: true })).toThrow(
      expect.objectContaining({ code: "packaged" })
    );
  });
});
