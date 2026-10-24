import { presetCatalogIds } from "@app/domain";
import { createTranslator } from "@app/i18n";
import { describe, expect, it } from "vitest";

import { firstRunClassTests } from "../../../shared/first-run-sequence";
import { localSetupAvailable } from "../../../shared/onboarding";
import { catalogRows, macHardware, windowsHardware } from "./onboarding-fixtures";
import {
  classTestNameKeys,
  defaultPreset,
  downloadShare,
  errorMessageKey,
  etaMinutes,
  failedTestCount,
  formatSize,
  formatUsd,
  modeOptions,
  modelRole,
  modelsToInstall,
  rankerCatalogId,
  waitingTests
} from "./onboarding-model";

const gib = 1024 ** 3;

describe("the failure a handler reported", () => {
  it("is the message key when the catalog has it, else the fallback", () => {
    expect(errorMessageKey(new Error("errors.ai.oauthLoginFailed"), "errors.common.unknown")).toBe(
      "errors.ai.oauthLoginFailed"
    );
    expect(
      errorMessageKey(
        new Error("Error invoking remote method: errors.localModels.downloadHttp: x"),
        "errors.common.unknown"
      )
    ).toBe("errors.localModels.downloadHttp");
    expect(errorMessageKey(new Error("errors.nothing.here"), "errors.common.unknown")).toBe(
      "errors.common.unknown"
    );
    expect(errorMessageKey(new Error("socket hang up"), "errors.common.unknown")).toBe(
      "errors.common.unknown"
    );
    expect(errorMessageKey("errors.ai.noCompatibleModel", "errors.common.unknown")).toBe(
      "errors.ai.noCompatibleModel"
    );
  });
});

describe("the models a setup installs", () => {
  it("installs the embedder alone for Hybrid and Cloud", () => {
    expect(modelsToInstall("hybrid", 48 * gib)).toEqual([presetCatalogIds.embedding]);
    expect(modelsToInstall("cloud", 8 * gib)).toEqual([presetCatalogIds.embedding]);
  });

  it("adds the Local writer the memory allows, the larger one from 24 GiB", () => {
    expect(modelsToInstall("local", 24 * gib)).toEqual([
      presetCatalogIds.embedding,
      presetCatalogIds.writerLarge
    ]);
    expect(modelsToInstall("local", 24 * gib - 1)).toEqual([
      presetCatalogIds.embedding,
      presetCatalogIds.writerSmall
    ]);
  });

  it("names the role of each model it installs and of none other", () => {
    expect(modelRole(presetCatalogIds.embedding)).toBe("embedder");
    expect(modelRole(presetCatalogIds.rankerMlx)).toBe("ranker");
    expect(modelRole(presetCatalogIds.rankerGguf)).toBe("ranker");
    expect(modelRole(presetCatalogIds.writerLarge)).toBe("writer");
    expect(modelRole(presetCatalogIds.writerSmall)).toBe("writer");
    expect(modelRole("gguf-something-else")).toBeNull();
  });

  it("follows the ranker the first run installs: MLX on Apple silicon, GGUF elsewhere", () => {
    expect(rankerCatalogId(macHardware)).toBe(presetCatalogIds.rankerMlx);
    expect(rankerCatalogId(windowsHardware)).toBe(presetCatalogIds.rankerGguf);
  });
});

describe("the three setups on the tier card", () => {
  it("adds up what each still downloads: its models and the ranker that follows", () => {
    const options = modeOptions(macHardware, catalogRows());
    const embedder = 0.6 * gib;
    const ranker = 0.64 * gib;
    expect(options.map((option) => option.preset)).toEqual(["local", "hybrid", "cloud"]);
    expect(options[1]!.downloadBytes).toBeCloseTo(embedder + ranker, 0);
    expect(options[2]!.downloadBytes).toBeCloseTo(embedder + ranker, 0);
    expect(options[0]!.downloadBytes).toBeCloseTo(embedder + ranker + 5.5 * gib, 0);
  });

  it("does not count what is installed already", () => {
    const rows = catalogRows().map((row) =>
      row.catalogId === presetCatalogIds.embedding ? { ...row, status: "ready" as const } : row
    );
    expect(modeOptions(macHardware, rows)[1]!.downloadBytes).toBeCloseTo(0.64 * gib, 0);
    const allReady = rows.map((row) => ({ ...row, status: "ready" as const }));
    expect(modeOptions(macHardware, allReady)[1]!.downloadBytes).toBe(0);
  });

  it("does not guess a size when the list is unknown or lacks a model", () => {
    expect(modeOptions(macHardware, null).map((option) => option.downloadBytes)).toEqual([
      null,
      null,
      null
    ]);
    const withoutRanker = catalogRows().filter(
      (row) => row.catalogId !== presetCatalogIds.rankerMlx
    );
    expect(modeOptions(macHardware, withoutRanker)[1]!.downloadBytes).toBeNull();
  });

  it("offers Local only where it can run, and carries the informative monthly estimate", () => {
    const mac = modeOptions(macHardware, null);
    expect(mac.map((option) => option.available)).toEqual([true, true, true]);
    expect(mac.map((option) => option.monthlyUsd)).toEqual([null, 0.39, 0.45]);
    expect(mac.map((option) => option.remoteWriter)).toEqual([false, true, true]);
    const windows = modeOptions(windowsHardware, null);
    expect(windows.map((option) => option.available)).toEqual([false, true, true]);
    expect(localSetupAvailable({ platform: "darwin", nativeArch: "x64" })).toBe(false);
    expect(localSetupAvailable({ platform: "linux", nativeArch: "arm64" })).toBe(false);
  });

  it("leads with Hybrid when the computer is not known, and with the table's pick when it is", () => {
    const unknown = modeOptions(null, null);
    expect(unknown.find((option) => option.recommended)?.preset).toBe("hybrid");
    expect(defaultPreset(unknown)).toBe("hybrid");
    expect(defaultPreset(modeOptions({ ...macHardware, recommended: "cloud" }, null))).toBe(
      "cloud"
    );
  });

  it("never leads with a setup the computer cannot run", () => {
    const options = modeOptions({ ...windowsHardware, recommended: "local" }, null);
    expect(defaultPreset(options)).toBe("hybrid");
  });
});

describe("what a download and a check read as", () => {
  it("gives a share only once the size is known, and keeps it between 0 and 1", () => {
    expect(downloadShare({ downloadedBytes: 5, totalBytes: 0 })).toBeNull();
    expect(downloadShare({ downloadedBytes: 150, totalBytes: 600 })).toBe(0.25);
    expect(downloadShare({ downloadedBytes: 900, totalBytes: 600 })).toBe(1);
  });

  it("rounds the time left up to whole minutes, and leaves an unknown time unknown", () => {
    expect(etaMinutes(null)).toBeNull();
    expect(etaMinutes(0)).toBe(1);
    expect(etaMinutes(61)).toBe(2);
  });

  it("lists the tests in the order the first-run sequence runs them, all waiting", () => {
    const tests = waitingTests();
    expect(tests.map((test) => test.route)).toEqual([...firstRunClassTests]);
    expect(tests.every((test) => test.state === "waiting")).toBe(true);
    expect(failedTestCount(tests)).toBe(0);
    expect(failedTestCount([{ ...tests[0]!, state: "failed" }, tests[1]!])).toBe(1);
    for (const route of firstRunClassTests) expect(classTestNameKeys[route]).toBeTruthy();
  });

  it("writes sizes and amounts in the interface language", () => {
    expect(formatSize("en", 48 * gib)).toBe("48 GB");
    expect(formatSize("en", 0.6 * gib)).toMatch(/^6\d\d MB$/);
    expect(formatSize("pt-BR", 1.5 * gib)).toBe("1,5 GB");
    expect(formatUsd("en", 0.39)).toBe("$0.39");
    expect(formatUsd("pt-BR", 0.39)).toContain("0,39");
    expect(formatUsd("en", 12)).toBe("$12");
  });
});

describe("the copy the model names", () => {
  it("has a message in every locale for each key it maps to", () => {
    const keys = [
      ...Object.values(classTestNameKeys),
      "onboarding.setup.models.embedder",
      "onboarding.setup.models.ranker",
      "onboarding.setup.models.writer"
    ] as const;
    for (const locale of ["en", "pt-BR", "it", "fr", "es"] as const) {
      const t = createTranslator(locale);
      for (const key of keys) expect(t(key, { missingKeyBehavior: "throw" })).toBeTruthy();
    }
  });
});
