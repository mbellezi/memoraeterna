import type { Queryable } from "@app/db";

/**
 * Answer capture for gate S (F4 T91, owner 10-25): debug mode and full capture on, so
 * `monitoring_operations` keeps what each call was asked and answered, which the report reads when a
 * repair or a refusal needs the answer behind it (gate S of 10-24 kept none).
 *
 * Full capture retains content, and rules/security-privacy.md asks for the owner's confirmation of
 * that retention. The owner confirmed it for gate S's profile only, so this file turns it on for one
 * profile folder and checks that every other 7-day run starts with it off:
 *
 * - a plan profile asks for it with `f4.capture: "answers"` (`soak7-gate` alone does), and
 *   `readSoakKnob` refuses that profile on any folder but {@link answerCaptureProfileFolder};
 * - the start turns the two settings on in that profile's saved app preferences, before any job can
 *   make a call; a profile with no saved preferences to change stops the run (it would run for hours
 *   keeping nothing), as the re-match tool's candidate recording does;
 * - the 7-day soak (`soak7`, the profile `env-soak7-run` is cloned for) never asks for it, and its
 *   start refuses a library where full capture is already on, whatever put it there.
 *
 * The setting is read by `MonitoringService` at every call, so no restart is needed.
 */

/** The only profile folder the owner's retention confirmation of 10-25 covers. */
export const answerCaptureProfileFolder = "env-soak7-gate";

/** Where the app keeps its preferences (`settings-service.ts`); the re-match tool writes the same row. */
const preferencesKey = "app.preferences";

/** Turns debug mode and full capture on in the saved app preferences; false when none are saved. */
export async function enableAnswerCapture(db: Queryable): Promise<boolean> {
  const result = await db.query<{ debugMode: string | null; debugFullCapture: string | null }>(
    `update settings
        set value = value || '{"debugMode": true, "debugFullCapture": true}'::jsonb,
            updated_at = now()
      where key = $1
      returning value ->> 'debugMode' as "debugMode",
                value ->> 'debugFullCapture' as "debugFullCapture"`,
    [preferencesKey]
  );
  const row = result.rows[0];
  return result.rows.length === 1 && row?.debugMode === "true" && row.debugFullCapture === "true";
}

/** Whether the saved app preferences keep full capture on. */
export async function answerCaptureIsOn(db: Queryable): Promise<boolean> {
  const result = await db.query<{ on: string | null }>(
    "select value ->> 'debugFullCapture' as \"on\" from settings where key = $1",
    [preferencesKey]
  );
  return result.rows[0]?.on === "true";
}

/**
 * Applies a 7-day profile's capture choice at the start of its run. Resolves to the reason the run
 * must not start, or null: a profile that asks for the capture and has nowhere to turn it on, or one
 * that does not ask and finds it on.
 */
export async function answerCaptureProblem(
  db: Queryable,
  options: { wanted: boolean }
): Promise<string | null> {
  if (options.wanted) {
    return (await enableAnswerCapture(db))
      ? null
      : "This profile's plan asks for answer capture, but the library has no saved app preferences to turn debug mode and full capture on in; start the app on it once, then again.";
  }
  return (await answerCaptureIsOn(db))
    ? `Full capture is on in this library, and the owner's retention confirmation (10-25) covers gate S's profile ${answerCaptureProfileFolder} only: turn it off in Settings, Advanced, Diagnostics.`
    : null;
}
