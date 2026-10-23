// The typed configuration of the Gardener's background policy (F4 D13, D15, D36): control defaults,
// what counts as an active user, the "only idle" wait, the local lane's duty cycle for background
// calls and the blocker service's clocks. Values marked (cal.) in the F4 spec are start values that
// calibration may revise; rules hold no number (RULES.md section 1).
import { z } from "zod";

const milliseconds = (min: number, max: number) => z.number().int().min(min).max(max);
/** A share of the local lane's time, above zero (zero would stop background work for good). */
const duty = z.number().gt(0).max(1);

const ControlsSchema = z
  .object({
    /** The monthly remote spend cap on priced routes a new library starts with (Q3). */
    defaultMonthlyCapUsd: z.number().finite().min(0).max(10_000).default(5),
    /** The highest monthly cap a user can set. */
    monthlyCapMaxUsd: z.number().finite().min(1).max(10_000).default(1_000)
  })
  .strict()
  .refine((value) => value.defaultMonthlyCapUsd <= value.monthlyCapMaxUsd, {
    message: "gardener.config.capDefaultAboveMax"
  });

const PowerSchema = z
  .object({
    /** The user counts as active while the system has been idle for less than this (cal.). */
    activeIdleBelowMs: milliseconds(1_000, 3_600_000).default(60_000),
    /** "Only idle" holds background tasks until the system has been idle this long (cal.). */
    onlyIdleAfterMs: milliseconds(1_000, 86_400_000).default(300_000),
    /** How often the system idle time is read while something depends on it. */
    pollMs: milliseconds(250, 600_000).default(10_000),
    /** One block of the DEV power override (the soak's activity and battery windows). */
    devOverrideBlockMs: milliseconds(1_000, 86_400_000).default(600_000)
  })
  .strict()
  .refine((value) => value.onlyIdleAfterMs >= value.activeIdleBelowMs, {
    message: "gardener.config.onlyIdleBelowActive"
  });

const DutyCycleSchema = z
  .object({
    /**
     * The share of the local lane background calls may take while the user is active: after a
     * background call of duration d, the next background call waits d × (1/duty − 1) (cal.).
     */
    active: duty.default(0.5),
    /** The share while the user is idle (cal.); 1 means no wait. */
    idle: duty.default(1)
  })
  .strict()
  .refine((value) => value.active <= value.idle, {
    message: "gardener.config.dutyActiveAboveIdle"
  });

const BlockersSchema = z
  .object({
    /** How often the blocker service re-gates and clears rows whose reset time has passed. */
    tickMs: milliseconds(1_000, 3_600_000).default(30_000),
    /** The next look at a per-task wait whose clear time is unknown (a probe, a network check). */
    recheckMs: milliseconds(1_000, 86_400_000).default(300_000),
    /** How long a refusal met at admission is kept for its job before it is forgotten. */
    admissionBlockTtlMs: milliseconds(1_000, 86_400_000).default(3_600_000)
  })
  .strict();

export const GardenerConfigSchema = z
  .object({
    controls: ControlsSchema.prefault({}),
    power: PowerSchema.prefault({}),
    dutyCycle: DutyCycleSchema.prefault({}),
    blockers: BlockersSchema.prefault({})
  })
  .strict();

export type GardenerConfig = z.infer<typeof GardenerConfigSchema>;
export type GardenerConfigInput = z.input<typeof GardenerConfigSchema>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const defaultGardenerConfig: GardenerConfig = deepFreeze(GardenerConfigSchema.parse({}));

/** The configuration with overrides, each group merged over its defaults. */
export function gardenerConfigWith(overrides: {
  controls?: Partial<GardenerConfig["controls"]>;
  power?: Partial<GardenerConfig["power"]>;
  dutyCycle?: Partial<GardenerConfig["dutyCycle"]>;
  blockers?: Partial<GardenerConfig["blockers"]>;
}): GardenerConfig {
  const base = defaultGardenerConfig;
  return deepFreeze(
    GardenerConfigSchema.parse({
      controls: { ...base.controls, ...overrides.controls },
      power: { ...base.power, ...overrides.power },
      dutyCycle: { ...base.dutyCycle, ...overrides.dutyCycle },
      blockers: { ...base.blockers, ...overrides.blockers }
    })
  );
}
