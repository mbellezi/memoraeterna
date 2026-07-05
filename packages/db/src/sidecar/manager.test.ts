import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PostgresSidecarManager } from "./manager.js";
import type { SidecarCommandRunner, SidecarExecOptions, SidecarExecResult } from "./types.js";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  pid = 42;

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }
}

class FakeRunner implements SidecarCommandRunner {
  readonly calls: Array<{ file: string; args: readonly string[]; options?: SidecarExecOptions }> = [];
  readonly spawned: Array<{ file: string; args: readonly string[] }> = [];
  readonly failSpawnPorts = new Set<number>();

  async execFile(file: string, args: readonly string[], options?: SidecarExecOptions): Promise<SidecarExecResult> {
    this.calls.push({ file, args, options });
    if (file.endsWith("initdb")) {
      const dataDir = args[args.indexOf("-D") + 1];
      await writeFile(join(String(dataDir), "PG_VERSION"), "18\n");
    }
    return { stdout: "", stderr: "" };
  }

  spawn(file: string, args: readonly string[], _options?: SidecarExecOptions): ChildProcess {
    this.spawned.push({ file, args });
    const port = readPortArg(args);
    if (port !== null && this.failSpawnPorts.delete(port)) {
      throw new Error(`Port ${port} failed`);
    }
    return new FakeChild() as unknown as ChildProcess;
  }
}

interface FakeLogger {
  readonly warnings: string[];
  readonly logger: Pick<Console, "debug" | "info" | "warn" | "error">;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("PostgresSidecarManager", () => {
  it("initializes, starts, stops, and writes a non-trust TCP hba", async () => {
    const { binDir, dataDir } = await createSidecarDirs();
    const runner = new FakeRunner();
    const manager = new PostgresSidecarManager({
      binDir,
      dataDir,
      database: "memora",
      user: "memora",
      password: "secret",
      port: 55432,
      runner,
      ...createFakePortTools()
    });

    const connection = await manager.start();
    await manager.stop();

    expect(connection.connectionString).toBe("postgresql://memora:secret@127.0.0.1:55432/memora");
    expect(runner.spawned[0]?.args).toContain("port=55432");
    const initdbCall = runner.calls.find((call) => call.file.endsWith("initdb"));
    const passwordFileArg = initdbCall?.args.find((arg) => arg.startsWith("--pwfile="));
    expect(passwordFileArg).toBeDefined();
    expect(passwordFileArg?.replace("--pwfile=", "").startsWith(`${dataDir}/`)).toBe(false);
    expect(runner.calls.some((call) => call.file.endsWith("createdb"))).toBe(true);
    const createdbCall = runner.calls.find((call) => call.file.endsWith("createdb"));
    expect(createdbCall?.args).toContain("--maintenance-db=postgres");
    expect(createdbCall?.options?.timeoutMs).toBe(10_000);
    expect(createdbCall?.options?.env?.PGCONNECT_TIMEOUT).toBe("5");
    expect(runner.calls.some((call) => call.file.endsWith("pg_ctl") && call.args.includes("stop"))).toBe(true);

    const hba = await readFile(join(dataDir, "pg_hba.conf"), "utf8");
    expect(hba).toContain("scram-sha-256");
    expect(hba).not.toMatch(/\btrust\b/u);
  });

  it("removes a stale postmaster.pid before start", async () => {
    const { binDir, dataDir } = await createSidecarDirs();
    await writeFile(join(dataDir, "PG_VERSION"), "18\n");
    await writeFile(join(dataDir, "postmaster.pid"), "2147483647\n");
    const runner = new FakeRunner();
    const manager = new PostgresSidecarManager({
      binDir,
      dataDir,
      database: "memora",
      user: "memora",
      password: "secret",
      port: 55433,
      runner,
      ...createFakePortTools()
    });

    await manager.start();

    const pidRead = readFile(join(dataDir, "postmaster.pid"), "utf8");
    await expect(pidRead).rejects.toThrow();
  });

  it("falls back to a dynamic port when the configured port fails", async () => {
    const { binDir, dataDir } = await createSidecarDirs();
    const runner = new FakeRunner();
    runner.failSpawnPorts.add(55432);
    const { logger, warnings } = createFakeLogger();
    const manager = new PostgresSidecarManager({
      binDir,
      dataDir,
      database: "memora",
      user: "memora",
      password: "secret",
      port: 55432,
      runner,
      logger,
      ...createFakePortTools()
    });

    const connection = await manager.start();

    expect(runner.spawned).toHaveLength(2);
    expect(runner.spawned[0]?.args).toContain("port=55432");
    expect(runner.spawned[1]?.args).not.toContain("port=55432");
    expect(connection.port).not.toBe(55432);
    expect(warnings.some((warning) => warning.includes("falling back to a dynamic port"))).toBe(true);
  });

  it("falls back to a dynamic port when the configured port is unavailable", async () => {
    const { binDir, dataDir } = await createSidecarDirs();
    const runner = new FakeRunner();
    const { logger, warnings } = createFakeLogger();
    const manager = new PostgresSidecarManager({
      binDir,
      dataDir,
      database: "memora",
      user: "memora",
      password: "secret",
      port: 55432,
      runner,
      logger,
      dynamicPortResolver: async () => 55434,
      portAvailabilityChecker: async () => false
    });

    const connection = await manager.start();

    expect(runner.spawned).toHaveLength(1);
    expect(runner.spawned[0]?.args).toContain("port=55434");
    expect(connection.port).toBe(55434);
    expect(warnings.some((warning) => warning.includes("configured port 55432 is unavailable"))).toBe(true);
  });
});

function readPortArg(args: readonly string[]): number | null {
  const portArg = args.find((arg) => arg.startsWith("port="));
  if (!portArg) {
    return null;
  }

  const port = Number(portArg.replace("port=", ""));
  return Number.isInteger(port) ? port : null;
}

function createFakeLogger(): FakeLogger {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message?: unknown) => {
        warnings.push(String(message));
      },
      error: () => undefined
    }
  };
}

function createFakePortTools(): {
  readonly dynamicPortResolver: () => Promise<number>;
  readonly portAvailabilityChecker: () => Promise<boolean>;
} {
  return {
    dynamicPortResolver: async () => 55434,
    portAvailabilityChecker: async () => true
  };
}

async function createSidecarDirs(): Promise<{ binDir: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "memora-sidecar-test-"));
  const binDir = join(root, "bin");
  const dataDir = join(root, "data");
  await Promise.all([mkdir(binDir), mkdir(dataDir)]);
  await Promise.all(["initdb", "postgres", "pg_ctl", "pg_isready", "createdb"].map((binary) => touchExecutable(join(binDir, binary))));
  tempDirs.push(root);
  return { binDir, dataDir };
}

async function touchExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, 0o755);
}
