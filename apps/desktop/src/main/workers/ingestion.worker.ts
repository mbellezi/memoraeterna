export async function runIngestion(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { accepted: true, checkpoint: payload.checkpoint ?? "queued" };
}
