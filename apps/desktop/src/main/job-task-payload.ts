/**
 * Jobs persist app-owned admission/monitoring metadata alongside task arguments.
 * Task parsers stay strict: remove only these reserved envelope fields, never
 * arbitrary unknown task keys. The persisted payload is left untouched.
 * `claimedDedupeKey` is the key a claim dropped, kept so a crashed job gets it back.
 * `inboxDismissedAt` is when the owner dismissed the Inbox item of a quarantined job (F4 D29).
 */
const envelopeFields = [
  "promptPin",
  "errorHistory",
  "dashboardDismissedAt",
  "inboxDismissedAt",
  "claimedDedupeKey"
] as const;

export function jobTaskPayload<T extends Record<string, unknown>>(
  payload: T
): Omit<T, (typeof envelopeFields)[number]> {
  const task: Record<string, unknown> = { ...payload };
  for (const field of envelopeFields) delete task[field];
  return task as Omit<T, (typeof envelopeFields)[number]>;
}
