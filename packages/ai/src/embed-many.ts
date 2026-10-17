import type {
  AiEmbedManyOptions,
  AiEmbedManyResult,
  AiTaskRequest,
  AiTaskResult
} from "./contracts.js";
import { withCallReport, type RemoteCallReport } from "./remote-execution.js";

/** The vector size a batch asks for: the stated one, else the effective parameter, else 768. */
export function embedManyDimensions(options: AiEmbedManyOptions): number {
  if (typeof options.dimensions === "number") return options.dimensions;
  const parameter = options.parameters?.dimensions;
  return typeof parameter === "number" ? parameter : 768;
}

/**
 * The single embedding request a batch stands for: it carries the parameters and the stated class,
 * which choose a remote call's deadlines, and the effective parameters a cassette keys by.
 */
export function embedManyRequest(text: string, options: AiEmbedManyOptions): AiTaskRequest {
  return {
    taskType: "embedding",
    input: text,
    requiredCapabilities: [],
    parameters: options.parameters ?? { dimensions: embedManyDimensions(options) },
    metadata: {},
    ...(options.modelId ? { modelId: options.modelId } : {}),
    ...(options.workloadClass ? { workloadClass: options.workloadClass } : {}),
    ...(options.operation ? { operation: options.operation } : {})
  };
}

export function chunkTexts<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    groups.push(items.slice(start, start + size));
  return groups;
}

/** Adds the numeric entries of several usage records. */
export function sumTokenUsage(
  usages: ReadonlyArray<Record<string, number> | undefined>
): Record<string, number> | undefined {
  const present = usages.filter((usage): usage is Record<string, number> => usage !== undefined);
  if (present.length === 0) return undefined;
  const total: Record<string, number> = {};
  for (const usage of present)
    for (const [key, value] of Object.entries(usage)) total[key] = (total[key] ?? 0) + value;
  return total;
}

/** The report of several requests of one batch: their attempts and failed usage added up. */
export function mergeCallReports(
  reports: readonly RemoteCallReport[]
): RemoteCallReport | undefined {
  if (reports.length === 0) return undefined;
  const sum = (field: "inputTokens" | "outputTokens") => {
    const values = reports.flatMap((report) => report.failedUsage[field] ?? []);
    return values.length > 0 ? { [field]: values.reduce((a, b) => a + b, 0) } : {};
  };
  const last = reports.at(-1)!;
  return {
    attempts: reports.reduce((total, report) => total + report.attempts, 0),
    failedUsage: { ...sum("inputTokens"), ...sum("outputTokens") },
    ...(last.requestOptions ? { requestOptions: last.requestOptions } : {})
  };
}

/** What a remote adapter assembles from the requests of one batch. */
export interface RemoteEmbedPart {
  embeddings: number[][];
  inputTokens?: number | undefined;
  tokenUsage?: Record<string, number> | undefined;
}

/** The batch result of the requests an adapter sent, reports applied as a single call's are. */
export function remoteEmbedManyResult(input: {
  providerId: string;
  modelId: string;
  durationMs: number;
  parts: readonly RemoteEmbedPart[];
  reports: readonly RemoteCallReport[];
}): AiEmbedManyResult {
  const inputTokens = input.parts.flatMap((part) => part.inputTokens ?? []);
  const tokenUsage = sumTokenUsage(input.parts.map((part) => part.tokenUsage));
  const base: AiTaskResult = {
    taskType: "embedding",
    output: null,
    providerId: input.providerId,
    modelId: input.modelId,
    runtime: "remote",
    durationMs: input.durationMs,
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(inputTokens.length === input.parts.length
      ? { inputTokens: inputTokens.reduce((a, b) => a + b, 0) }
      : {})
  };
  const reported = withCallReport(base, mergeCallReports(input.reports));
  return {
    embeddings: input.parts.flatMap((part) => part.embeddings),
    providerId: reported.providerId,
    modelId: reported.modelId,
    runtime: reported.runtime,
    durationMs: reported.durationMs,
    ...(reported.inputTokens !== undefined ? { inputTokens: reported.inputTokens } : {}),
    ...(reported.tokenUsage ? { tokenUsage: reported.tokenUsage } : {}),
    ...(reported.attempts !== undefined ? { attempts: reported.attempts } : {}),
    ...(reported.retriedUsage ? { retriedUsage: reported.retriedUsage } : {})
  };
}
