/**
 * Reads an AI cassette for the prompt-replay harness (F4 T69). A cassette (`packages/ai/src/cassette.ts`)
 * holds, per call the product made, the composed request the adapter received and the answer it gave. The
 * replay sends the same requests to a local writer, so this module only reads: it validates the entries,
 * puts back the database IDs the cassette key replaced with positional placeholders and splits off the
 * output-language instruction `AiService` prepends, leaving the prompt body a caller built.
 *
 * Nothing here writes a cassette, calls a model or touches a profile.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { withOutputLanguageInstruction } from "../../apps/desktop/src/main/services/prompt-runtime.js";

const manifestSchema = z
  .object({ format: z.literal("memora-ai-cassette"), version: z.literal(1) })
  .passthrough();

const responseSchema = z
  .object({
    output: z.unknown(),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    runtime: z.enum(["remote", "local", "sidecar"]),
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    recordedAt: z.string()
  })
  .passthrough();

const entrySchema = z
  .object({
    format: z.literal("memora-ai-cassette-entry"),
    version: z.literal(1),
    key: z.string().regex(/^[0-9a-f]{64}$/u),
    taskType: z.string().min(1),
    request: z
      .object({
        input: z.unknown(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        instruction: z.string().nullable().optional(),
        model: z
          .object({
            providerId: z.string().min(1),
            modelId: z.string().min(1),
            runtime: z.string().min(1)
          })
          .passthrough()
      })
      .passthrough(),
    responses: z.array(responseSchema).min(1)
  })
  .passthrough();

/** One recorded call: the request as the adapter saw it and the first answer recorded for it. */
export interface RecordedCall {
  /** The cassette key (SHA-256 of the canonical request): a call's identity across runs. */
  key: string;
  taskType: string;
  /** The composed input with the database IDs put back as synthetic UUIDs. */
  input: string;
  parameters: Record<string, unknown>;
  /** The answer as text, IDs put back. Empty when the recorded output was not text. */
  output: string;
  providerId: string;
  modelId: string;
  runtime: "remote" | "local" | "sidecar";
  durationMs: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  recordedAt: string;
  /** How many answers the key holds (a key repeated within a run records each occurrence). */
  responses: number;
}

/** The synthetic UUID that stands for placeholder number `n` of a cassette entry (`⟦id:n⟧`). */
export function syntheticId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * Puts back the IDs a cassette key replaced with `⟦id:N⟧`. The real IDs are not stored, so a
 * deterministic UUID per placeholder stands in: prompts are a function of content (`rules/ai.md`), so
 * the model sees the same text whatever the ID, and the same placeholder keeps one ID in the prompt
 * and in the recorded answer.
 */
export function rehydrateIds(text: string): string {
  return text.replace(/⟦id:(\d+)⟧/gu, (_match, n: string) => syntheticId(Number(n)));
}

/** Languages the product states in the output-language instruction (`withOutputLanguageInstruction`). */
const knownLanguages = ["en", "pt-BR", "it", "fr", "es"] as const;

/**
 * Splits the output-language instruction `AiService` puts before a prompt. Returns the language the
 * instruction names and the prompt body a caller built, or null when the input does not start with the
 * instruction of a known language.
 */
export function splitLanguagePrefix(input: string): { language: string; body: string } | null {
  for (const language of knownLanguages) {
    const prefix = withOutputLanguageInstruction("", language);
    if (input.startsWith(prefix)) return { language, body: input.slice(prefix.length) };
  }
  return null;
}

/** The prompt a model receives for a body and a language: what `AiService` composes for a local run. */
export function composeInput(body: string, language: string): string {
  return withOutputLanguageInstruction(body, language);
}

export interface ReadCassetteOptions {
  /** Keeps only entries of these task types (the others are not even validated). */
  taskTypes?: ReadonlySet<string>;
  /** Keeps only entries a remote or local runtime recorded. */
  runtime?: "remote" | "local" | "sidecar";
}

/**
 * Reads every entry of a cassette folder. The folder holds `cassette.json` and `entries/**` (sharded by
 * key prefix). Entries are returned in the order they were first recorded, the key breaking a tie, so a
 * replay follows the pipeline's own order and a resumed run sees the same sequence.
 */
export async function readCassette(
  directory: string,
  options: ReadCassetteOptions = {}
): Promise<RecordedCall[]> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(directory, "cassette.json"), "utf8"));
  } catch {
    throw new Error(`${directory} is not a cassette: cassette.json is missing or unreadable.`);
  }
  manifestSchema.parse(manifest);
  const entriesDirectory = join(directory, "entries");
  const files = (await readdir(entriesDirectory, { recursive: true, withFileTypes: true }))
    .filter((file) => file.isFile() && file.name.endsWith(".json"))
    .map((file) => join(file.parentPath, file.name));
  const calls: RecordedCall[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(file, "utf8")) as { taskType?: unknown };
    if (options.taskTypes && !options.taskTypes.has(String(raw.taskType))) continue;
    const entry = entrySchema.parse(raw);
    const first = entry.responses[0]!;
    if (options.runtime && first.runtime !== options.runtime) continue;
    if (typeof entry.request.input !== "string") continue;
    calls.push({
      key: entry.key,
      taskType: entry.taskType,
      input: rehydrateIds(entry.request.input),
      parameters: entry.request.parameters ?? {},
      output: typeof first.output === "string" ? rehydrateIds(first.output) : "",
      providerId: first.providerId,
      modelId: first.modelId,
      runtime: first.runtime,
      durationMs: first.durationMs,
      inputTokens: first.inputTokens,
      outputTokens: first.outputTokens,
      recordedAt: first.recordedAt,
      responses: entry.responses.length
    });
  }
  return calls.sort(
    (left, right) =>
      left.recordedAt.localeCompare(right.recordedAt) || left.key.localeCompare(right.key)
  );
}
