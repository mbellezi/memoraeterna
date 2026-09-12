/**
 * Jobs persist app-owned admission/monitoring metadata alongside task arguments.
 * Task parsers stay strict: remove only these reserved envelope fields, never
 * arbitrary unknown task keys. The persisted payload is left untouched.
 */
export function jobTaskPayload<T extends Record<string, unknown>>(payload: T): Omit<T, 'promptPin' | 'errorHistory' | 'dashboardDismissedAt'> {
  const { promptPin: _promptPin, errorHistory: _errorHistory, dashboardDismissedAt: _dashboardDismissedAt, ...task } = payload;
  return task;
}
