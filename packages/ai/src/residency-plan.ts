import { execFile } from "node:child_process";
import { freemem } from "node:os";
import { promisify } from "node:util";

/**
 * Which local models stay loaded together (F3 D39). The embedder and the ranker are the resident
 * group; the generative model (the local writer) joins them only when its catalog minimum, the
 * group's minimums and the headroom all fit in the machine's memory. When they do not, the writer
 * is still admitted if it fits with the headroom alone, and the ranker leaves while it is loaded
 * (the two then never stay loaded together: loading either unloads the other). A writer that does
 * not fit even alone is refused (`blocked: memory`), never swapped.
 */
export interface ResidencyPlanInput {
  totalMemoryBytes: number;
  /** Catalog minimums of the resident group; 0 (or absent) for a slot that holds no model. */
  resident: { embed?: number; rank?: number };
  /** Catalog minimum of the generative model. */
  generative: number;
  headroomBytes: number;
}

export interface ResidencyPlan {
  /** The generative model may load on this machine. */
  allowed: boolean;
  /** The ranker stays loaded while the generative model is (false: the ranker leaves for it). */
  keepRankDuringGeneration: boolean;
}

export function residencyPlan(input: ResidencyPlanInput): ResidencyPlan {
  const group = (input.resident.embed ?? 0) + (input.resident.rank ?? 0);
  const allowed = input.generative + input.headroomBytes <= input.totalMemoryBytes;
  return {
    allowed,
    keepRankDuringGeneration:
      allowed && input.generative + group + input.headroomBytes <= input.totalMemoryBytes
  };
}

/**
 * A local generative model refused for lack of memory (F3 D39): the residency plan does not admit
 * it on this machine (`plan`), or free plus inactive memory is below its catalog minimum plus the
 * load margin right now (`free`). Visible like every local-model error; it is never swapped.
 */
export class LocalMemoryBlockedError extends Error {
  public readonly code = "blocked_memory";

  public constructor(
    public readonly reason: "plan" | "free",
    public readonly requiredBytes: number,
    public readonly availableBytes: number
  ) {
    super("errors.localModels.insufficient_memory");
    this.name = "LocalMemoryBlockedError";
  }
}

/** Whether a model may load now: available memory covers its minimum plus the margin. */
export function memoryGuard(input: {
  availableBytes: number;
  minimumBytes: number;
  marginBytes: number;
}): { allowed: boolean; requiredBytes: number } {
  const requiredBytes = input.minimumBytes + input.marginBytes;
  return { allowed: input.availableBytes >= requiredBytes, requiredBytes };
}

/**
 * Free plus inactive (and speculative) memory from `vm_stat` output: what macOS can hand to a new
 * allocation without swapping. Null when the output has no page size or no free count.
 */
export function parseVmStat(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/u.exec(output)?.[1];
  if (!pageSize) return null;
  const pages = (label: string): number | null => {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "mu").exec(output);
    return match ? Number(match[1]) : null;
  };
  const free = pages("Pages free");
  if (free === null) return null;
  const inactive = pages("Pages inactive") ?? 0;
  const speculative = pages("Pages speculative") ?? 0;
  return (free + inactive + speculative) * Number(pageSize);
}

const execFileAsync = promisify(execFile);

/**
 * Memory a new model can use now. On macOS `os.freemem()` counts only free pages, which the file
 * cache keeps low, so the guard reads `vm_stat`; elsewhere (and if `vm_stat` fails) it is
 * `os.freemem()`, which on Linux is the kernel's available estimate.
 */
export async function availableMemoryBytes(platform: NodeJS.Platform = process.platform) {
  if (platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("/usr/bin/vm_stat", [], { timeout: 2_000 });
      const parsed = parseVmStat(stdout);
      if (parsed !== null) return parsed;
    } catch {
      // Fall back to the free count below.
    }
  }
  return freemem();
}
