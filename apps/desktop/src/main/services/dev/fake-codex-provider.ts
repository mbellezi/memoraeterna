import {
  fakeTokens,
  jsonBody,
  jsonReply,
  seededUnit,
  splitAnswer,
  sseData,
  timedParts,
  type FakeCallContext,
  type FakeHttpRequest,
  type FakeProviderKind,
  type LatencyModel,
  type ReplyScript
} from "./fake-remote-core.js";

/**
 * The Codex-wire fake of the soak (F3 R6, T62): an in-process server on loopback that speaks the
 * ChatGPT/Codex Responses protocol (`GET /models`, `POST /responses` answered as server-sent
 * events) behind a DEV OAuth stub, and serves `op:relation_explanation`. The real Codex adapter
 * talks to it, so the remote route of the Hybrid default is part of the soak. Answers are templated
 * and valid (an explanation is a short sentence; the sentinel `NOT_RELATED` at a seeded 2%), their
 * latency is drawn from the recorded Codex durations.
 *
 * The OAuth stub is a fixed dummy credential in a DEV-only credential entry. It is never a real
 * token, it opens nothing outside this machine, and its expiry lies far in the future so the app
 * never tries to refresh it against the real authorization server.
 */

export const codexWireProvider = "codex-wire";
export const devFakeCodexModelId = "dev-fake-explain-1";

/** What the credential service stores for the DEV Codex provider configuration. */
export const devCodexCredential = {
  access: "dev-fake-codex-access-token",
  refresh: "dev-fake-codex-refresh-token",
  /** 2100-01-01: beyond any refresh margin. */
  expires: 4_102_444_800_000,
  accountId: "dev-fake-codex-account"
} as const;

/** The path prefix the Codex adapter appends `/responses` and `/models` to. */
export const codexWireBasePath = "/backend-api/codex";

export interface CodexWireFakeOptions {
  seed: number;
  latency: LatencyModel;
  /** Share of the call that passes before the first answer text arrives. */
  firstByteFraction?: number;
  /** Share of explanations the fake answers with the sentinel (the notes are not related). */
  notRelatedRate?: number;
  modelId?: string;
}

const explanations = [
  "n1 and n2 describe the same subject from two angles, so reading one clarifies the other.",
  "n1 gives the general idea that n2 illustrates with a more specific case.",
  "n2 supports what n1 claims by adding evidence about the same topic.",
  "n1 and n2 share a concept and differ in emphasis, which makes them useful side by side."
] as const;

/** An explanation the writer accepts: a short sentence naming the notes as n1 and n2. */
export function explanationText(seed: number, seq: number): string {
  return explanations[
    Math.floor(seededUnit(seed, codexWireProvider, seq, "text") * explanations.length)
  ]!;
}

/**
 * What the explanation consumer refuses and re-asks: an answer too short to explain anything (a
 * small model's "Related."), the failure the writer's repair exists for. It is neither the sentinel
 * nor markup, which the AI service would clean before the consumer saw it.
 */
export const malformedExplanation = "Related.";

/** The sentinel a writer answers when the notes are not related (the whole answer). */
export const notRelatedAnswer = "NOT_RELATED";

function promptOf(body: Record<string, unknown> | null): string {
  const input = body?.input;
  if (!Array.isArray(input)) return "";
  return input
    .flatMap((message) => {
      const content = (message as { content?: unknown })?.content;
      return Array.isArray(content)
        ? content.map((part) =>
            typeof (part as { text?: unknown })?.text === "string"
              ? (part as { text: string }).text
              : ""
          )
        : [];
    })
    .join("\n");
}

export function codexWireKind(options: CodexWireFakeOptions): FakeProviderKind {
  const modelId = options.modelId ?? devFakeCodexModelId;
  const firstByteFraction = options.firstByteFraction ?? 0.3;
  const notRelatedRate = options.notRelatedRate ?? 0.02;

  const answer = (request: FakeHttpRequest, context: FakeCallContext): string => {
    const prompt = promptOf(jsonBody(request));
    // Only an explanation prompt (it names the two notes) can be answered with the sentinel.
    const explains = /\bn1\b/u.test(prompt) && /\bn2\b/u.test(prompt);
    if (!explains) return "OK";
    return seededUnit(options.seed, codexWireProvider, context.seq, "not-related") < notRelatedRate
      ? notRelatedAnswer
      : explanationText(options.seed, context.seq);
  };

  const response = (
    request: FakeHttpRequest,
    context: FakeCallContext,
    text: string
  ): ReplyScript => {
    const body = jsonBody(request);
    if (body === null)
      return jsonReply(400, { error: { message: "body is not JSON", code: "invalid_request" } });
    const prompt = promptOf(body);
    const totalMs = options.latency.sample(
      seededUnit(options.seed, codexWireProvider, context.seq, "latency")
    );
    const id = `resp_fake_${context.seq}`;
    const usage = {
      input_tokens: fakeTokens(prompt),
      output_tokens: fakeTokens(text),
      total_tokens: fakeTokens(prompt) + fakeTokens(text)
    };
    const event = (type: string, extra: Record<string, unknown> = {}) =>
      sseData({ type, ...extra });
    return {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      parts: timedParts(
        // A lifecycle event comes at once and is not progress; the answer text follows.
        [event("response.created", { response: { id, status: "in_progress" } })],
        splitAnswer(text).map((delta) =>
          event("response.output_text.delta", { item_id: `msg_${id}`, output_index: 0, delta })
        ),
        [
          event("response.output_text.done", { item_id: `msg_${id}`, output_index: 0, text }),
          event("response.completed", { response: { id, status: "completed", usage } }),
          "data: [DONE]\n\n"
        ],
        totalMs,
        firstByteFraction
      )
    };
  };

  return {
    provider: codexWireProvider,
    authorize: (headers) =>
      headers.authorization === `Bearer ${devCodexCredential.access}` &&
      headers["chatgpt-account-id"] === devCodexCredential.accountId,
    isGeneration: (request) => request.method === "POST" && request.path.endsWith("/responses"),
    reply(request, context) {
      if (request.method === "GET" && request.path.endsWith("/models")) {
        return jsonReply(200, {
          models: [
            {
              slug: modelId,
              display_name: "DEV fake explainer",
              visibility: "list",
              context_window: 128_000,
              max_output_tokens: 8_192
            }
          ]
        });
      }
      if (request.method === "POST" && request.path.endsWith("/responses"))
        return response(request, context, answer(request, context));
      return jsonReply(404, {
        error: { message: "not served by the DEV fake", code: "not_found" }
      });
    },
    replyWithText: (request, context, text) => response(request, context, text),
    malformedText: () => malformedExplanation,
    rateLimited: (retryAfterSeconds) =>
      jsonReply(
        429,
        {
          error: {
            message: "Rate limit reached (DEV fake).",
            type: "rate_limit_error",
            code: "rate_limit_exceeded"
          }
        },
        { "retry-after": String(retryAfterSeconds) }
      ),
    unavailable: () =>
      jsonReply(503, {
        error: {
          message: "The server is overloaded (DEV fake).",
          type: "server_error",
          code: "overloaded"
        }
      })
  };
}
