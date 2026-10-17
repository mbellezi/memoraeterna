import { isLocalEndpoint } from "../remote-execution.js";
import type { AiLaneRuntimeConfig } from "../runtime-config.js";
import { initialAimd, type AimdState } from "./aimd.js";
import type { RankedEntry } from "./priority.js";
import type { AiPriority, LaneKey, RemoteLaneKind } from "./types.js";

/** Where a routed model executes; the lane follows from it at admission. */
export interface ExecutionTarget {
  /** Set for a local model (MLX, node-llama-cpp). */
  localModelId: string | null;
  providerConfigId: string | null;
  provider: string;
  baseUrl: string | null;
}

/** The base URL an OpenAI-compatible configuration without one is served from (Ollama). */
const defaultOpenAiCompatibleBaseUrl = "http://127.0.0.1:11434/v1";

/**
 * Whether a routed model runs on a remote provider: not a local runtime and not an endpoint on this
 * machine or its private network (Ollama, LM Studio). One predicate for the lane and, from T62, the
 * adapters' deadline mode, so the two can never disagree.
 */
export function isRemoteExecution(target: ExecutionTarget): boolean {
  if (target.localModelId) return false;
  const baseUrl =
    target.baseUrl ??
    (target.provider === "openai-compatible" ? defaultOpenAiCompatibleBaseUrl : null);
  return baseUrl === null || !isLocalEndpoint(baseUrl);
}

/**
 * The lane of a routed model (F3 D29): `local` for local runtimes and loopback endpoints, which
 * share the machine with them, else one lane per remote provider configuration (two Codex profiles
 * are two lanes).
 */
export function executionLane(target: ExecutionTarget): {
  lane: LaneKey;
  remoteKind?: RemoteLaneKind;
} {
  if (!isRemoteExecution(target)) return { lane: "local" };
  return {
    lane: `remote:${target.providerConfigId ?? target.provider}`,
    remoteKind: target.provider === "openai-codex" ? "codex" : "api-key"
  };
}

/** The configured maximum of a lane: 1 for the local lane and in serial mode. */
export function laneMaximum(
  lane: LaneKey,
  remoteKind: RemoteLaneKind | undefined,
  config: Pick<AiLaneRuntimeConfig, "mode" | "lanes">
): number {
  if (lane === "local" || config.mode === "serial") return 1;
  return remoteKind === "codex" ? config.lanes.codexMax : config.lanes.apiKeyMax;
}

export interface WaitingEntry extends RankedEntry {
  readonly label: string;
  /** Called once the lane counted the entry as running. */
  readonly start: () => void;
}

/** One lane's mutable state; the scheduler owns every instance. */
export class Lane {
  public aimd: AimdState;
  /** Slots in use, held ones included. */
  public running = 0;
  public held = 0;
  public pausedUntil: number | null = null;
  public pauseTimer: unknown = undefined;
  public readonly waiting: WaitingEntry[] = [];

  public constructor(
    public readonly key: LaneKey,
    maximum: number
  ) {
    this.aimd = initialAimd(maximum);
  }

  /** The local lane never adapts: it runs one call at a time on this machine. */
  public get adaptive(): boolean {
    return this.key !== "local";
  }

  public remove(entry: WaitingEntry): boolean {
    const index = this.waiting.indexOf(entry);
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    return true;
  }

  public waitingByPriority(): Record<AiPriority, number> {
    const counts: Record<AiPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const entry of this.waiting) counts[entry.priority] += 1;
    return counts;
  }
}
