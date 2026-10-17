import { parseSingleJsonObject, toStrictJsonSchema, type AiOutputSchema } from "@app/domain";
import { z } from "zod";

import type { AiService } from "./ai-service.js";

/**
 * The strict-schema probe (F3 T55 proof): a handful of live structured calls that carry a strict
 * `outputSchema`, to show what the routed backend does with it. On Codex the adapter sends
 * `text.format` (json_schema, strict); a backend that refuses it is a counted schema fallback, not a
 * failure. The probe reports counts only: no prompt or answer text leaves it.
 *
 * DEV only: a golden run with `MEMORA_GOLDEN_SCHEMA_PROBE=<calls>` runs it instead of the manifest
 * (`golden-runner.ts`), through the normal AI service and its cassette, so the token cap applies.
 */

export const schemaProbeKnob = "MEMORA_GOLDEN_SCHEMA_PROBE";
/** The most calls a probe makes (the spec's budget: at most 20 calls, about 20k tokens). */
export const schemaProbeMaxCalls = 20;

/** The probe's contract: strict-compatible, so the schema it sends is the contract's own. */
export const schemaProbeContract = z
  .object({
    verdict: z.enum(["same", "different"]),
    reason: z.string().trim().min(1).max(200)
  })
  .strict();

export const schemaProbeOutputSchema = toStrictJsonSchema(
  schemaProbeContract,
  "schema_probe_verdict"
) as AiOutputSchema;

/** Synthetic statement pairs; the probe never reads the library. */
const pairs: Array<[string, string]> = [
  [
    "Spaced review slows forgetting.",
    "Reviewing material at intervals reduces how fast it is lost."
  ],
  ["Sleep consolidates memory.", "Tides are caused mainly by the moon's gravity."],
  ["Retrieval practice strengthens recall.", "Testing yourself on material helps you remember it."],
  [
    "Water boils at a lower temperature at altitude.",
    "Cold air holds less moisture than warm air."
  ],
  [
    "Interleaving mixes topics during study.",
    "Studying several subjects in alternation is called interleaving."
  ]
];

export function readSchemaProbeCalls(
  env: Readonly<Record<string, string | undefined>>
): number | null {
  const raw = env[schemaProbeKnob]?.trim();
  if (!raw) return null;
  const calls = Number(raw);
  if (!Number.isSafeInteger(calls) || calls < 1 || calls > schemaProbeMaxCalls)
    throw new Error(`${schemaProbeKnob} must be an integer from 1 to ${schemaProbeMaxCalls}`);
  return calls;
}

export interface SchemaProbeReport {
  calls: number;
  /** Calls that returned an answer. */
  answered: number;
  /** Answers that are one JSON object valid for the contract. */
  valid: number;
  /** Answers that are not (the schema should make this 0 when the backend honours it). */
  invalid: number;
  /** Calls that failed before an answer. */
  failed: number;
  /** The mode each answered call reports (`schema_mode`). */
  schemaModes: Record<string, number>;
  /** Calls whose request fell back from the strict schema (refused now, or refused earlier). */
  schemaFallbacks: number;
  inputTokens: number;
  outputTokens: number;
  /** The first error messages of the failed calls, at most three, with no prompt text. */
  errors: string[];
}

/** Runs `calls` structured calls with the strict schema through the AI service. */
export async function runSchemaProbe(input: {
  ai: Pick<AiService, "runDefaultTask">;
  calls: number;
  signal?: AbortSignal;
}): Promise<SchemaProbeReport> {
  const report: SchemaProbeReport = {
    calls: input.calls,
    answered: 0,
    valid: 0,
    invalid: 0,
    failed: 0,
    schemaModes: {},
    schemaFallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
    errors: []
  };
  for (let index = 0; index < input.calls; index += 1) {
    const [first, second] = pairs[index % pairs.length]!;
    // The round is part of the prompt so a repeated pair is a new request for the cassette too.
    const round = Math.floor(index / pairs.length) + 1;
    const prompt =
      `Decide whether the two statements say the same thing. Answer with JSON: verdict is "same" or ` +
      `"different", reason is one short sentence.\nStatement A: ${first}\nStatement B: ${second}\n` +
      `(probe round ${round})`;
    try {
      const result = await input.ai.runDefaultTask(
        "structured-output",
        prompt,
        {
          operation: "schema_probe",
          stage: "schema_probe",
          origin: "interactive",
          priority: "P2",
          outputSchema: schemaProbeOutputSchema
        },
        input.signal
      );
      if (!result) {
        report.failed += 1;
        if (report.errors.length < 3) report.errors.push("no route serves structured output");
        continue;
      }
      report.answered += 1;
      report.inputTokens += result.inputTokens ?? 0;
      report.outputTokens += result.outputTokens ?? 0;
      const mode = result.schemaMode ?? "unknown";
      report.schemaModes[mode] = (report.schemaModes[mode] ?? 0) + 1;
      if (result.requestOptions?.schemaFallback !== undefined) report.schemaFallbacks += 1;
      try {
        schemaProbeContract.parse(parseSingleJsonObject(result.output));
        report.valid += 1;
      } catch {
        report.invalid += 1;
      }
    } catch (error) {
      report.failed += 1;
      if (report.errors.length < 3)
        report.errors.push(
          error instanceof Error ? error.message.split("\n")[0]!.slice(0, 200) : "failed"
        );
    }
  }
  return report;
}
