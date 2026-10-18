import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeRemoteKnobName, readSoakKnob, soakKnobName, soakSetupKnobName } from "./soak-plan.js";
import { readSoakSetupKnob, runSoakSetup, soakSetupPath, soakSetupSchema } from "./soak-setup.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "soak-setup-"));
  scratch.push(root);
  mkdirSync(join(root, ".cache", "profiles", "env-soak"), { recursive: true });
  return { root, userDataPath: join(root, ".cache", "profiles", "env-soak") };
}
const knob = { [soakSetupKnobName]: "1" };

describe("the setup knob", () => {
  it("is off when unset", () => {
    const { root, userDataPath } = workspace();
    expect(readSoakSetupKnob({}, { isPackaged: false, workspaceRoot: root, userDataPath })).toBe(
      false
    );
    expect(readSoakSetupKnob(knob, { isPackaged: false, workspaceRoot: root, userDataPath })).toBe(
      true
    );
  });

  it("is refused when packaged", () => {
    const { root, userDataPath } = workspace();
    expect(() =>
      readSoakSetupKnob(knob, { isPackaged: true, workspaceRoot: root, userDataPath })
    ).toThrow(expect.objectContaining({ code: "packaged" }));
  });

  it("wants exactly 1", () => {
    const { root, userDataPath } = workspace();
    for (const value of ["true", "2", "yes"])
      expect(() =>
        readSoakSetupKnob(
          { [soakSetupKnobName]: value },
          { isPackaged: false, workspaceRoot: root, userDataPath }
        )
      ).toThrow(expect.objectContaining({ code: "invalidValue" }));
  });

  it("is refused outside a clone inside .cache/profiles/", () => {
    const { root } = workspace();
    for (const userDataPath of [join(root, "library"), join(root, ".cache", "profiles"), tmpdir()])
      expect(() =>
        readSoakSetupKnob(knob, { isPackaged: false, workspaceRoot: root, userDataPath })
      ).toThrow(expect.objectContaining({ code: "outsideProfiles" }));
  });

  it("is refused beside any other DEV knob, the soak's own included", () => {
    const { root, userDataPath } = workspace();
    const options = { isPackaged: false, workspaceRoot: root, userDataPath };
    for (const other of [
      "MEMORA_AI_CASSETTE",
      "MEMORA_GOLDEN_RUN",
      "MEMORA_PROFILE_RESET",
      "MEMORA_RELATIONS_REMATCH",
      "MEMORA_DEV_EXPLAIN_PROBE",
      "MEMORA_LOCAL_MODEL_INSTALL",
      soakKnobName,
      fakeRemoteKnobName
    ])
      expect(() => readSoakSetupKnob({ ...knob, [other]: "x" }, options), other).toThrow(
        expect.objectContaining({ code: "conflictingKnob" })
      );
  });

  it("makes the soak knobs refuse in turn, so the two never start together", () => {
    const { root, userDataPath } = workspace();
    expect(() =>
      readSoakKnob(
        fakeRemoteKnobName,
        { ...knob, [fakeRemoteKnobName]: "scripts/soak/plan.json" },
        { isPackaged: false, workspaceRoot: root, userDataPath }
      )
    ).toThrow(expect.objectContaining({ code: "conflictingKnob" }));
  });
});

describe("running the setup", () => {
  const unused = {
    pool: {} as never,
    ai: {
      applyPreset: vi.fn(),
      testClassRoute: vi.fn(),
      classRoutes: vi.fn()
    },
    logger: { info: vi.fn(), error: vi.fn() }
  };

  it("does nothing without the knob", async () => {
    const { root, userDataPath } = workspace();
    expect(
      await runSoakSetup({
        ...unused,
        env: {},
        isPackaged: false,
        workspaceRoot: root,
        userDataPath
      })
    ).toBe("off");
    expect(unused.ai.applyPreset).not.toHaveBeenCalled();
  });

  it("is refused for a folder that only looks like a clone: a link out of .cache/profiles/", async () => {
    const { root } = workspace();
    const elsewhere = mkdtempSync(join(tmpdir(), "soak-setup-elsewhere-"));
    scratch.push(elsewhere);
    const link = join(root, ".cache", "profiles", "linked");
    symlinkSync(elsewhere, link);
    const logger = { info: vi.fn(), error: vi.fn() };
    expect(
      await runSoakSetup({
        ...unused,
        logger,
        env: knob,
        isPackaged: false,
        workspaceRoot: root,
        userDataPath: link
      })
    ).toBe("refused");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("only runs on a clone"));
    expect(unused.ai.applyPreset).not.toHaveBeenCalled();
  });

  it("writes its result where the runbook reads it", () => {
    expect(soakSetupPath("/repository")).toBe("/repository/.cache/f3/soak/setup.json");
  });

  it("reads a file back through its schema", () => {
    const route = {
      profile: "Qwen",
      model: "qwen",
      runtime: "mlx",
      remote: false,
      test: { state: "passed", ms: 12, error: null }
    };
    const file = {
      format: "memora-soak-setup",
      version: 1,
      at: "2026-10-18T20:00:00.000Z",
      userDataPath: "/p",
      status: "ok",
      problems: [],
      preset: { requested: "local", applied: true, mode: "local", blocked: [] },
      library: { roots: 10, sources: 12, notes: 160 },
      classes: [{ id: "embed", ...route }],
      judge: { ...route, routed: true, deciderMode: "ranker" },
      remote: { reachable: [], defaultProfileChanged: null, residual: [] }
    };
    expect(soakSetupSchema.parse(file)).toEqual(file);
    expect(() => soakSetupSchema.parse({ ...file, status: "maybe" })).toThrow();
  });
});
