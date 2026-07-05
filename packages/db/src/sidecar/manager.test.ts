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
  readonly calls: Array<{ file: string; args: readonly string[] }> = [];
  readonly spawned: Array<{ file: string; args: readonly string[] }> = [];

  async execFile(file: string, args: readonly string[], _options?: SidecarExecOptions): Promise<SidecarExecResult> {
    this.calls.push({ file, args });
    if (file.endsWith("initdb")) {
      const dataDir = args[args.indexOf("-D") + 1];
      await writeFile(join(String(dataDir), "PG_VERSION"), "18\n");
    }
    return { stdout: "", stderr: "" };
  }

  spawn(file: string, args: readonly string[], _options?: SidecarExecOptions): ChildProcess {
    this.spawned.push({ file, args });
    return new FakeChild() as unknown as ChildProcess;
  }
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
      runner
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
      runner
    });

    await manager.start();

    const pidRead = readFile(join(dataDir, "postmaster.pid"), "utf8");
    await expect(pidRead).rejects.toThrow();
  });
});

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
