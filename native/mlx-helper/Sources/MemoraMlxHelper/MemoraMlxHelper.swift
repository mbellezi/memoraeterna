import Foundation
import MLX
import MLXHuggingFace
import MLXLLM
import MLXLMCommon
import MLXVLM
import Tokenizers

/// Tokenizer loader shared by every command (swift-transformers `AutoTokenizer`).
func makeTokenizerLoader() -> any TokenizerLoader {
    #huggingFaceTokenizerLoader()
}

/// Model used by `generate`; kept across requests and dropped after a failed generation or an
/// `unload {slot: "generate"}`.
final class GenerationCache {
    var modelPath: String?
    var model: ModelContainer?

    func reset() {
        modelPath = nil
        model = nil
    }
}

/// Bounds MLX's reusable GPU buffer cache, which otherwise grows without limit during
/// long batched scoring or embedding runs and pushes the host into swap.
/// `MEMORA_MLX_CACHE_LIMIT_MB` (default 1024) caps the cache; `MEMORA_MLX_MEMORY_LIMIT_MB`
/// optionally sets a relaxed overall limit.
func configureMemoryLimits(_ environment: [String: String] = ProcessInfo.processInfo.environment) {
    let megabyte = 1_024 * 1_024
    let cacheMegabytes = environment["MEMORA_MLX_CACHE_LIMIT_MB"].flatMap(Int.init) ?? 1_024
    Memory.cacheLimit = max(0, cacheMegabytes) * megabyte
    if let memoryMegabytes = environment["MEMORA_MLX_MEMORY_LIMIT_MB"].flatMap(Int.init),
        memoryMegabytes > 0
    {
        Memory.memoryLimit = memoryMegabytes * megabyte
    }
}

/// Hands a `cancel` line to the registry and reports `true`; any other line is registered as
/// received (so a cancel that follows it at once is honoured) and reports `false`.
func routeCancel(_ line: String, to cancellation: CancellationRegistry) -> Bool {
    guard let data = line.data(using: .utf8),
        let envelope = try? JSONDecoder().decode(RequestEnvelope.self, from: data),
        let requestId = envelope.requestId
    else { return false }
    if envelope.command == "cancel", envelope.protocolVersion == protocolVersion {
        cancellation.cancel(requestId)
        return true
    }
    cancellation.received(requestId)
    return false
}

@main
private struct MemoraMlxHelper {
    static func main() async {
        configureMemoryLimits()
        let cancellation = CancellationRegistry()
        let (lines, continuation) = AsyncStream<String>.makeStream()
        // stdin is read on its own thread, concurrently with the request the worker runs, so a
        // `cancel` reaches the token loop or the scoring loop while they run (requests themselves
        // still run one at a time, in order).
        let reader = Thread {
            while let line = readLine() {
                if routeCancel(line, to: cancellation) { continue }
                continuation.yield(line)
            }
            continuation.finish()
        }
        reader.name = "memora-mlx-helper-stdin"
        reader.start()
        let worker = Worker(cancellation: cancellation)
        for await line in lines {
            if await worker.handle(line) == .stop { return }
        }
    }
}

/// Runs the requests one at a time and owns the loaded models.
private final class Worker {
    enum Disposition { case next, stop }

    private let cancellation: CancellationRegistry
    private let decoder = JSONDecoder()
    private let generation = GenerationCache()
    private var embedders = EmbedderCache()
    private var scorers = ScorerCache()

    init(cancellation: CancellationRegistry) {
        self.cancellation = cancellation
    }

    func handle(_ line: String) async -> Disposition {
        guard let data = line.data(using: .utf8) else { return .next }
        var command: String?
        var requestId: UUID?
        defer {
            if let requestId { cancellation.finished(requestId) }
            // Return transient buffers to the system between requests; loaded weights stay.
            Memory.clearCache()
        }
        do {
            let request = try decoder.decode(Request.self, from: data)
            command = request.command
            requestId = request.requestId
            guard request.protocolVersion == protocolVersion else {
                throw HelperError.unsupportedProtocol
            }
            // A request the host cancelled before it started never runs.
            try cancellation.throwIfCancelled(request.requestId)
            switch request.command {
            case "health":
                Output.emit(Message(
                    protocolVersion: protocolVersion, requestId: request.requestId,
                    kind: "result", ok: true, output: "ok", durationMs: 0,
                    capabilities: helperCapabilities
                ))
            case "shutdown":
                Output.emit(Message(
                    protocolVersion: protocolVersion, requestId: request.requestId,
                    kind: "result", ok: true, output: "", durationMs: 0
                ))
                return .stop
            case "generate":
                try await generate(request)
            case "embed":
                try await Embedder.embed(request, cache: embedders)
            case "score":
                try await Scorer.score(request, cache: scorers, cancellation: cancellation)
            case "unload":
                try unload(request)
            default:
                throw HelperError.unsupportedCommand
            }
        } catch {
            let failedId =
                requestId ?? (try? decoder.decode(RequestEnvelope.self, from: data).requestId)
                ?? UUID()
            Output.failure(failedId, error)
            // A cancelled generation keeps its model; any other failure drops it.
            let cancelled = (error as? HelperError)?.isCancellation ?? false
            if !cancelled && (command == nil || command == "generate") { generation.reset() }
        }
        return .next
    }

    /// `unload {slot}`: drops the slot's model and returns its buffers to the system. The other
    /// slots keep theirs.
    private func unload(_ request: Request) throws {
        let started = ContinuousClock.now
        switch request.slot {
        case "generate": generation.reset()
        case "embed": embedders = EmbedderCache()
        case "score": scorers = ScorerCache()
        default:
            throw HelperError.invalidRequest("unload requires slot generate, embed or score")
        }
        Memory.clearCache()
        Output.emit(Message(
            protocolVersion: protocolVersion, requestId: request.requestId,
            kind: "result", ok: true, output: "",
            durationMs: max(0, Int(elapsedMs(since: started).rounded()))
        ))
    }

    private func generate(_ request: Request) async throws {
        guard let modelPath = request.modelPath, let prompt = request.prompt else {
            throw HelperError.invalidRequest("generate requires modelPath and prompt")
        }
        let parameters = request.parameters ?? GenerationParameters(
            maxTokens: 1_024, temperature: 0.2, topP: nil, topK: nil,
            presencePenalty: nil, enableThinking: false, seed: nil
        )
        let requestId = request.requestId
        let startedAt = ContinuousClock.now
        Output.progress(requestId, 0.05, "localModels.progress.loading")
        if generation.model == nil || generation.modelPath != modelPath {
            // The previous model leaves before the next one loads: never two generative models.
            generation.reset()
            Memory.clearCache()
            generation.model = try await loadModelContainer(
                from: URL(filePath: modelPath),
                using: makeTokenizerLoader()
            )
            generation.modelPath = modelPath
        }
        guard let model = generation.model else { throw HelperError.invalidRequest("model not loaded") }
        try cancellation.throwIfCancelled(requestId)
        let tokenizer = await model.tokenizer
        let inputTokenCount = tokenizer.encode(text: prompt).count
        Output.progress(requestId, 0.65, "localModels.progress.generating")
        let generateParameters = GenerateParameters(
            maxTokens: parameters.maxTokens,
            temperature: parameters.temperature,
            topP: parameters.topP ?? 1.0,
            topK: parameters.topK ?? 0,
            presencePenalty: parameters.presencePenalty,
            seed: parameters.seed
        )
        let output = try await Generator.respond(
            model: model, prompt: prompt, parameters: generateParameters,
            enableThinking: parameters.enableThinking ?? false,
            stream: request.stream ?? false, requestId: requestId, cancellation: cancellation
        )
        let outputTokenCount = tokenizer.encode(text: output, addSpecialTokens: false).count
        let duration = startedAt.duration(to: .now)
        let milliseconds = Int(duration.components.seconds * 1_000)
            + Int(duration.components.attoseconds / 1_000_000_000_000_000)
        Output.progress(requestId, 1, "localModels.progress.completed")
        Output.emit(Message(
            protocolVersion: protocolVersion, requestId: requestId,
            kind: "result", ok: true,
            output: output, durationMs: max(0, milliseconds),
            inputTokens: inputTokenCount, outputTokens: outputTokenCount
        ))
    }
}

enum Generator {
    /// The answer to one user prompt, exactly as `ChatSession.respond(to:)` of MLX Swift LM 3.31.4
    /// builds it (one user message, the same media processing, chat template context, KV cache,
    /// token iterator and text handler), with the generation task in hand: a `cancel` stops it at
    /// the next token, and with `stream` every piece of text is sent as a `delta` line. The streamed
    /// pieces concatenate to the returned text.
    static func respond(
        model: ModelContainer, prompt: String, parameters: GenerateParameters,
        enableThinking: Bool, stream: Bool, requestId: UUID, cancellation: CancellationRegistry
    ) async throws -> String {
        let additionalContext: [String: any Sendable] = ["enable_thinking": enableThinking]
        let output = try await model.perform { context in
            let input = try await context.processor.prepare(
                input: UserInput(
                    chat: [Chat.Message(role: .user, content: prompt)],
                    processing: .init(resize: CGSize(width: 512, height: 512)),
                    tools: nil,
                    additionalContext: additionalContext
                ))
            let iterator = try TokenIterator(
                input: input, model: context.model,
                cache: context.model.newCache(parameters: parameters), parameters: parameters)
            let (generations, task) = generateTask(
                promptTokenCount: input.text.tokens.size,
                modelConfiguration: context.configuration,
                tokenizer: context.tokenizer,
                iterator: iterator,
                tools: nil
            )
            cancellation.onCancel(requestId) { task.cancel() }
            var text = ""
            for await generation in generations {
                guard let chunk = generation.chunk else { continue }
                text += chunk
                if stream { Output.delta(requestId, chunk) }
            }
            // The token loop has stopped (finished, or cancelled at its next token) before the
            // worker takes the next request.
            await task.value
            return text
        }
        try cancellation.throwIfCancelled(requestId)
        return output
    }
}
