import type { StructuredErrorContext } from "./structured-logging.js";

export function logLocalModelOutput(
  logger: Pick<Console, "info"> | undefined,
  enabled: boolean,
  context: StructuredErrorContext,
  output: unknown
): void {
  if (!enabled || !logger || typeof output !== "string") return;
  const fields = Object.fromEntries(
    Object.entries(context).filter((entry): entry is [string, string | null] => entry[1] !== undefined)
  );
  logger.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "debug",
    event: "local_model_output_debug",
    privacyWarning: "contains_full_local_model_output",
    ...fields,
    output
  }));
}
