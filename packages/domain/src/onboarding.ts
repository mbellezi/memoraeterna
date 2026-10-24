// The first-run onboarding's stored state (F4 D31, spec 3.11). The view is due while the library is
// empty and `onboarding.v1` is unset; finishing it, or skipping it, sets the row. Pure: the main
// process reads and writes the row, the renderer only sees `OnboardingState`.
import { z } from "zod";

/** The `settings` row that records a first run that was finished or skipped. */
export const onboardingSettingKey = "onboarding.v1";

export const onboardingOutcomes = ["completed", "skipped"] as const;
export const OnboardingOutcomeSchema = z.enum(onboardingOutcomes);
export type OnboardingOutcome = z.infer<typeof OnboardingOutcomeSchema>;

/** What `onboarding.v1` holds. */
export const OnboardingRecordSchema = z
  .object({
    version: z.literal(1),
    outcome: OnboardingOutcomeSchema,
    at: z.string().datetime()
  })
  .strict();
export type OnboardingRecord = z.infer<typeof OnboardingRecordSchema>;

/**
 * The stored record, or null when there is none or the row does not read: the first run is then
 * due again, which costs one skip and never hides the app.
 */
export function readOnboardingRecord(stored: unknown): OnboardingRecord | null {
  const parsed = OnboardingRecordSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** The first run is due while nothing was recorded and the library holds no source. */
export function isOnboardingDue(record: OnboardingRecord | null, libraryEmpty: boolean): boolean {
  return record === null && libraryEmpty;
}

/** `onboarding.state` (read): what the renderer decides the first-run view on. */
export const OnboardingStateSchema = z
  .object({
    /** How the first run ended; null while it was neither finished nor skipped. */
    outcome: OnboardingOutcomeSchema.nullable(),
    at: z.string().datetime().nullable(),
    libraryEmpty: z.boolean(),
    /** Whether the full-window first-run view is shown now. */
    show: z.boolean()
  })
  .strict()
  .refine((state) => state.show === (state.outcome === null && state.libraryEmpty), {
    message: "A first run is shown exactly while it is unrecorded and the library is empty."
  });
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export function onboardingStateOf(
  record: OnboardingRecord | null,
  libraryEmpty: boolean
): OnboardingState {
  return {
    outcome: record?.outcome ?? null,
    at: record?.at ?? null,
    libraryEmpty,
    show: isOnboardingDue(record, libraryEmpty)
  };
}

/** `onboarding.finish` (write): the person finished the three steps or skipped them. */
export const OnboardingFinishInputSchema = z.object({ outcome: OnboardingOutcomeSchema }).strict();
export type OnboardingFinishInput = z.infer<typeof OnboardingFinishInputSchema>;
