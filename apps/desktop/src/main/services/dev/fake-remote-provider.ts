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
 * The OpenAI-compatible fake of the soak (F3 R6, T62): an in-process server on loopback that speaks
 * `/v1/models` and `/v1/chat/completions` (streamed or not) and serves `class:answer`, that is
 * Ask. Its answers are templated and always valid: Ask cites the first passage the prompt gives it,
 * so validity never depends on a replay hit rate. Its latency is drawn from a recorded
 * distribution, its credential is the fixed dummy key below, and its provider configuration
 * carries `treatAsRemote: true` (fake-remote-install.ts) so it runs under the remote deadlines.
 */

export const openAiCompatibleProvider = "openai-compatible";

/** The dummy key of the DEV provider configuration: it opens nothing outside this machine. */
export const devFakeApiKey = "dev-fake-remote-api-key";
export const devFakeAnswerModelId = "dev-fake-answer-1";

export interface OpenAiCompatibleFakeOptions {
  seed: number;
  latency: LatencyModel;
  /** Share of the call that passes before the first answer text arrives. */
  firstByteFraction?: number;
  modelId?: string;
  /**
   * The usage a completion reports, from its prompt, answer and request body; by default a token
   * for every four characters of each (the soak's priced fake bills what the budget reserved).
   */
  usage?: (
    prompt: string,
    text: string,
    body: Record<string, unknown>
  ) => { prompt_tokens: number; completion_tokens: number };
}

/** The first evidence handle (`e1`, `e2`, ...) a consultation prompt offers, or null. */
export function firstEvidenceHandle(prompt: string): string | null {
  return (
    /"handle"\s*:\s*"(e\d{1,3})"/u.exec(prompt)?.[1] ?? /\[(e\d{1,3})\]/u.exec(prompt)?.[1] ?? null
  );
}

/** A valid Ask answer that cites the first passage of the prompt; plain text for any other prompt. */
export function askAnswer(prompt: string): string {
  const handle = firstEvidenceHandle(prompt);
  if (handle === null) return "OK";
  return JSON.stringify({
    paragraphs: [
      {
        markdown: `The first passage addresses the question [${handle}].`,
        citations: [handle],
        contextIds: []
      }
    ],
    gaps: []
  });
}

/** An answer the consultation parser refuses: JSON cut off in the middle. */
export const malformedAskAnswer = '{"paragraphs": [{"markdown": "The first passage';

function promptOf(body: Record<string, unknown> | null): string {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message) =>
      typeof (message as { content?: unknown })?.content === "string"
        ? (message as { content: string }).content
        : ""
    )
    .join("\n");
}

export function openAiCompatibleKind(options: OpenAiCompatibleFakeOptions): FakeProviderKind {
  const modelId = options.modelId ?? devFakeAnswerModelId;
  const firstByteFraction = options.firstByteFraction ?? 0.3;

  const completion = (
    request: FakeHttpRequest,
    context: FakeCallContext,
    text: string
  ): ReplyScript => {
    const body = jsonBody(request);
    if (body === null) {
      return jsonReply(400, { error: { message: "body is not JSON", code: "invalid_request" } });
    }
    const prompt = promptOf(body);
    const totalMs = options.latency.sample(
      seededUnit(options.seed, openAiCompatibleProvider, context.seq, "latency")
    );
    const counted = options.usage?.(prompt, text, body) ?? {
      prompt_tokens: fakeTokens(prompt),
      completion_tokens: fakeTokens(text)
    };
    const usage = { ...counted, total_tokens: counted.prompt_tokens + counted.completion_tokens };
    const id = `chatcmpl-fake-${context.seq}`;
    if (body.stream !== true) {
      return jsonReply(
        200,
        {
          id,
          object: "chat.completion",
          model: modelId,
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }
          ],
          usage
        },
        {},
        totalMs
      );
    }
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      sseData({
        id,
        object: "chat.completion.chunk",
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finish }]
      });
    return {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      parts: timedParts(
        [],
        splitAnswer(text).map((piece) => chunk({ content: piece })),
        [
          chunk({}, "stop"),
          sseData({ id, object: "chat.completion.chunk", choices: [], usage }),
          "data: [DONE]\n\n"
        ],
        totalMs,
        firstByteFraction
      )
    };
  };

  return {
    provider: openAiCompatibleProvider,
    authorize: (headers) => headers.authorization === `Bearer ${devFakeApiKey}`,
    isGeneration: (request) =>
      request.method === "POST" && request.path.endsWith("/chat/completions"),
    reply(request, context) {
      if (request.method === "GET" && request.path.endsWith("/models")) {
        return jsonReply(200, {
          object: "list",
          data: [{ id: modelId, object: "model", context_window: 128_000 }]
        });
      }
      if (request.method === "POST" && request.path.endsWith("/chat/completions")) {
        return completion(request, context, askAnswer(promptOf(jsonBody(request))));
      }
      return jsonReply(404, {
        error: { message: "not served by the DEV fake", code: "not_found" }
      });
    },
    replyWithText: (request, context, text) => completion(request, context, text),
    malformedText: () => malformedAskAnswer,
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
