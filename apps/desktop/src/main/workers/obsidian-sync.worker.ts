export async function runObsidianSync(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { deferred: true, entityId: payload.entityId ?? null };
}
