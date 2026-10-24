import {
  HardwareProfileSchema,
  estimateAppleWorkingSetBytes,
  type HardwareArchitecture,
  type HardwarePlatform,
  type HardwareProfile
} from "@app/domain";

import { macCommands, windowsCommand, type CommandRunner } from "./commands.js";
import {
  parseMacDisplays,
  parseSysctl,
  parseWindowsProbe,
  publicLabel,
  type GpuFacts
} from "./parsers.js";

/** What Node already knows without a command, and the means to run the others. */
export interface ProbeInput {
  platform: string;
  processArch: string;
  osRelease: string;
  totalMemoryBytes: number;
  cpuModel: string | null;
  logicalCores: number | null;
  env: Readonly<Record<string, string | undefined>>;
  run: CommandRunner;
  now: Date;
}

const mebibyte = 1024 ** 2;

export function platformOf(platform: string): HardwarePlatform {
  return platform === "darwin" || platform === "win32" || platform === "linux" ? platform : "other";
}

export function architectureOf(arch: string): HardwareArchitecture {
  return arch === "arm64" || arch === "x64" ? arch : "other";
}

const unknownGpu: GpuFacts = { kind: "unknown", name: null, cores: null, vramBytes: null };

/** The Apple working set: the explicit wired limit when one is set, else the default share of memory. */
function appleWorkingSet(memoryBytes: number, wiredLimitMb: number | null) {
  return wiredLimitMb && wiredLimitMb > 0
    ? { bytes: Math.min(wiredLimitMb * mebibyte, memoryBytes), source: "wired_limit" as const }
    : { bytes: estimateAppleWorkingSetBytes(memoryBytes), source: "estimated" as const };
}

/**
 * Probes this machine (F4 D32): platform, architecture and Rosetta, CPU, memory, GPU, Apple GPU cores
 * and working set, NPU. A command that does not answer leaves its facts to the Node figures and marks
 * the profile incomplete (it is then never cached). Always yields a valid profile; never throws.
 */
export async function probeHardware(input: ProbeInput): Promise<HardwareProfile> {
  try {
    return await probeCommands(input);
  } catch {
    return nodeOnlyProfile(input);
  }
}

/** The Node figures alone, for a probe that failed whole. */
function nodeOnlyProfile(input: ProbeInput): HardwareProfile {
  const processArch = architectureOf(input.processArch);
  return HardwareProfileSchema.parse({
    version: 1,
    platform: platformOf(input.platform),
    processArch,
    nativeArch: processArch,
    translated: false,
    osRelease: input.osRelease.slice(0, 60) || "unknown",
    cpu: { brand: publicLabel(input.cpuModel), physicalCores: null, logicalCores: null },
    memoryBytes: Math.max(1, Math.round(input.totalMemoryBytes)),
    gpu: unknownGpu,
    workingSet: null,
    npu: { present: false, name: null },
    complete: false,
    probedAt: input.now.toISOString()
  });
}

async function probeCommands(input: ProbeInput): Promise<HardwareProfile> {
  const platform = platformOf(input.platform);
  const processArch = architectureOf(input.processArch);
  const base = {
    version: 1 as const,
    platform,
    processArch,
    osRelease: input.osRelease.slice(0, 60) || "unknown",
    probedAt: input.now.toISOString()
  };
  const nodeCpu = {
    brand: publicLabel(input.cpuModel),
    physicalCores: null,
    logicalCores: input.logicalCores && input.logicalCores > 0 ? input.logicalCores : null
  };

  if (platform === "darwin") {
    const [sysctlText, displaysText] = await Promise.all([
      input.run(macCommands.sysctl),
      input.run(macCommands.displays)
    ]);
    const sysctl = sysctlText ? parseSysctl(sysctlText) : null;
    const display = displaysText ? parseMacDisplays(displaysText) : null;
    // Apple silicon hardware even when this app is the translated x64 build.
    const appleSilicon = sysctl?.arm64Hardware ?? processArch === "arm64";
    const memoryBytes = sysctl?.memoryBytes ?? input.totalMemoryBytes;
    const gpu = display ?? (appleSilicon ? { ...unknownGpu, kind: "apple" as const } : unknownGpu);
    return HardwareProfileSchema.parse({
      ...base,
      nativeArch: appleSilicon ? "arm64" : processArch,
      translated: sysctl?.translated === true,
      cpu: {
        brand: sysctl?.cpuBrand ?? nodeCpu.brand,
        physicalCores: sysctl?.physicalCores ?? null,
        logicalCores: sysctl?.logicalCores ?? nodeCpu.logicalCores
      },
      memoryBytes,
      gpu,
      workingSet: appleSilicon ? appleWorkingSet(memoryBytes, sysctl?.wiredLimitMb ?? null) : null,
      npu: appleSilicon
        ? { present: true, name: "Apple Neural Engine" }
        : { present: false, name: null },
      complete: sysctl !== null && display !== null
    });
  }

  if (platform === "win32") {
    const text = await input.run(windowsCommand(input.env));
    const facts = text ? parseWindowsProbe(text) : null;
    // A 32-bit or emulated process reports the machine's architecture in PROCESSOR_ARCHITEW6432.
    const native = input.env.PROCESSOR_ARCHITEW6432?.toUpperCase();
    const nativeArch = native === "ARM64" ? "arm64" : native === "AMD64" ? "x64" : processArch;
    return HardwareProfileSchema.parse({
      ...base,
      nativeArch,
      translated: nativeArch === "arm64" && processArch !== "arm64",
      cpu: facts?.cpu ?? nodeCpu,
      memoryBytes: input.totalMemoryBytes,
      gpu: facts?.gpu ?? unknownGpu,
      workingSet: null,
      npu: facts?.npu ?? { present: false, name: null },
      complete: facts !== null
    });
  }

  return HardwareProfileSchema.parse({
    ...base,
    nativeArch: processArch,
    translated: false,
    cpu: nodeCpu,
    memoryBytes: input.totalMemoryBytes,
    gpu: unknownGpu,
    workingSet: null,
    npu: { present: false, name: null },
    complete: true
  });
}
