import { execFile } from "node:child_process";
import { win32 } from "node:path";

/**
 * The commands of the hardware probe (F4 D32, T97; spike 6.1). Every command is an absolute path with
 * fixed arguments, run without a shell, with a timeout and an output cap; nothing here takes input
 * from the renderer, a file or the network, and WMIC (removed from current Windows 11) is not used.
 */
export interface HardwareCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/** Runs a command; null when it did not answer (missing, timed out, output over the cap, no output). */
export type CommandRunner = (command: HardwareCommand) => Promise<string | null>;

export const commandTimeoutMs = 5_000;
export const commandMaxOutputBytes = 1_000_000;

/** What the Mac probe reads from the kernel. A key the machine lacks is absent from the answer. */
export const sysctlKeys = [
  "machdep.cpu.brand_string",
  "hw.memsize",
  "hw.optional.arm64",
  "sysctl.proc_translated",
  "iogpu.wired_limit_mb",
  "hw.logicalcpu",
  "hw.physicalcpu"
] as const;

export const macCommands = {
  sysctl: { file: "/usr/sbin/sysctl", args: sysctlKeys },
  /**
   * Only the graphics section: `SPHardwareDataType` carries the serial number, the platform UUID and
   * the provisioning UDID, and the displays carry their serial numbers; the parser reads six fields.
   */
  displays: { file: "/usr/sbin/system_profiler", args: ["SPDisplaysDataType", "-json"] }
} as const satisfies Record<string, HardwareCommand>;

/**
 * The Windows probe: one PowerShell script over CIM, printing one JSON object. The video memory
 * comes from the display class registry key (a 64-bit `qwMemorySize`), never from `AdapterRAM`
 * (a uint32 that stops at 4 GB). The NPU is the `ComputeAccelerator` device class, informational.
 * Fixed text; the tests run it only as fixtures (the probe is untested on Windows hardware).
 */
export const windowsProbeScript = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors",
  "$gpus = @(Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion)",
  "$npus = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPClass -eq 'ComputeAccelerator' } | Select-Object Name)",
  "$classKey = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11cf-be10-806006318003}\\0*'",
  "$vram = @(Get-ItemProperty $classKey | Where-Object { $_.'HardwareInformation.qwMemorySize' } |",
  "  ForEach-Object { [pscustomobject]@{ Name = $_.DriverDesc; Bytes = [uint64]$_.'HardwareInformation.qwMemorySize' } })",
  "[pscustomobject]@{ cpu = $cpu; gpus = $gpus; npus = $npus; vram = $vram } | ConvertTo-Json -Depth 4 -Compress"
].join("\n");

/** Windows PowerShell 5.1 by absolute path; `-EncodedCommand` needs no quoting of the script. */
export function windowsCommand(env: Readonly<Record<string, string | undefined>>): HardwareCommand {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return {
    file: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-NoLogo",
      "-EncodedCommand",
      Buffer.from(windowsProbeScript, "utf16le").toString("base64")
    ]
  };
}

type ExecFile = (
  file: string,
  args: readonly string[],
  options: {
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
    encoding: "utf8";
  },
  callback: (error: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string) => void
) => unknown;

/**
 * The real runner. A command that exits non-zero but printed (sysctl lists the keys it knows and
 * fails on the one it does not) still answers; a timeout, an output over the cap or a missing binary
 * does not. Never throws.
 */
export function createCommandRunner(
  run: ExecFile = execFile as unknown as ExecFile
): CommandRunner {
  return (command) =>
    new Promise((resolve) => {
      try {
        run(
          command.file,
          command.args,
          {
            timeout: commandTimeoutMs,
            maxBuffer: commandMaxOutputBytes,
            windowsHide: true,
            encoding: "utf8"
          },
          (error, stdout) => {
            const exited = error !== null && typeof error.code === "number";
            if (error && (!exited || error.killed === true)) return resolve(null);
            resolve(typeof stdout === "string" && stdout.trim().length > 0 ? stdout : null);
          }
        );
      } catch {
        resolve(null);
      }
    });
}
