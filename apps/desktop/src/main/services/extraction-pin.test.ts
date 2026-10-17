import { afterEach, describe, expect, it } from "vitest";

import {
  isExtractionPinned,
  readE2ePinConfig,
  readGoldenPinConfig,
  setExtractionPin,
  unpinnedConfig
} from "./extraction-pin.js";

afterEach(() => setExtractionPin(false));

describe("MEMORA_GOLDEN_PIN of a golden run", () => {
  const golden = { MEMORA_GOLDEN_RUN: "scripts/golden/manifest.json" };

  it("pins extraction by default and reads off", () => {
    expect(readGoldenPinConfig(golden, { isPackaged: false })).toEqual({
      read: true,
      mode: "extraction"
    });
    expect(
      readGoldenPinConfig({ ...golden, MEMORA_GOLDEN_PIN: " extraction " }, { isPackaged: false })
    ).toEqual({ read: true, mode: "extraction" });
    expect(
      readGoldenPinConfig({ ...golden, MEMORA_GOLDEN_PIN: "off" }, { isPackaged: false })
    ).toEqual({ read: true, mode: "off" });
  });

  it("rejects any other value inside a golden run", () => {
    expect(() =>
      readGoldenPinConfig({ ...golden, MEMORA_GOLDEN_PIN: "all" }, { isPackaged: false })
    ).toThrow("MEMORA_GOLDEN_PIN must be extraction or off");
  });

  it("is not read outside a golden run, or in a packaged build, whatever it says", () => {
    expect(readGoldenPinConfig({ MEMORA_GOLDEN_PIN: "extraction" }, { isPackaged: false })).toEqual(
      unpinnedConfig
    );
    expect(readGoldenPinConfig({ MEMORA_GOLDEN_PIN: "all" }, { isPackaged: false })).toEqual(
      unpinnedConfig
    );
    expect(
      readGoldenPinConfig({ ...golden, MEMORA_GOLDEN_PIN: "extraction" }, { isPackaged: true })
    ).toEqual(unpinnedConfig);
  });
});

describe("MEMORA_GOLDEN_PIN of the E6 runner", () => {
  it("pins extraction by default, because E6 replays an F2-era cassette, and reads off for a re-record", () => {
    expect(readE2ePinConfig({})).toEqual({ read: true, mode: "extraction" });
    expect(readE2ePinConfig({ MEMORA_GOLDEN_PIN: "off" })).toEqual({ read: true, mode: "off" });
    expect(() => readE2ePinConfig({ MEMORA_GOLDEN_PIN: "maybe" })).toThrow(
      "must be extraction or off"
    );
  });
});

describe("the pin of this process", () => {
  it("is off until a DEV tool sets it, and a config sets it by its mode", () => {
    expect(isExtractionPinned()).toBe(false);
    setExtractionPin({ read: true, mode: "extraction" });
    expect(isExtractionPinned()).toBe(true);
    setExtractionPin({ read: true, mode: "off" });
    expect(isExtractionPinned()).toBe(false);
    setExtractionPin(true);
    expect(isExtractionPinned()).toBe(true);
    setExtractionPin(unpinnedConfig);
    expect(isExtractionPinned()).toBe(false);
  });
});
