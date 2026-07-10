import Foundation
import MLXHuggingFace
import MLXLLM
import MLXLMCommon
import MLXVLM
import Tokenizers

private let protocolVersion = 1

private struct GenerationParameters: Codable {
    let maxTokens: Int
    let temperature: Float
    let seed: UInt64?
}

private struct Request: Codable {
    let protocolVersion: Int
    let requestId: UUID
    let command: String
    let modelPath: String?
    let prompt: String?
    let parameters: GenerationParameters?
}

private struct ErrorPayload: Codable {
    let code: String
    let messageKey: String
    let recoverable: Bool
}

private struct Message: Codable {
    let protocolVersion: Int
    let requestId: UUID
    let kind: String
    let progress: Double?
    let messageKey: String?
    let ok: Bool?
    let output: String?
    let durationMs: Int?
    let inputTokens: Int?
    let outputTokens: Int?
    let error: ErrorPayload?
}

@main
private struct MemoraMlxHelper {
    static func main() async {
        let decoder = JSONDecoder()
        var loadedModelPath: String?
        var loadedModel: ModelContainer?
        while let line = readLine(), let data = line.data(using: .utf8) {
          do {
            let request = try decoder.decode(Request.self, from: data)
            guard request.protocolVersion == protocolVersion else {
                throw HelperError.unsupportedProtocol
            }
            switch request.command {
            case "health":
                emit(Message(
                    protocolVersion: protocolVersion, requestId: request.requestId,
                    kind: "result", progress: nil, messageKey: nil, ok: true,
                    output: "ok", durationMs: 0, inputTokens: nil, outputTokens: nil, error: nil
                ))
            case "shutdown":
                emit(Message(
                    protocolVersion: protocolVersion, requestId: request.requestId,
                    kind: "result", progress: nil, messageKey: nil, ok: true,
                    output: "", durationMs: 0, inputTokens: nil, outputTokens: nil, error: nil
                ))
                return
            case "generate":
                try await generate(request, loadedModelPath: &loadedModelPath, loadedModel: &loadedModel)
            default:
                throw HelperError.unsupportedCommand
            }
        } catch {
            let requestId = (try? decoder.decode(Request.self, from: data).requestId) ?? UUID()
            emit(Message(
                protocolVersion: protocolVersion, requestId: requestId,
                kind: "result", progress: nil, messageKey: nil, ok: false,
                output: nil, durationMs: nil, inputTokens: nil, outputTokens: nil,
                error: ErrorPayload(
                    code: String(describing: type(of: error)),
                    messageKey: "errors.localModels.runtimeFailed",
                    recoverable: true
                )
            ))
            loadedModel = nil
            loadedModelPath = nil
          }
        }
    }

    private static func generate(
        _ request: Request,
        loadedModelPath: inout String?,
        loadedModel: inout ModelContainer?
    ) async throws {
        guard let modelPath = request.modelPath, let prompt = request.prompt else {
            throw HelperError.invalidRequest
        }
        let parameters = request.parameters ?? GenerationParameters(maxTokens: 1_024, temperature: 0.2, seed: nil)
        let startedAt = ContinuousClock.now
        emitProgress(request.requestId, progress: 0.05, messageKey: "localModels.progress.loading")
        if loadedModel == nil || loadedModelPath != modelPath {
            loadedModel = try await loadModelContainer(
                from: URL(filePath: modelPath),
                using: #huggingFaceTokenizerLoader()
            )
            loadedModelPath = modelPath
        }
        guard let model = loadedModel else { throw HelperError.invalidRequest }
        let tokenizer = await model.tokenizer
        let inputTokenCount = tokenizer.encode(text: prompt).count
        emitProgress(request.requestId, progress: 0.65, messageKey: "localModels.progress.generating")
        let generation = GenerateParameters(
            maxTokens: parameters.maxTokens,
            temperature: parameters.temperature,
            seed: parameters.seed
        )
        let session = ChatSession(model, generateParameters: generation)
        let output = try await session.respond(to: prompt)
        let outputTokenCount = tokenizer.encode(text: output, addSpecialTokens: false).count
        let duration = startedAt.duration(to: .now)
        let milliseconds = Int(duration.components.seconds * 1_000)
            + Int(duration.components.attoseconds / 1_000_000_000_000_000)
        emitProgress(request.requestId, progress: 1, messageKey: "localModels.progress.completed")
        emit(Message(
            protocolVersion: protocolVersion, requestId: request.requestId,
            kind: "result", progress: nil, messageKey: nil, ok: true,
            output: output, durationMs: max(0, milliseconds),
            inputTokens: inputTokenCount, outputTokens: outputTokenCount, error: nil
        ))
    }

    private static func emitProgress(_ requestId: UUID, progress: Double, messageKey: String) {
        emit(Message(
            protocolVersion: protocolVersion, requestId: requestId,
            kind: "progress", progress: progress, messageKey: messageKey, ok: nil,
            output: nil, durationMs: nil, inputTokens: nil, outputTokens: nil, error: nil
        ))
    }

    private static func emit(_ message: Message) {
        guard let data = try? JSONEncoder().encode(message), let line = String(data: data, encoding: .utf8) else {
            return
        }
        print(line)
        fflush(stdout)
    }
}

private enum HelperError: Error {
    case invalidRequest
    case unsupportedCommand
    case unsupportedProtocol
}
