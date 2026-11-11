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
  /** How an Ask answer is spread over time and pieces; the default is {@link defaultAskStreamPlan}. */
  askStream?: AskStreamPlan;
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

/** The evidence handles a consultation prompt offers, once each, in the order it lists them. */
export function evidenceHandles(prompt: string): string[] {
  const handles = [...prompt.matchAll(/"handle"\s*:\s*"(e\d{1,3})"/gu)].map((match) => match[1]!);
  const found =
    handles.length > 0 ? handles : [firstEvidenceHandle(prompt)].filter((h) => h !== null);
  return [...new Set(found)];
}

/**
 * A valid Ask answer of three paragraphs (F5 D14, J6): the first cites the first passage of the
 * prompt, the next two the following ones (the same one again when the prompt offers fewer), and
 * each carries its marker. Plain text for any other prompt.
 */
export function askAnswer(prompt: string): string {
  const handles = evidenceHandles(prompt);
  if (handles.length === 0) return "OK";
  const cited = (index: number) => handles[index % handles.length]!;
  return JSON.stringify({
    paragraphs: [
      {
        markdown: `The first passage addresses the question [${cited(0)}].`,
        citations: [cited(0)],
        contextIds: []
      },
      {
        markdown: `A second passage adds the supporting detail the question asks for [${cited(1)}].`,
        citations: [cited(1)],
        contextIds: []
      },
      {
        markdown: `Taken together, the passages answer the question in full [${cited(2)}].`,
        citations: [cited(2)],
        contextIds: []
      }
    ],
    gaps: []
  });
}

/**
 * How the fake plays an Ask answer so the streamed text can be watched (F5 D14, J6): the call takes
 * at least `minMs` and the text arrives in at least `minPieces` pieces, cut at the paragraphs'
 * ends too, so the paragraph completions come well apart (at least 100 ms with the defaults), past
 * the 50 ms window of `consultation.delta`.
 */
export interface AskStreamPlan {
  minMs: number;
  minPieces: number;
}
export const defaultAskStreamPlan: AskStreamPlan = { minMs: 600, minPieces: 6 };

/** Whether the text is an Ask answer (JSON), which the stream plan applies to; "OK" is not. */
const isAskAnswerText = (text: string) => text.startsWith("{");

/**
 * The pieces an Ask answer streams in: each paragraph's object is cut apart from the next, and
 * every part is split into short pieces, so no piece carries the end of one paragraph and the
 * start of the next, and `minPieces` holds for the whole.
 */
export function askAnswerPieces(text: string, minPieces: number): string[] {
  const parts = text.split(/(?<=\},)(?=\{"markdown")/u);
  const perPart = Math.max(2, Math.ceil(minPieces / parts.length));
  return parts.flatMap((part) => splitAnswer(part, 28, perPart));
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
    const ask = isAskAnswerText(text);
    const plan = options.askStream ?? defaultAskStreamPlan;
    const sampled = options.latency.sample(
      seededUnit(options.seed, openAiCompatibleProvider, context.seq, "latency")
    );
    const totalMs = ask ? Math.max(sampled, plan.minMs) : sampled;
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
        (ask ? askAnswerPieces(text, plan.minPieces) : splitAnswer(text)).map((piece) =>
          chunk({ content: piece })
        ),
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
