export interface StructuredErrorContext {
  jobId?: string | undefined;
  jobType?: string | undefined;
  ingestionRunId?: string | undefined;
  sourceItemId?: string | undefined;
  documentId?: string | undefined;
  stage?: string | undefined;
  taskType?: string | undefined;
  profileId?: string | null | undefined;
  providerId?: string | null | undefined;
  modelId?: string | null | undefined;
  runtime?: string | null | undefined;
  aiTaskRunId?: string | null | undefined;
}

export function logStructuredError(
  logger: Pick<Console, "error"> | undefined,
  event: string,
  context: StructuredErrorContext,
  error: unknown,
  fallbackErrorCode: string
): void {
  if (!logger) return;
  const fields = Object.fromEntries(
    Object.entries(context).filter((entry): entry is [string, string | null] => entry[1] !== undefined)
  );
  logger.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    event,
    ...fields,
    errorType: safeToken(error instanceof Error ? error.name : "UnknownError", "UnknownError"),
    errorCode: safeErrorCode(error, fallbackErrorCode)
  }));
}

function safeErrorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return safeToken(message, fallback);
}

function safeToken(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 120 && /^[a-zA-Z0-9_.:-]+$/.test(trimmed)
    ? trimmed
    : fallback;
}
