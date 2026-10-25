/**
 * Jobs persist app-owned admission/monitoring metadata alongside task arguments.
 * Task parsers stay strict: remove only these reserved envelope fields, never
 * arbitrary unknown task keys. The persisted payload is left untouched.
 * `claimedDedupeKey` is the key a claim dropped, kept so a crashed job gets it back.
 * `inboxDismissedAt` is when the owner dismissed the Inbox item of a quarantined job (F4 D29).
 * `aiExecution` is the model an AI call of the job ran on, written by the AI service for the Jobs
 * screen as the call starts, so a job that runs again after a call (a retry, a blocker set aside)
 * carries it.
 */
const envelopeFields = [
  "promptPin",
  "errorHistory",
  "dashboardDismissedAt",
  "inboxDismissedAt",
  "claimedDedupeKey",
  "aiExecution"
] as const;

export function jobTaskPayload<T extends Record<string, unknown>>(
  payload: T
): Omit<T, (typeof envelopeFields)[number]> {
  const task: Record<string, unknown> = { ...payload };
  for (const field of envelopeFields) delete task[field];
  return task as Omit<T, (typeof envelopeFields)[number]>;
}
