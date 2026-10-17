/**
 * The extraction pin (F3 D5, C1): `MEMORA_GOLDEN_PIN=extraction`.
 *
 * Recorded cassettes hold the first attempts and the repairs of the recording era's parse path. A
 * pinned run keeps that path for extraction, entity identity and relation-type resolution (strict
 * parse, whole-output repair, no salvage, no item-level repair, no tolerant recovery, no output
 * schema, the 3,500-character graph batch), so every recorded repair replays and the pinned graph
 * stays the same. Without the pin, the product path runs: schema output, item-level repair, graph
 * salvage and batches by writer locality.
 *
 * The knob is read by DEV tooling only: a golden run (`MEMORA_GOLDEN_RUN`, where `extraction` is the
 * default) and the E6 runner (where it is the default too, because E6 replays an F2-era cassette).
 * Every other run, and every packaged build, behaves unpinned and ignores the variable. `off` runs the
 * product path, for a re-record under F3.
 */

export const goldenPinKnob = "MEMORA_GOLDEN_PIN";

export const goldenPinModes = ["extraction", "off"] as const;
export type GoldenPinMode = (typeof goldenPinModes)[number];

export interface GoldenPinConfig {
  /** True only when a DEV tool read the knob; false means it was not read and the product path runs. */
  read: boolean;
  mode: GoldenPinMode;
}

/** What every run that does not read the knob behaves as. */
export const unpinnedConfig: GoldenPinConfig = { read: false, mode: "off" };

function pinMode(raw: string | undefined): GoldenPinMode {
  const value = (raw?.trim() || "extraction") as GoldenPinMode;
  if (!goldenPinModes.includes(value))
    throw new Error(`${goldenPinKnob} must be ${goldenPinModes.join(" or ")} (or unset)`);
  return value;
}

/**
 * Reads the pin of a golden run. Outside one (`MEMORA_GOLDEN_RUN` unset, or a packaged build) the
 * variable is ignored without an error.
 */
export function readGoldenPinConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean }
): GoldenPinConfig {
  if (options.isPackaged || !env.MEMORA_GOLDEN_RUN?.trim()) return unpinnedConfig;
  return { read: true, mode: pinMode(env[goldenPinKnob]) };
}

/** Reads the pin of an E6 run, which is always a DEV tool run: `extraction` unless set to `off`. */
export function readE2ePinConfig(
  env: Readonly<Record<string, string | undefined>>
): GoldenPinConfig {
  return { read: true, mode: pinMode(env[goldenPinKnob]) };
}

let extractionPinned = false;

/**
 * Sets the pin for this process. DEV tooling sets it before any ingestion starts and clears it when
 * its run ends; the extraction code reads it when a stage runs.
 */
export function setExtractionPin(config: GoldenPinConfig | boolean): void {
  extractionPinned = typeof config === "boolean" ? config : config.mode === "extraction";
}

/** Whether extraction runs the recording-era path. */
export function isExtractionPinned(): boolean {
  return extractionPinned;
}
