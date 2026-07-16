import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import {
  DOCLING_PROTOCOL_VERSION,
  doclingProgressSchema,
  doclingRequestSchema,
  doclingResponseSchema,
  type DoclingResponse
} from "./docling-contracts.js";
import type {
  ConversionProfile,
  ConversionProgressListener,
  MarkdownConversionResult
} from "./types.js";

export interface DoclingClientOptions {
  executablePath: string;
  sidecarScriptPath: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  conversionOptions?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}

export class DoclingClient {
  public constructor(private readonly options: DoclingClientOptions) {}

  public async convert(
    inputPath: string,
    profile: ConversionProfile = "standard",
    signal?: AbortSignal,
    onProgress?: ConversionProgressListener
  ): Promise<MarkdownConversionResult> {
    const pageStart = positiveInteger(this.options.conversionOptions?.pageStart);
    const pageEnd = positiveInteger(this.options.conversionOptions?.pageEnd);
    const maxInputBytes = positiveInteger(this.options.conversionOptions?.maxInputBytes);
    const request = doclingRequestSchema.parse({
      protocolVersion: DOCLING_PROTOCOL_VERSION,
      requestId: randomUUID(),
      command: "convert",
      inputPath,
      profile,
      ...(pageStart ? { pageStart } : {}),
      ...(pageEnd ? { pageEnd } : {}),
      ...(maxInputBytes ? { maxInputBytes } : {}),
      options: this.options.conversionOptions ?? {}
    });
    const child = spawn(this.options.executablePath, [this.options.sidecarScriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...this.options.env, PYTHONNOUSERSITE: "1", PYTHONUNBUFFERED: "1" }
    });
    let stdoutBuffer = "";
    let stdoutBytes = 0;
    let stderr = "";
    let outputLimitExceeded = false;
    let timedOut = false;
    let protocolError: Error | null = null;
    const responseHolder: { value: DoclingResponse | null } = { value: null };
    const maxOutputBytes = this.options.maxOutputBytes ?? 256 * 1024 * 1024;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill("SIGTERM");
        return;
      }
      stdoutBuffer += chunk;
      try {
        stdoutBuffer = consumeJsonLines(stdoutBuffer, false, (line) => {
          const message = JSON.parse(line) as unknown;
          const progress = doclingProgressSchema.safeParse(message);
          if (progress.success) {
            if (progress.data.requestId !== request.requestId) {
              throw new Error("Docling progress request id mismatch.");
            }
            try {
              onProgress?.(progress.data);
            } catch {
              // UI progress observers cannot invalidate a successful conversion.
            }
            return;
          }
          const finalResponse = doclingResponseSchema.parse(message);
          if (finalResponse.requestId !== request.requestId) {
            throw new Error("Docling response request id mismatch.");
          }
          if (responseHolder.value) throw new Error("Docling sidecar returned more than one final response.");
          responseHolder.value = finalResponse;
        });
      } catch (error) {
        protocolError = error instanceof Error ? error : new Error(String(error));
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });

    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      abort();
    }, this.options.timeoutMs ?? 120_000);
    child.stdin.end(`${JSON.stringify(request)}\n`);

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      if (signal?.aborted) throw new DOMException("Conversion canceled.", "AbortError");
      if (timedOut) throw new Error("errors.conversion.doclingFailed:timeout");
      if (outputLimitExceeded) throw new Error("errors.conversion.doclingFailed:output-limit");
      if (!protocolError) {
        try {
          stdoutBuffer = consumeJsonLines(stdoutBuffer, true, (line) => {
            const finalResponse = doclingResponseSchema.parse(JSON.parse(line));
            if (finalResponse.requestId !== request.requestId) {
              throw new Error("Docling response request id mismatch.");
            }
            if (responseHolder.value) throw new Error("Docling sidecar returned more than one final response.");
            responseHolder.value = finalResponse;
          });
        } catch (error) {
          protocolError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (protocolError) throw protocolError;
      if (exitCode !== 0) throw new Error(`Docling sidecar exited with code ${String(exitCode)}: ${stderr.slice(-500)}`);
      const response = responseHolder.value;
      if (!response) throw new Error("Docling sidecar returned no response.");
      if (!response.ok) throw new Error(response.error.messageKey);
      return response.result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (!child.killed) child.kill("SIGTERM");
    }
  }
}

function consumeJsonLines(
  buffer: string,
  includeRemainder: boolean,
  consume: (line: string) => void
): string {
  const lines = buffer.split(/\r?\n/);
  const remainder = includeRemainder ? "" : lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim()) consume(line);
  }
  if (includeRemainder && remainder.trim()) consume(remainder);
  return remainder;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
