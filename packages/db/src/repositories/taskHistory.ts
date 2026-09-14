/** Display-only cleanup. Canonical execution, evidence and budget records remain intact. */
export const taskHistoryCutoffKey = 'jobs.history.dismissed-through.v1';
export const terminalTaskStatusesSql = "('applied','sample_passed','succeeded','completed','skipped','no_change','canceled','rejected','failed','superseded')";
/** Arguments are repository-owned SQL expressions, never renderer input. */
export function taskHistoryVisibleSql(status: string, updatedAt: string) {
  return `(${status} not in ${terminalTaskStatusesSql} or ${updatedAt} > coalesce((select (value->>'before')::timestamptz from settings where key='${taskHistoryCutoffKey}'),'-infinity'::timestamptz))`;
}
