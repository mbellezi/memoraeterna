import { describe, expect, it, vi } from "vitest";

import {
  commandMaxOutputBytes,
  commandTimeoutMs,
  createCommandRunner,
  macCommands,
  sysctlKeys,
  windowsCommand,
  windowsProbeScript
} from "./commands.js";

describe("the hardware probe's commands (F4 D32)", () => {
  it("run absolute binaries with fixed arguments", () => {
    expect(macCommands.sysctl.file).toBe("/usr/sbin/sysctl");
    expect(macCommands.displays.file).toBe("/usr/sbin/system_profiler");
    expect(macCommands.displays.args).toEqual(["SPDisplaysDataType", "-json"]);
    expect(windowsCommand({}).file).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
    expect(windowsCommand({ SystemRoot: "D:\\Windows" }).file).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
  });

  it("read only the kernel keys of the allowlist, never the hardware overview", () => {
    expect([...sysctlKeys]).toEqual([
      "machdep.cpu.brand_string",
      "hw.memsize",
      "hw.optional.arm64",
      "sysctl.proc_translated",
      "iogpu.wired_limit_mb",
      "hw.logicalcpu",
      "hw.physicalcpu"
    ]);
    // SPHardwareDataType prints the serial number, the platform UUID and the provisioning UDID.
    const everything = JSON.stringify([macCommands, windowsCommand({}).args, windowsProbeScript]);
    expect(everything).not.toMatch(/SPHardwareDataType|serial|uuid|udid|hostname|kern\.uuid/iu);
  });

  it("run the Windows probe as an encoded PowerShell script, without WMIC", () => {
    const { args } = windowsCommand({});
    expect(args.slice(0, 4)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-NoLogo",
      "-EncodedCommand"
    ]);
    expect(Buffer.from(args[4]!, "base64").toString("utf16le")).toBe(windowsProbeScript);
    expect(windowsProbeScript).not.toMatch(/wmic/iu);
    expect(windowsProbeScript).toContain("Get-CimInstance Win32_Processor");
    expect(windowsProbeScript).toContain("ComputeAccelerator");
    // The video memory is the 64-bit registry value, not the uint32 AdapterRAM that stops at 4 GB.
    expect(windowsProbeScript).toContain("HardwareInformation.qwMemorySize");
    expect(windowsProbeScript).toContain("ConvertTo-Json");
  });
});

describe("the command runner", () => {
  const command = { file: "/usr/sbin/sysctl", args: ["hw.memsize"] };
  type Callback = (
    error: (Error & { code?: unknown; killed?: boolean }) | null,
    out: string
  ) => void;
  const runWith = (behave: (callback: Callback) => void) => {
    const exec = vi.fn(
      (_file: string, _args: readonly string[], _options: unknown, callback: Callback) =>
        behave(callback)
    );
    return { exec, run: createCommandRunner(exec as never) };
  };
  const failure = (code: unknown, killed = false) =>
    Object.assign(new Error("failed"), { code, killed });

  it("answers the output, under a timeout, an output cap and no console window", async () => {
    const { exec, run } = runWith((callback) => callback(null, "hw.memsize: 1\n"));
    await expect(run(command)).resolves.toBe("hw.memsize: 1\n");
    expect(exec).toHaveBeenCalledWith(
      command.file,
      command.args,
      {
        timeout: commandTimeoutMs,
        maxBuffer: commandMaxOutputBytes,
        windowsHide: true,
        encoding: "utf8"
      },
      expect.any(Function)
    );
    expect(commandTimeoutMs).toBe(5_000);
    expect(commandMaxOutputBytes).toBe(1_000_000);
  });

  it("keeps the output of a command that exited non-zero (sysctl with an unknown key)", async () => {
    const { run } = runWith((callback) => callback(failure(1), "hw.memsize: 1\n"));
    await expect(run(command)).resolves.toBe("hw.memsize: 1\n");
  });

  it("does not answer for a missing binary, a timeout, an output over the cap or no output", async () => {
    for (const behave of [
      (callback: Callback) => callback(failure("ENOENT"), ""),
      (callback: Callback) => callback(failure(null, true), "partial"),
      (callback: Callback) => callback(failure(1, true), "partial"),
      (callback: Callback) =>
        callback(failure("ERR_CHILD_PROCESS_STDIO_MAXBUFFER"), "x".repeat(10)),
      (callback: Callback) => callback(null, "   \n")
    ])
      await expect(runWith(behave).run(command)).resolves.toBeNull();
  });

  it("never throws", async () => {
    const run = createCommandRunner((() => {
      throw new Error("spawn failed");
    }) as never);
    await expect(run(command)).resolves.toBeNull();
  });
});
