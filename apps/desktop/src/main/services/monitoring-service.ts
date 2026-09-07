import { createMonitoringRepository, type MonitoringStart, type MonitoringFinish, type PgPool } from "@app/db";
import { redactSensitiveText } from "@app/ai";
import {
  monitoringDetailSchema, monitoringPageSchema, monitoringQuerySchema, monitoringPruneSchema,
  type MonitoringQuery, type MonitoringPrune
} from "../../shared/monitoring.js";

interface Capture { id: string; full: boolean }

export class MonitoringService {
  public constructor(
    private readonly getPool: () => PgPool | null,
    private readonly getSettings: () => Promise<{ debugMode: boolean; debugFullCapture: boolean }>,
    private readonly logger: Pick<Console, "error"> = console
  ) {}

  public async start(input: Omit<MonitoringStart, "debugRecorded">): Promise<Capture | null> {
    try {
      const settings = await this.getSettings();
      if (input.kind === "operation" && !settings.debugMode) return null;
      const full = settings.debugMode && settings.debugFullCapture;
      const id = await this.repository().start({ ...input, debugRecorded: settings.debugMode,
        input: full ? input.input : undefined });
      return { id, full };
    } catch (error) { this.logFailure(error); return null; }
  }

  public async finish(capture: Capture | null | undefined, result: MonitoringFinish): Promise<void> {
    if (!capture) return;
    try {
      // Turning capture off also prevents in-flight outputs from being retained.
      const settings = await this.getSettings();
      await this.repository().finish(capture.id, { ...result,
        output: capture.full && settings.debugMode && settings.debugFullCapture ? result.output : undefined });
    } catch (error) { this.logFailure(error); }
  }

  public async operation<T>(operation: string, context: Record<string, unknown>, run: () => Promise<T>, details: Record<string, unknown> = {}): Promise<T> {
    const started = Date.now();
    const sourceItemIds = [...new Set([
      ...(typeof context.sourceItemId === "string" ? [context.sourceItemId] : []),
      ...(Array.isArray(context.sourceItemIds) ? context.sourceItemIds.filter((id): id is string => typeof id === "string") : [])
    ])];
    const capture = await this.start({ kind: "operation", operation, stage: operation,
      context: { ...context, origin: context.origin ?? (context.ingestionRunId ? "ingestion" : context.jobId ? "job" : "interactive") }, sourceItemIds, input: details });
    try {
      const output = await run();
      await this.finish(capture, { status: "succeeded", durationMs: Date.now() - started, details, output });
      return output;
    } catch (error) {
      await this.finish(capture, { status: error instanceof Error && error.name === "AbortError" ? "canceled" : "failed",
        durationMs: Date.now() - started, details, error: redactSensitiveText(error) });
      throw error;
    }
  }

  public async recover() {
    try { await this.repository().recover(); }
    catch (error) { this.logFailure(error); }
  }
  public async list(input: MonitoringQuery) {
    const page = await this.repository().list(monitoringQuerySchema.parse(input));
    return monitoringPageSchema.parse({ ...page, rows: page.rows.map(serialize) });
  }
  public async detail(id: string) {
    const row = await this.repository().detail(id);
    return row ? monitoringDetailSchema.parse(serialize(row)) : null;
  }
  public async prune(input: MonitoringPrune) {
    const parsed = monitoringPruneSchema.parse(input);
    const cutoff = monitoringCutoff(new Date(), parsed.amount, parsed.unit);
    return { cutoff: cutoff.toISOString(), count: await this.repository().prune(cutoff, parsed.scope, parsed.preview) };
  }
  private repository() {
    const pool = this.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return createMonitoringRepository(pool);
  }
  private logFailure(error: unknown) { this.logger.error("Monitoring persistence failed", redactSensitiveText(error)); }
}

export function monitoringCutoff(now: Date, amount: number, unit: "days" | "months"): Date {
  const cutoff = new Date(now);
  if (unit === "days") cutoff.setUTCDate(cutoff.getUTCDate() - amount);
  else {
    const day = cutoff.getUTCDate();
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - amount);
    const last = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
    cutoff.setUTCDate(Math.min(day, last));
  }
  return cutoff;
}
function serialize(row: Record<string, unknown>) {
  return { ...row, startedAt: new Date(row.startedAt as string | Date).toISOString(),
    finishedAt: row.finishedAt ? new Date(row.finishedAt as string | Date).toISOString() : null };
}
