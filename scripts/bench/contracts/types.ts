/**
 * What a contract of the prompt-replay harness (F4 T69) is: one kind of generative call the product
 * makes (summary, notes, graph, confirmation, topic names, overview, typing), how a recorded prompt of
 * it is taken apart and put back together, and how the product's own validation and repair run on a
 * local writer's answer.
 */
import type { AiOutputSchema } from "@app/domain";
import type { z } from "zod";

export const contractIds = [
  "summary",
  "notes",
  "graph",
  "confirmation",
  "topic-names",
  "overview",
  "typing"
] as const;
export type ContractId = (typeof contractIds)[number];

export type ReplayTaskType =
  "summarization" | "atomic-note-generation" | "knowledge-graph-generation" | "structured-output";

/** One request to the writer, as the product's caller states it before `AiService` adds the language. */
export interface ReplayCall {
  contract: ContractId;
  taskType: ReplayTaskType;
  /** The prompt a caller built (output-language instruction not yet added). */
  prompt: string;
  /** The content language the instruction names. */
  language: string;
  /** The calling operation, which sets parameter defaults (`aiTaskBehaviorDefaults`). */
  operation: string;
  /** Zero for the first ask of an item, one for its repair. */
  attempt: number;
  isRepair: boolean;
  /** The caller's output allowance (`limits.maxOutputTokens` of `runDefaultTask`). */
  maxOutputTokens?: number;
  /** The Zod contract of the answer, which a schema source may turn into an output schema. */
  answerContract?: { name: string; contract: z.ZodType };
}

/** What the writer answered and what the call took; the harness fills the measurements. */
export interface ReplayCallResult {
  output: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  durationMs: number;
  /** Start of the answer text, from the start of the call. */
  ttftMs?: number | null;
  schemaMode?: string | null;
}

/** Sends a call to the writer. A failed call throws; the contract's flow decides what that means. */
export type ReplayCaller = (call: ReplayCall) => Promise<ReplayCallResult>;

/** What a contract's flow ended with, read after the product's validation and repair. */
export interface FlowOutcome {
  ok: boolean;
  /** The product's error code when the flow ended without a usable answer. */
  error: string | null;
  /** The final answer reduced to what the yield compares; null when there is none. */
  digest: Digest | null;
  /** Items kept after a deterministic fix or dropped with no call (the product's `salvaged_items`). */
  salvagedItems: number;
}

/** A comparable reduction of an answer: JSON numbers, strings and lists only. */
export type Digest = Record<string, unknown>;

/** Numbers that compare a local answer with the recorded one (ratios and rates). */
export type YieldMetrics = Record<string, number>;

/** Which first prompt a replay sends: the recording's or today's. */
export type PromptSource = "recorded" | "current";

/** How closely the harness drives the product: its own flow, or its pure functions in a loop. */
export type Fidelity = "product-flow" | "product-pure";

export interface PreparedItem {
  contract: ContractId;
  fidelity: Fidelity;
  taskType: ReplayTaskType;
  operation: string;
  language: string;
  /** The prompt body the recording sent (output-language instruction not included). */
  body: string;
  /**
   * The prompt today's builders make from the same inputs (put back from the recorded prompt). It
   * differs from `body` when the prompt was revised after the recording.
   */
  current: string;
  /**
   * Runs the product's flow with this caller, from the first ask to the last repair. `recorded`
   * sends the recorded body as the first ask (the same inputs the recorded answer saw); `current`
   * sends today's prompt for them. Repairs are always the product's own.
   */
  run(caller: ReplayCaller, prompts: PromptSource): Promise<FlowOutcome>;
  /** A recorded answer's digest, read leniently (what it holds, whatever its flaws); null if none. */
  digestOf(output: string): Digest | null;
  /** Compares a local final digest with the recorded one. */
  compare(local: Digest, recorded: Digest): YieldMetrics;
  /** The strict or grammar schema source asks for this contract's answer, when it has one. */
  answerContract: { name: string; contract: z.ZodType } | null;
}

export type Prepared =
  | { kind: "item"; item: PreparedItem }
  /** A repair prompt the recording made after its own first answer failed: not replayed. */
  | { kind: "recorded_repair"; contract: ContractId }
  /** A prompt of a contract this harness knows, taken apart but not put back to the recorded text. */
  | { kind: "unreconstructable"; contract: ContractId; reason: string };

/** Turns a Zod contract into the output schema a request carries; null when it has none. */
export type SchemaSource = (
  contract: ContractId,
  answer: { name: string; contract: z.ZodType }
) => AiOutputSchema | null;
