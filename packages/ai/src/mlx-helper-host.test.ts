import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MlxAdapter } from "./local-adapters.js";
import type { LocalDisposeStep } from "./dispose-step.js";
import { MlxHelperError, MlxHelperHost } from "./mlx-helper-host.js";

const roots: string[] = [];
const hosts: MlxHelperHost[] = [];
/** A PATH on which the fake helper's `#!/usr/bin/env node` can find node. */
const nodePath = `${dirname(process.execPath)}:/usr/bin:/bin`;

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A scripted stand-in for `memora-mlx-helper`. It records `<pid> <command>` for every request in
 * `requests.log`, answers with uppercase request IDs like the Swift helper, and reacts to magic
 * inputs: "hang" never answers, "slow" answers after 150 ms, "env" returns the environment it
 * received, "fail" reports a helper error, "badshape" sends a message that breaks the protocol.
 */
async function createFakeHelper(
  options: { ignoreShutdown?: boolean } = {}
): Promise<{ helperPath: string; log: () => Promise<string[][]> }> {
  const root = await mkdtemp(join(tmpdir(), "memora-mlx-host-"));
  roots.push(root);
  const helperPath = join(root, "fake-helper.mjs");
  const logPath = join(root, "requests.log");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const timing = { loadMs: 0, modelCached: true, tokenizeMs: 0.1, inferenceMs: 2, perItemMs: 1, totalMs: 2.5,
  batches: [{ size: 2, sequenceLength: 8, ms: 2 }] };
const send = (request, body) => process.stdout.write(JSON.stringify({
  protocolVersion: 1, requestId: request.requestId.toUpperCase(), ...body }) + "\\n");
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(logPath)}, process.pid + " " + request.command + "\\n");
  const marker = request.prompt ?? request.texts?.[0] ?? request.query ?? "";
  if (request.command === "shutdown" && !${options.ignoreShutdown === true}) process.exit(0);
  if (marker === "hang") continue;
  if (marker === "slow") await new Promise((resolve) => setTimeout(resolve, 150));
  if (marker === "fail") {
    send(request, { kind: "result", ok: false,
      error: { code: "HelperError", messageKey: "errors.localModels.runtimeFailed", recoverable: true } });
    continue;
  }
  if (marker === "badshape") {
    send(request, { kind: "result", ok: true, unexpected: true });
    continue;
  }
  if (request.command === "health") {
    send(request, { kind: "result", ok: true, output: "ok", durationMs: 0 });
  } else if (request.command === "generate") {
    const output = marker === "env"
      ? JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) =>
          /^(PATH|HOME|TMPDIR|LANG|LC_ALL|MEMORA_.*|SECRET_.*)$/.test(name))))
      : String(process.pid);
    send(request, { kind: "progress", progress: 0.5, messageKey: "localModels.progress.generating" });
    send(request, { kind: "result", ok: true, output, durationMs: 1, inputTokens: 3, outputTokens: 1 });
  } else if (request.command === "embed") {
    process.stdout.write("MLX diagnostic outside the protocol\\n");
    send(request, { kind: "progress", progress: 0.1, messageKey: "localModels.progress.embedding" });
    send(request, { kind: "result", ok: true, durationMs: 4, inputTokens: 6,
      embeddings: request.texts.map(() => [0.6, 0.8]), dimensions: 2, normalized: true, pooling: "last",
      tokenCounts: request.texts.map(() => 3), truncated: request.texts.map(() => false), timing });
  } else if (request.command === "score") {
    const count = (request.documents ?? request.pairs).length;
    send(request, { kind: "result", ok: true, durationMs: 5, inputTokens: 40 * count,
      scores: Array.from({ length: count }, (_, i) => (i === 0 ? 0.99 : 0.01)),
      logOdds: Array.from({ length: count }, (_, i) => (i === 0 ? 7.5 : -11)),
      yesTokenId: 9693, noTokenId: 2152,
      tokenCounts: Array.from({ length: count }, () => 40),
      truncated: Array.from({ length: count }, () => false), timing });
  }
}
`
  );
  await chmod(helperPath, 0o755);
  return {
    helperPath,
    log: async () => {
      const text = await readFile(logPath, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" "));
    }
  };
}

function createHost(
  helperPath: string,
  options: Partial<ConstructorParameters<typeof MlxHelperHost>[0]> = {}
): MlxHelperHost {
  const host = new MlxHelperHost({ helperPath, environment: { PATH: nodePath }, ...options });
  hosts.push(host);
  return host;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("MlxHelperHost", () => {
  it("serves generate, embed and score from one helper process and ignores diagnostics", async () => {
    const { helperPath, log } = await createFakeHelper();
    const host = createHost(helperPath);
    const progress: Array<[number, string]> = [];

    const generated = await host.generate(
      { modelPath: "/model/generate", prompt: "hello" },
      { onProgress: (message) => progress.push([message.progress, message.messageKey]) }
    );
    const embedded = await host.embed({ modelPath: "/model/embed", texts: ["a", "b"] });
    const scored = await host.score({
      modelPath: "/model/score",
      query: "What is the capital of China?",
      documents: ["The capital of China is Beijing.", "Gravity is a force."]
    });
    const pid = host.pid;

    expect(pid).toBeGreaterThan(0);
    expect(Number(generated.output)).toBe(pid);
    expect(generated).toMatchObject({ inputTokens: 3, outputTokens: 1, durationMs: 1 });
    expect(progress).toEqual([[0.5, "localModels.progress.generating"]]);
    expect(embedded).toMatchObject({ dimensions: 2, pooling: "last", normalized: true });
    expect(embedded.embeddings).toEqual([
      [0.6, 0.8],
      [0.6, 0.8]
    ]);
    expect(scored.logOdds).toEqual([7.5, -11]);
    expect(scored).toMatchObject({ yesTokenId: 9693, noTokenId: 2152 });
    expect(host.spawnCount).toBe(1);
    const entries = await log();
    // A fresh process is asked for its capabilities first; this older one announces none.
    expect(entries.map((entry) => entry[1])).toEqual(["health", "generate", "embed", "score"]);
    expect(new Set(entries.map((entry) => entry[0]))).toEqual(new Set([String(pid)]));
    expect(host.capabilities).toEqual(new Set());
  });

  it("reports a helper failure without killing the helper", async () => {
    const { helperPath } = await createFakeHelper();
    const host = createHost(helperPath);
    await host.health();
    const pid = host.pid;

    const failure = await host
      .embed({ modelPath: "/model/embed", texts: ["fail"] })
      .catch((e) => e);

    expect(failure).toBeInstanceOf(MlxHelperError);
    expect(failure).toMatchObject({
      message: "errors.localModels.runtimeFailed",
      code: "HelperError",
      recoverable: true
    });
    await expect(
      host.score({ modelPath: "/model/score", query: "q", documents: ["d"] })
    ).resolves.toMatchObject({ scores: [0.99] });
    expect(host.pid).toBe(pid);
    expect(host.spawnCount).toBe(1);
  });

  it("treats a message that breaks the protocol as a failure and respawns the helper", async () => {
    const { helperPath } = await createFakeHelper();
    const host = createHost(helperPath);
    await host.health();
    const firstPid = host.pid!;

    await expect(
      host.generate({ modelPath: "/model/generate", prompt: "badshape" })
    ).rejects.toMatchObject({ name: "MlxHelperError", code: "protocol" });
    await expect(
      host.embed({ modelPath: "/model/embed", texts: ["badshape"] })
    ).rejects.toMatchObject({ code: "protocol" });

    const output = (await host.generate({ modelPath: "/model/generate", prompt: "after" })).output;
    expect(Number(output)).not.toBe(firstPid);
    expect(host.spawnCount).toBe(3);
    expect(isAlive(firstPid)).toBe(false);
  });

  it("rejects invalid requests before they reach the helper", async () => {
    const { helperPath, log } = await createFakeHelper();
    const host = createHost(helperPath);

    await expect(host.embed({ modelPath: "/m", texts: [] })).rejects.toThrow();
    await expect(host.embed({ modelPath: "/m", texts: ["a"], batchSize: 513 })).rejects.toThrow();
    await expect(
      host.score({ modelPath: "/m", query: "q", documents: ["d"], batchSize: 0 })
    ).rejects.toThrow();

    expect(host.spawnCount).toBe(0);
    expect(await log()).toEqual([]);
  });

  it("kills the helper on a timeout and respawns it for the next call", async () => {
    const { helperPath } = await createFakeHelper();
    const host = createHost(helperPath);
    await host.health();
    const firstPid = host.pid!;

    const startedAt = Date.now();
    await expect(
      host.score({ modelPath: "/m", query: "hang", documents: ["d"] }, { timeoutMs: 200 })
    ).rejects.toMatchObject({
      message: "errors.localModels.runtimeFailed",
      code: "timeout"
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(host.pid).toBeUndefined();

    const output = (await host.generate({ modelPath: "/m", prompt: "again" })).output;

    expect(Number(output)).not.toBe(firstPid);
    expect(isAlive(firstPid)).toBe(false);
    expect(host.spawnCount).toBe(2);
  });

  it("does not count the wait for earlier requests against a request deadline", async () => {
    const { helperPath } = await createFakeHelper();
    const host = createHost(helperPath);
    await host.health();

    const slow = host.generate({ modelPath: "/m", prompt: "slow" });
    const queued = host.generate({ modelPath: "/m", prompt: "queued" }, { timeoutMs: 100 });

    await expect(slow).resolves.toMatchObject({ durationMs: 1 });
    await expect(queued).resolves.toMatchObject({ durationMs: 1 });
    expect(host.spawnCount).toBe(1);
  });

  it("passes a minimal environment and the memory bounds from the typed configuration", async () => {
    const { helperPath } = await createFakeHelper();
    const defaults = createHost(helperPath, {
      environment: {
        PATH: nodePath,
        HOME: "/home/test",
        TMPDIR: "/tmp/test",
        LANG: "pt_BR.UTF-8",
        SECRET_API_KEY: "must-not-leak",
        MEMORA_UNRELATED: "must-not-leak"
      }
    });
    const configured = createHost(helperPath, {
      environment: { PATH: nodePath, MEMORA_MLX_CACHE_LIMIT_MB: "512" },
      config: { memoryLimitMb: 8_192 }
    });

    const defaultEnvironment = JSON.parse(
      (await defaults.generate({ modelPath: "/m", prompt: "env" })).output
    );
    const configuredEnvironment = JSON.parse(
      (await configured.generate({ modelPath: "/m", prompt: "env" })).output
    );

    expect(defaultEnvironment).toEqual({
      PATH: nodePath,
      HOME: "/home/test",
      TMPDIR: "/tmp/test",
      LANG: "pt_BR.UTF-8",
      MEMORA_MLX_CACHE_LIMIT_MB: "1024"
    });
    expect(configuredEnvironment).toEqual({
      PATH: nodePath,
      LANG: "en_US.UTF-8",
      MEMORA_MLX_CACHE_LIMIT_MB: "512",
      MEMORA_MLX_MEMORY_LIMIT_MB: "8192"
    });
  });

  it("serializes requests and cancels them without running canceled ones", async () => {
    const { helperPath, log } = await createFakeHelper();
    const host = createHost(helperPath);
    await host.health();

    const slow = host.generate({ modelPath: "/m", prompt: "slow" });
    const controller = new AbortController();
    const canceled = host.generate(
      { modelPath: "/m", prompt: "never" },
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 20);
    const startedAt = Date.now();

    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(120);
    await slow;
    await expect(host.generate({ modelPath: "/m", prompt: "after" })).resolves.toBeDefined();

    const commands = (await log()).map((entry) => entry[1]);
    expect(commands).toEqual(["health", "generate", "generate"]);
    await expect(
      host.generate({ modelPath: "/m", prompt: "x" }, { signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("kills the helper when a running request is aborted", async () => {
    const { helperPath } = await createFakeHelper();
    const host = createHost(helperPath);
    await host.health();
    const pid = host.pid!;
    const controller = new AbortController();

    const running = host.generate(
      { modelPath: "/m", prompt: "hang" },
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 30);

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    const next = await host.generate({ modelPath: "/m", prompt: "next" });
    expect(Number(next.output)).not.toBe(pid);
    expect(isAlive(pid)).toBe(false);
  });

  it("reports a helper that cannot start", async () => {
    const host = createHost("/nonexistent/memora-mlx-helper");

    await expect(host.health()).rejects.toMatchObject({
      message: "errors.localModels.runtimeFailed",
      code: "spawn_failed"
    });
    expect(host.pid).toBeUndefined();
  });

  it("disposes the helper, rejects queued requests and starts a new one on the next call", async () => {
    const { helperPath } = await createFakeHelper();
    const host = createHost(helperPath);
    await host.health();
    const pid = host.pid!;

    const running = host.generate({ modelPath: "/m", prompt: "hang" });
    const queued = host.generate({ modelPath: "/m", prompt: "queued" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await host.dispose();

    await expect(running).rejects.toMatchObject({ code: "disposed" });
    await expect(queued).rejects.toMatchObject({ code: "disposed" });
    expect(isAlive(pid)).toBe(false);
    await expect(host.generate({ modelPath: "/m", prompt: "again" })).resolves.toBeDefined();
    expect(host.spawnCount).toBe(2);
  });

  it("asks an idle helper to shut down and sends no signal when it leaves (F4 D23)", async () => {
    const { helperPath, log } = await createFakeHelper();
    const report: LocalDisposeStep[] = [];
    const host = createHost(helperPath, { onDisposeStep: (step) => report.push(step) });
    await host.health();
    const pid = host.pid!;

    await host.dispose();

    expect(report).toMatchObject([
      { step: "mlx helper shutdown", outcome: "done", boundMs: host.config.shutdownGraceMs }
    ]);
    expect(report[0]!.ms).toBeLessThan(host.config.shutdownGraceMs);
    expect((await log()).map(([, command]) => command)).toEqual(["health", "shutdown"]);
    expect(isAlive(pid)).toBe(false);
    expect(host.pid).toBeUndefined();
    // The next request starts a fresh helper.
    await expect(host.generate({ modelPath: "/m", prompt: "again" })).resolves.toBeDefined();
    expect(host.spawnCount).toBe(2);
  });

  it("signals a helper that ignores shutdown after the grace, each step under its bound", async () => {
    const { helperPath, log } = await createFakeHelper({ ignoreShutdown: true });
    const report: LocalDisposeStep[] = [];
    const host = createHost(helperPath, {
      config: { shutdownGraceMs: 150, killGraceMs: 200 },
      onDisposeStep: (step) => report.push(step)
    });
    await host.health();
    const pid = host.pid!;

    await host.dispose();

    expect(report.map((step) => [step.step, step.outcome])).toEqual([
      ["mlx helper shutdown", "timeout"],
      ["mlx helper signals", "done"]
    ]);
    for (const step of report) expect(step.ms).toBeLessThanOrEqual(step.boundMs + 100);
    expect((await log()).map(([, command]) => command)).toContain("shutdown");
    expect(isAlive(pid)).toBe(false);
  });

  it("signals a busy helper at once: no shutdown waits behind its request", async () => {
    const { helperPath, log } = await createFakeHelper();
    const report: LocalDisposeStep[] = [];
    const host = createHost(helperPath, { onDisposeStep: (step) => report.push(step) });
    await host.health();
    const running = host.generate({ modelPath: "/m", prompt: "hang" });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await host.dispose();

    await expect(running).rejects.toMatchObject({ code: "disposed" });
    expect(report.map((step) => [step.step, step.outcome])).toEqual([
      ["mlx helper signals", "done"]
    ]);
    expect((await log()).map(([, command]) => command)).not.toContain("shutdown");
  });

  it("joins a second dispose to the first and reports nothing when no helper runs", async () => {
    const { helperPath, log } = await createFakeHelper();
    const report: LocalDisposeStep[] = [];
    const host = createHost(helperPath, { onDisposeStep: (step) => report.push(step) });
    await host.dispose();
    expect(report).toEqual([]);
    await host.health();
    await Promise.all([host.dispose(), host.dispose()]);
    expect((await log()).filter(([, command]) => command === "shutdown")).toHaveLength(1);
    expect(report).toHaveLength(1);
  });

  it("waits for a helper that is leaving before it starts the next one", async () => {
    const { helperPath } = await createFakeHelper();
    const host = createHost(helperPath);
    await host.health();
    const pid = host.pid!;

    const disposing = host.dispose();
    // A request made while the old helper leaves must not run beside it.
    const next = host.generate({ modelPath: "/m", prompt: "next" });
    await disposing;
    const result = await next;

    expect(isAlive(pid)).toBe(false);
    expect(Number(result.output)).not.toBe(pid);
    expect(host.spawnCount).toBe(2);
  });
});

describe("MlxAdapter with a shared helper host", () => {
  it("runs generation on the shared host and leaves its lifetime to the owner", async () => {
    const { helperPath } = await createFakeHelper();
    const host = createHost(helperPath);
    const adapter = new MlxAdapter({
      modelId: "local-test",
      modelPath: "/model/generate",
      helperPath,
      host,
      capabilities: ["text-generation", "offline"]
    });
    const request = {
      taskType: "text-generation" as const,
      input: "hello",
      requiredCapabilities: ["text-generation" as const],
      parameters: {},
      metadata: {}
    };

    const result = await adapter.run(request);
    await host.embed({ modelPath: "/model/embed", texts: ["a"] });
    await adapter.dispose();

    expect(Number(result.output)).toBe(host.pid);
    expect(host.pid).toBeGreaterThan(0);
    expect(host.spawnCount).toBe(1);
  });

  it("disposes a host it created itself", async () => {
    const { helperPath } = await createFakeHelper();
    const adapter = new MlxAdapter({
      modelId: "local-test",
      modelPath: "/model/generate",
      helperPath,
      runtimeConfig: { cacheLimitMb: 256 },
      capabilities: ["text-generation", "offline"]
    });
    const request = {
      taskType: "text-generation" as const,
      input: "env",
      requiredCapabilities: ["text-generation" as const],
      parameters: {},
      metadata: {}
    };

    const environment = JSON.parse(String((await adapter.run(request)).output));
    expect(environment.MEMORA_MLX_CACHE_LIMIT_MB).toBe("256");
    await adapter.dispose();
    await expect(adapter.run({ ...request, input: "again" })).resolves.toBeDefined();
    await adapter.dispose();
  });
});

/**
 * A stand-in for the T61 helper: it reads stdin while it works, so a `cancel` line reaches the
 * request that runs (F3 D39, R12). `generate` writes a piece every 10 ms (three for most prompts,
 * a thousand for "long" and "stubborn"; "silent" writes one and then nothing) and streams them when
 * asked; `score` runs one batch every 20 ms (a thousand for the query "longscore") and checks for a
 * cancel before each. "stubborn" ignores a cancel. Every line is logged as `<pid> <command>`, and
 * every batch as `<pid> batch`.
 */
async function createCapableHelper(): Promise<{
  helperPath: string;
  log: () => Promise<string[][]>;
}> {
  const root = await mkdtemp(join(tmpdir(), "memora-mlx-host-t61-"));
  roots.push(root);
  const helperPath = join(root, "fake-helper.mjs");
  const logPath = join(root, "requests.log");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const log = (text) => appendFileSync(${JSON.stringify(logPath)}, process.pid + " " + text + "\\n");
const send = (id, body) => process.stdout.write(JSON.stringify({
  protocolVersion: 1, requestId: id.toUpperCase(), ...body }) + "\\n");
const cancelled = { kind: "result", ok: false,
  error: { code: "cancelled", messageKey: "errors.localModels.runtimeFailed", recoverable: true } };
const timing = { loadMs: 0, modelCached: true, tokenizeMs: 0, inferenceMs: 1, perItemMs: 1, totalMs: 1,
  batches: [{ size: 1, sequenceLength: 8, ms: 1 }] };
const running = new Map();
const queue = [];
let busy = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  log(request.command + (request.slot ? ":" + request.slot : ""));
  if (request.command === "cancel") return running.get(request.requestId.toLowerCase())?.();
  queue.push(request);
  pump();
});
function pump() {
  if (busy || queue.length === 0) return;
  busy = true;
  handle(queue.shift(), () => { busy = false; pump(); });
}
function handle(request, done) {
  const id = request.requestId;
  const finish = (body) => { running.delete(id.toLowerCase()); send(id, body); done(); };
  if (request.command === "health")
    return finish({ kind: "result", ok: true, output: "ok", durationMs: 0,
      capabilities: ["cancel", "stream", "unload"] });
  if (request.command === "unload")
    return finish({ kind: "result", ok: true, output: "", durationMs: 0 });
  if (request.command === "generate") {
    const marker = request.prompt;
    const total = marker === "long" || marker === "stubborn" ? 1000 : 3;
    let written = 0;
    let text = "";
    const timer = setInterval(() => {
      if (marker === "silent" && written === 1) return;
      const piece = "w" + written + " ";
      text += piece;
      written += 1;
      if (request.stream) send(id, { kind: "delta", delta: piece });
      if (written < total) return;
      clearInterval(timer);
      finish({ kind: "result", ok: true, output: text, durationMs: 1, inputTokens: 1,
        outputTokens: written });
    }, 10);
    running.set(id.toLowerCase(), () => {
      if (marker === "stubborn") return;
      clearInterval(timer);
      finish(cancelled);
    });
    return;
  }
  if (request.command === "score") {
    const count = (request.documents ?? request.pairs).length;
    const batches = (request.query ?? request.pairs[0].query) === "longscore" ? 1000 : 1;
    let batch = 0;
    let stop = false;
    const timer = setInterval(() => {
      if (stop) {
        clearInterval(timer);
        return finish(cancelled);
      }
      batch += 1;
      log("batch");
      if (batch < batches) return;
      clearInterval(timer);
      finish({ kind: "result", ok: true, durationMs: 1, inputTokens: count,
        scores: Array(count).fill(0.5), logOdds: Array(count).fill(0), yesTokenId: 9693,
        noTokenId: 2152, tokenCounts: Array(count).fill(8), truncated: Array(count).fill(false),
        timing });
    }, 20);
    running.set(id.toLowerCase(), () => { stop = true; });
  }
}
`
  );
  await chmod(helperPath, 0o755);
  return {
    helperPath,
    log: async () => {
      const text = await readFile(logPath, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" "));
    }
  };
}

describe("MlxHelperHost with a helper that can cancel, unload and stream (F3 T61)", () => {
  it("asks a fresh helper for its capabilities once", async () => {
    const { helperPath, log } = await createCapableHelper();
    const host = createHost(helperPath);
    await host.generate({ modelPath: "/m", prompt: "a" });
    await host.generate({ modelPath: "/m", prompt: "b" });

    expect(host.capabilities).toEqual(new Set(["cancel", "stream", "unload"]));
    expect(host.supports("cancel")).toBe(true);
    expect((await log()).map((entry) => entry[1])).toEqual(["health", "generate", "generate"]);
  });

  it("cancels a generation at its deadline and keeps the PID and the loaded model", async () => {
    const { helperPath, log } = await createCapableHelper();
    const host = createHost(helperPath);
    await host.generate({ modelPath: "/m", prompt: "load" });
    const pid = host.pid;
    expect(host.loadedModel("generate")).toBe("/m");

    const startedAt = Date.now();
    await expect(
      host.generate({ modelPath: "/m", prompt: "long" }, { timeoutMs: 100 })
    ).rejects.toMatchObject({ name: "MlxHelperError", code: "timeout" });
    // It stopped on the cancel, well before the 2 s grace would have killed it.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(host.pid).toBe(pid);
    expect(isAlive(pid!)).toBe(true);
    expect(host.loadedModel("generate")).toBe("/m");
    await expect(host.generate({ modelPath: "/m", prompt: "next" })).resolves.toMatchObject({
      output: "w0 w1 w2 "
    });
    expect(host.spawnCount).toBe(1);
    expect((await log()).map((entry) => entry[1])).toContain("cancel");
  });

  it("honours a cancel that arrives while a scoring batch runs, on an abort", async () => {
    const { helperPath, log } = await createCapableHelper();
    const host = createHost(helperPath);
    await host.health();
    const pid = host.pid;
    const controller = new AbortController();
    const scoring = host.score(
      { modelPath: "/r", query: "longscore", documents: ["a", "b"] },
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 100);
    const startedAt = Date.now();

    await expect(scoring).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const batches = (await log()).filter((entry) => entry[1] === "batch").length;
    expect(batches).toBeGreaterThan(0);
    expect(batches).toBeLessThan(50);
    expect(host.pid).toBe(pid);
    await expect(
      host.score({ modelPath: "/r", query: "q", documents: ["d"] })
    ).resolves.toMatchObject({ scores: [0.5] });
  });

  it("kills a helper that has not answered a cancel within the grace period", async () => {
    const { helperPath } = await createCapableHelper();
    const host = createHost(helperPath, { config: { cancelGraceMs: 150 } });
    await host.health();
    const pid = host.pid!;

    const startedAt = Date.now();
    await expect(
      host.generate({ modelPath: "/m", prompt: "stubborn" }, { timeoutMs: 50 })
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
    expect(host.pid).toBeUndefined();
    await host.health();
    expect(host.pid).not.toBe(pid);
    expect(isAlive(pid)).toBe(false);
  });

  it("streams the pieces of a generation and stops one that goes silent", async () => {
    const { helperPath } = await createCapableHelper();
    const host = createHost(helperPath);
    const pieces: string[] = [];
    const result = await host.generate(
      { modelPath: "/m", prompt: "stream", stream: true },
      { onDelta: (piece) => pieces.push(piece), stallMs: 1_000 }
    );
    expect(pieces).toEqual(["w0 ", "w1 ", "w2 "]);
    expect(pieces.join("")).toBe(result.output);
    const pid = host.pid;

    await expect(
      host.generate({ modelPath: "/m", prompt: "silent", stream: true }, { stallMs: 100 })
    ).rejects.toMatchObject({ code: "stalled" });
    expect(host.pid).toBe(pid);
  });

  it("unloads one slot and keeps the process and the other slots", async () => {
    const { helperPath, log } = await createCapableHelper();
    const host = createHost(helperPath);
    expect(await host.unload("generate")).toBe("not_running");
    expect(host.spawnCount).toBe(0);

    await host.generate({ modelPath: "/writer", prompt: "a" });
    await host.score({ modelPath: "/ranker", query: "q", documents: ["d"] });
    const pid = host.pid;
    expect(await host.unload("generate")).toBe("unloaded");

    expect(host.pid).toBe(pid);
    expect(host.loadedModel("generate")).toBeUndefined();
    expect(host.loadedModel("score")).toBe("/ranker");
    expect((await log()).map((entry) => entry[1])).toContain("unload:generate");
  });

  it("serves an older one-request-per-process helper that exits slower than the persistence probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-mlx-host-oneshot-"));
    roots.push(root);
    const helperPath = join(root, "one-shot.mjs");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
import readline from "node:readline";
readline.createInterface({ input: process.stdin }).once("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ protocolVersion: 1, requestId: request.requestId,
    kind: "result", ok: true, output: "legacy", durationMs: 1 }) + "\\n");
  setTimeout(() => process.exit(0), 150);
});
`
    );
    await chmod(helperPath, 0o755);
    const host = createHost(helperPath);

    await expect(host.generate({ modelPath: "/m", prompt: "a" })).resolves.toMatchObject({
      output: "legacy"
    });
    await expect(host.generate({ modelPath: "/m", prompt: "b" })).resolves.toMatchObject({
      output: "legacy"
    });
    // Every answer came from a fresh process: the requests written to a dying one ran again.
    expect(host.spawnCount).toBeGreaterThanOrEqual(3);
  });

  it("says an older helper cannot unload, so only stopping it frees the slot", async () => {
    const { helperPath } = await createFakeHelper();
    const host = createHost(helperPath);
    await host.generate({ modelPath: "/writer", prompt: "a" });

    expect(await host.unload("generate")).toBe("unsupported");
    expect(host.loadedModel("generate")).toBe("/writer");
  });

  it("tells the MLX adapter whether the shared helper holds its model", async () => {
    const { helperPath } = await createCapableHelper();
    const host = createHost(helperPath);
    const adapter = new MlxAdapter({
      modelId: "local-test",
      modelPath: "/writer",
      helperPath,
      host,
      capabilities: ["text-generation", "offline"]
    });
    expect(adapter.isLoaded()).toBe(false);
    await adapter.run({
      taskType: "text-generation",
      input: "hello",
      requiredCapabilities: ["text-generation"],
      parameters: {},
      metadata: {}
    });
    expect(adapter.isLoaded()).toBe(true);
    await host.unload("generate");
    expect(adapter.isLoaded()).toBe(false);
  });
});
