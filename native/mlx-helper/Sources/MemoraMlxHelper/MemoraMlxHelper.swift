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

/// Model used by `generate`; kept across requests and dropped after a failed generation.
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

@main
private struct MemoraMlxHelper {
    static func main() async {
        configureMemoryLimits()
        let decoder = JSONDecoder()
        let generation = GenerationCache()
        let embedders = EmbedderCache()
        let scorers = ScorerCache()
        while let line = readLine(), let data = line.data(using: .utf8) {
            var command: String?
            do {
                let request = try decoder.decode(Request.self, from: data)
                command = request.command
                guard request.protocolVersion == protocolVersion else {
                    throw HelperError.unsupportedProtocol
                }
                switch request.command {
                case "health":
                    Output.emit(Message(
                        protocolVersion: protocolVersion, requestId: request.requestId,
                        kind: "result", ok: true, output: "ok", durationMs: 0
                    ))
                case "shutdown":
                    Output.emit(Message(
                        protocolVersion: protocolVersion, requestId: request.requestId,
                        kind: "result", ok: true, output: "", durationMs: 0
                    ))
                    return
                case "generate":
                    try await generate(request, cache: generation)
                case "embed":
                    try await Embedder.embed(request, cache: embedders)
                case "score":
                    try await Scorer.score(request, cache: scorers)
                default:
                    throw HelperError.unsupportedCommand
                }
            } catch {
                let requestId = (try? decoder.decode(Request.self, from: data).requestId) ?? UUID()
                Output.failure(requestId, error)
                if command == nil || command == "generate" { generation.reset() }
            }
            // Return transient buffers to the system between requests; loaded weights stay.
            Memory.clearCache()
        }
    }

    private static func generate(_ request: Request, cache: GenerationCache) async throws {
        guard let modelPath = request.modelPath, let prompt = request.prompt else {
            throw HelperError.invalidRequest("generate requires modelPath and prompt")
        }
        let parameters = request.parameters ?? GenerationParameters(
            maxTokens: 1_024, temperature: 0.2, topP: nil, topK: nil,
            presencePenalty: nil, enableThinking: false, seed: nil
        )
        let startedAt = ContinuousClock.now
        Output.progress(request.requestId, 0.05, "localModels.progress.loading")
        if cache.model == nil || cache.modelPath != modelPath {
            cache.model = try await loadModelContainer(
                from: URL(filePath: modelPath),
                using: makeTokenizerLoader()
            )
            cache.modelPath = modelPath
        }
        guard let model = cache.model else { throw HelperError.invalidRequest("model not loaded") }
        let tokenizer = await model.tokenizer
        let inputTokenCount = tokenizer.encode(text: prompt).count
        Output.progress(request.requestId, 0.65, "localModels.progress.generating")
        let generation = GenerateParameters(
            maxTokens: parameters.maxTokens,
            temperature: parameters.temperature,
            topP: parameters.topP ?? 1.0,
            topK: parameters.topK ?? 0,
            presencePenalty: parameters.presencePenalty,
            seed: parameters.seed
        )
        let session = ChatSession(
            model,
            generateParameters: generation,
            additionalContext: ["enable_thinking": parameters.enableThinking ?? false]
        )
        let output = try await session.respond(to: prompt)
        let outputTokenCount = tokenizer.encode(text: output, addSpecialTokens: false).count
        let duration = startedAt.duration(to: .now)
        let milliseconds = Int(duration.components.seconds * 1_000)
            + Int(duration.components.attoseconds / 1_000_000_000_000_000)
        Output.progress(request.requestId, 1, "localModels.progress.completed")
        Output.emit(Message(
            protocolVersion: protocolVersion, requestId: request.requestId,
            kind: "result", ok: true,
            output: output, durationMs: max(0, milliseconds),
            inputTokens: inputTokenCount, outputTokens: outputTokenCount
        ))
    }
}
