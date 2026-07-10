import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { doclingRequestSchema, doclingResponseSchema } from "./docling-contracts.js";
import type { ConversionProfile, MarkdownConversionResult } from "./types.js";

export interface DoclingClientOptions {
  executablePath: string;
  sidecarScriptPath: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class DoclingClient {
  public constructor(private readonly options: DoclingClientOptions) {}

  public async convert(
    inputPath: string,
    profile: ConversionProfile = "standard",
    signal?: AbortSignal
  ): Promise<MarkdownConversionResult> {
    const request = doclingRequestSchema.parse({
      protocolVersion: 1,
      requestId: randomUUID(),
      command: "convert",
      inputPath,
      profile,
      options: {}
    });
    const child = spawn(this.options.executablePath, [this.options.sidecarScriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...this.options.env, PYTHONNOUSERSITE: "1", PYTHONUNBUFFERED: "1" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, this.options.timeoutMs ?? 120_000);
    child.stdin.end(`${JSON.stringify(request)}\n`);

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      if (signal?.aborted) throw new DOMException("Conversion canceled.", "AbortError");
      if (exitCode !== 0) throw new Error(`Docling sidecar exited with code ${String(exitCode)}: ${stderr.slice(-500)}`);
      const line = stdout.split(/\r?\n/).find((value) => value.trim().length > 0);
      if (!line) throw new Error("Docling sidecar returned no response.");
      const response = doclingResponseSchema.parse(JSON.parse(line));
      if (response.requestId !== request.requestId) throw new Error("Docling response request id mismatch.");
      if (!response.ok) throw new Error(response.error.messageKey);
      return response.result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (!child.killed) child.kill("SIGTERM");
    }
  }
}
