import { isPublicDeviceLabel, type GpuKind } from "@app/domain";
import { z } from "zod";

/**
 * Parsers of the probe's command output (F4 D32, T97). Pure; each reads an allowlist of fields and
 * drops everything else in the same function (spike 6.4): a serial number, a UUID or a hostname that
 * a command prints never reaches a value this module returns. A text that does not parse answers
 * null, never throws.
 */

const mebibyte = 1024 ** 2;
const gibibyte = 1024 ** 3;

/** A product or chip name that may enter the profile, or null. */
export function publicLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim().slice(0, 120);
  return text.length > 0 && isPublicDeviceLabel(text) ? text : null;
}

export interface GpuFacts {
  kind: GpuKind;
  name: string | null;
  /** Apple GPU cores. */
  cores: number | null;
  /** Dedicated video memory; null for unified and shared memory. */
  vramBytes: number | null;
}

export interface SysctlFacts {
  cpuBrand: string | null;
  memoryBytes: number | null;
  /** Apple silicon hardware (`hw.optional.arm64`), also true for an app translated by Rosetta. */
  arm64Hardware: boolean | null;
  /** This process is translated (`sysctl.proc_translated`). */
  translated: boolean | null;
  /** The explicit GPU wired limit in MiB; 0 means the system default. */
  wiredLimitMb: number | null;
  logicalCores: number | null;
  physicalCores: number | null;
}

/** `sysctl key ...`: `key: value` lines. */
export function parseSysctl(text: string): SysctlFacts {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([a-z][a-z0-9_.]*): (.*)$/u.exec(line);
    if (match) values.set(match[1]!, match[2]!.trim());
  }
  const integer = (key: string): number | null => {
    const value = values.get(key);
    return value !== undefined && /^\d{1,16}$/u.test(value) ? Number(value) : null;
  };
  const flag = (key: string): boolean | null => {
    const value = integer(key);
    return value === null ? null : value === 1;
  };
  const positive = (key: string): number | null => {
    const value = integer(key);
    return value !== null && value > 0 ? value : null;
  };
  return {
    cpuBrand: publicLabel(values.get("machdep.cpu.brand_string")),
    memoryBytes: positive("hw.memsize"),
    arm64Hardware: flag("hw.optional.arm64"),
    translated: flag("sysctl.proc_translated"),
    wiredLimitMb: integer("iogpu.wired_limit_mb"),
    logicalCores: positive("hw.logicalcpu"),
    physicalCores: positive("hw.physicalcpu")
  };
}

const MacDisplaysSchema = z.object({
  SPDisplaysDataType: z.array(z.record(z.string(), z.unknown()))
});

/** "8 GB", "1536 MB": system_profiler's video memory text. */
function videoMemoryBytes(text: string | null): number | null {
  const match = text ? /^(\d+(?:\.\d+)?) ?(MB|GB|TB)$/u.exec(text.trim()) : null;
  if (!match) return null;
  const unit = { MB: mebibyte, GB: gibibyte, TB: 1024 * gibibyte }[match[2] as "MB" | "GB" | "TB"];
  return Math.round(Number(match[1]) * unit);
}

function macGpu(entry: Record<string, unknown>): GpuFacts | null {
  const text = (key: string): string | null =>
    typeof entry[key] === "string" ? (entry[key] as string) : null;
  const name = publicLabel(text("sppci_model") ?? text("_name"));
  if (!name && text("sppci_device_type") !== "spdisplays_gpu") return null;
  const dedicated = videoMemoryBytes(text("spdisplays_vram"));
  const cores = Number(text("sppci_cores"));
  const kind: GpuKind = /apple/iu.test(text("spdisplays_vendor") ?? "")
    ? "apple"
    : dedicated !== null || text("sppci_bus") === "spdisplays_pcie_device"
      ? "discrete"
      : "integrated";
  return {
    kind,
    name,
    cores: kind === "apple" && Number.isInteger(cores) && cores > 0 ? cores : null,
    vramBytes: kind === "discrete" ? dedicated : null
  };
}

const gpuPreference: Record<GpuKind, number> = {
  discrete: 3,
  apple: 2,
  integrated: 1,
  unknown: 0,
  none: 0
};

/** `system_profiler SPDisplaysDataType -json`: the best GPU; the displays (serial numbers) are never read. */
export function parseMacDisplays(text: string): GpuFacts | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = MacDisplaysSchema.safeParse(json);
  if (!parsed.success) return null;
  const gpus = parsed.data.SPDisplaysDataType.map(macGpu).filter(
    (gpu): gpu is GpuFacts => gpu !== null
  );
  if (gpus.length === 0) return { kind: "none", name: null, cores: null, vramBytes: null };
  return gpus.reduce((best, gpu) =>
    gpuPreference[gpu.kind] > gpuPreference[best.kind] ||
    (gpu.kind === best.kind && (gpu.vramBytes ?? 0) > (best.vramBytes ?? 0))
      ? gpu
      : best
  );
}

const many = <T extends z.ZodType>(schema: T) =>
  z
    .union([z.array(schema), schema])
    .transform((value): Array<z.infer<T>> => (Array.isArray(value) ? value : [value]));

// PowerShell's ConvertTo-Json unrolls a one-element array; extra keys are stripped.
const WindowsProbeSchema = z.object({
  cpu: many(
    z.object({
      Name: z.string().nullish(),
      NumberOfCores: z.number().int().nullish(),
      NumberOfLogicalProcessors: z.number().int().nullish()
    })
  ).nullish(),
  gpus: many(z.object({ Name: z.string().nullish() })).nullish(),
  npus: many(z.object({ Name: z.string().nullish() })).nullish(),
  vram: many(z.object({ Name: z.string().nullish(), Bytes: z.number().nullish() })).nullish()
});

export interface WindowsFacts {
  cpu: { brand: string | null; physicalCores: number | null; logicalCores: number | null };
  gpu: GpuFacts;
  npu: { present: boolean; name: string | null };
}

// A virtual or remote adapter is no GPU of this machine.
const virtualAdapter =
  /basic display|remote display|virtual|hyper-v|vmware|parsec|citrix|mirage|indirect display/iu;
const integratedGpu =
  /uhd|iris|adreno|intel\(r\) (?:hd )?graphics|arc\(tm\) graphics|radeon(?:\(tm\))? (?:graphics|\d{3}m)/iu;
const discreteGpu =
  /nvidia|geforce|quadro|\brtx\b|\bgtx\b|radeon (?:rx|pro|vii)|\barc(?:\(tm\))? [ab]\d{3}/iu;
/** A registry video memory of at least this size marks a GPU of unknown name as discrete. */
const discreteMinimumBytes = 2 * gibibyte;

function windowsGpu(
  gpus: ReadonlyArray<{ Name?: string | null | undefined }>,
  vram: ReadonlyArray<{ Name?: string | null | undefined; Bytes?: number | null | undefined }>
): GpuFacts {
  const found = gpus
    .map((gpu) => ({ name: publicLabel(gpu.Name), raw: gpu.Name ?? "" }))
    .filter((gpu) => gpu.name !== null && !virtualAdapter.test(gpu.raw))
    .map((gpu): GpuFacts => {
      const bytes = vram.find(
        (candidate) => candidate.Name?.toLowerCase() === gpu.raw.toLowerCase()
      )?.Bytes;
      const dedicated = typeof bytes === "number" && bytes > 0 ? Math.round(bytes) : null;
      const kind: GpuKind = integratedGpu.test(gpu.raw)
        ? "integrated"
        : discreteGpu.test(gpu.raw) || (dedicated ?? 0) >= discreteMinimumBytes
          ? "discrete"
          : "unknown";
      return {
        kind,
        name: gpu.name,
        cores: null,
        vramBytes: kind === "discrete" ? dedicated : null
      };
    });
  if (found.length === 0) return { kind: "none", name: null, cores: null, vramBytes: null };
  return found.reduce((best, gpu) =>
    gpuPreference[gpu.kind] > gpuPreference[best.kind] ||
    (gpu.kind === best.kind && (gpu.vramBytes ?? 0) > (best.vramBytes ?? 0))
      ? gpu
      : best
  );
}

/** The output of `windowsProbeScript`; null when it is not that JSON (a PowerShell error text). */
export function parseWindowsProbe(text: string): WindowsFacts | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = WindowsProbeSchema.safeParse(json);
  if (!parsed.success) return null;
  const { cpu, gpus, npus, vram } = parsed.data;
  if (!cpu?.[0] && !gpus?.length) return null;
  const processor = cpu?.[0];
  const npu = publicLabel(npus?.[0]?.Name);
  return {
    cpu: {
      brand: publicLabel(processor?.Name),
      physicalCores:
        processor?.NumberOfCores && processor.NumberOfCores > 0 ? processor.NumberOfCores : null,
      logicalCores:
        processor?.NumberOfLogicalProcessors && processor.NumberOfLogicalProcessors > 0
          ? processor.NumberOfLogicalProcessors
          : null
    },
    gpu: windowsGpu(gpus ?? [], vram ?? []),
    npu: { present: (npus?.length ?? 0) > 0, name: npu }
  };
}
