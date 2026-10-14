import Foundation

let protocolVersion = 1

struct GenerationParameters: Codable {
    let maxTokens: Int
    let temperature: Float
    let topP: Float?
    let topK: Int?
    let presencePenalty: Float?
    let enableThinking: Bool?
    let seed: UInt64?
}

/// One reranker input for `score` when queries differ per document.
struct ScorePair: Codable, Sendable {
    let query: String
    let document: String
    let instruction: String?
}

/// A JSONL request. `generate`, `health` and `shutdown` keep their original shape; `embed` and
/// `score` add optional top-level fields that older commands ignore.
struct Request: Codable {
    let protocolVersion: Int
    let requestId: UUID
    let command: String
    let modelPath: String?
    let prompt: String?
    let parameters: GenerationParameters?
    // embed
    let texts: [String]?
    let normalize: Bool?
    let dimensions: Int?
    // embed + score
    let maxTokens: Int?
    let batchSize: Int?
    // score
    let instruction: String?
    let query: String?
    let documents: [String]?
    let pairs: [ScorePair]?
}

struct ErrorPayload: Codable {
    let code: String
    let messageKey: String
    let recoverable: Bool
}

struct BatchTiming: Codable, Sendable {
    /// Number of inputs in the batch.
    let size: Int
    /// Padded sequence length of the batch, in tokens.
    let sequenceLength: Int
    /// Wall time of the forward pass including evaluation and read-back.
    let ms: Double
}

struct Timing: Codable {
    /// Model load time for this request; 0 when the cached model was reused.
    let loadMs: Double
    let modelCached: Bool
    let tokenizeMs: Double
    /// Sum of the batch times.
    let inferenceMs: Double
    /// `inferenceMs` divided by the number of inputs (texts or pairs).
    let perItemMs: Double
    let totalMs: Double
    let batches: [BatchTiming]
}

/// A JSONL message. Optional fields are omitted when nil, so `generate`, `health` and `shutdown`
/// messages are byte-for-byte the shape they had before `embed` and `score` existed.
struct Message: Codable {
    let protocolVersion: Int
    let requestId: UUID
    let kind: String
    var progress: Double? = nil
    var messageKey: String? = nil
    var ok: Bool? = nil
    var output: String? = nil
    var durationMs: Int? = nil
    var inputTokens: Int? = nil
    var outputTokens: Int? = nil
    var error: ErrorPayload? = nil
    // embed
    var embeddings: [[Float]]? = nil
    var dimensions: Int? = nil
    var normalized: Bool? = nil
    var pooling: String? = nil
    // score
    var scores: [Double]? = nil
    var logOdds: [Double]? = nil
    var yesTokenId: Int? = nil
    var noTokenId: Int? = nil
    // embed + score
    var tokenCounts: [Int]? = nil
    var truncated: [Bool]? = nil
    var timing: Timing? = nil
}

enum HelperError: Error, CustomStringConvertible {
    case invalidRequest(String)
    case unsupportedCommand
    case unsupportedProtocol
    case unsupportedArchitecture(String)
    case tokenizerMismatch(String)
    case nonFiniteOutput

    var description: String {
        switch self {
        case .invalidRequest(let detail): "invalid request: \(detail)"
        case .unsupportedCommand: "unsupported command"
        case .unsupportedProtocol: "unsupported protocol version"
        case .unsupportedArchitecture(let detail): "unsupported model architecture: \(detail)"
        case .tokenizerMismatch(let detail): "tokenizer mismatch: \(detail)"
        case .nonFiniteOutput: "the model produced a non-finite value"
        }
    }
}

enum Output {
    static func emit(_ message: Message) {
        guard let data = try? JSONEncoder().encode(message),
            let line = String(data: data, encoding: .utf8)
        else {
            log("failed to encode a \(message.kind) message for \(message.requestId)")
            return
        }
        print(line)
        fflush(stdout)
    }

    static func progress(_ requestId: UUID, _ progress: Double, _ messageKey: String) {
        emit(Message(
            protocolVersion: protocolVersion, requestId: requestId, kind: "progress",
            progress: min(1, max(0, progress)), messageKey: messageKey
        ))
    }

    static func failure(_ requestId: UUID, _ error: any Error) {
        log("request \(requestId) failed: \(error)")
        emit(Message(
            protocolVersion: protocolVersion, requestId: requestId, kind: "result", ok: false,
            error: ErrorPayload(
                code: String(describing: type(of: error)),
                messageKey: "errors.localModels.runtimeFailed",
                recoverable: true
            )
        ))
    }

    /// Diagnostics go to stderr so stdout stays pure JSONL.
    static func log(_ text: String) {
        FileHandle.standardError.write(Data("memora-mlx-helper: \(text)\n".utf8))
    }
}

extension Duration {
    var milliseconds: Double {
        Double(components.seconds) * 1_000 + Double(components.attoseconds) / 1e15
    }
}

func elapsedMs(since start: ContinuousClock.Instant) -> Double {
    (start.duration(to: .now).milliseconds * 1_000).rounded() / 1_000
}
