import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCommandRunner, type CommandRunner } from "./commands.js";
import { HardwareService } from "./hardware-service.js";

/**
 * Proof of the hardware probe on this machine (F4 T97):
 * `npx tsx apps/desktop/src/main/services/hardware/verify-hardware.ts`.
 *
 * Runs the real probe commands (read-only: sysctl and system_profiler, or PowerShell CIM) against a
 * temporary userData, prints the profile and the setup recommended for it, then starts a second
 * service on the same folder and checks that the cache answers it without running a command. It
 * starts no app, loads no model and calls no provider. Exit code 1 when a check fails.
 */
async function main(): Promise<void> {
  const userData = await mkdtemp(join(tmpdir(), "memora-hardware-proof-"));
  try {
    const real = createCommandRunner();
    let commands = 0;
    const counted: CommandRunner = (command) => {
      commands += 1;
      return real(command);
    };
    const started = performance.now();
    const first = await new HardwareService({ userDataPath: userData, run: counted }).profile();
    const probeMs = Math.round(performance.now() - started);
    const probeCommands = commands;

    commands = 0;
    const restarted = performance.now();
    const second = await new HardwareService({ userDataPath: userData, run: counted }).profile();
    const cachedMs = Math.round(performance.now() - restarted);

    console.log(JSON.stringify(first, null, 2));
    const checks: Array<[string, boolean]> = [
      ["the probe is complete", first.profile.complete],
      [`the first probe ran ${probeCommands} command(s) in ${probeMs} ms`, probeCommands > 0],
      [`the next start ran ${commands} command(s) in ${cachedMs} ms`, commands === 0],
      [
        "the cached profile equals the probed one",
        JSON.stringify(second.profile) === JSON.stringify(first.profile)
      ],
      ["the free disk space was read", (first.freeDiskBytes ?? 0) > 0]
    ];
    for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
}

void main();
