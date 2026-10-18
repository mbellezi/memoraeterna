import Foundation

let protocolVersion = 1

/// What this helper adds to protocol 1, announced in `health`: `cancel {requestId}` stops a running
/// request (checked per generated token and per scoring batch), `unload {slot}` drops one slot's
/// model, and `generate {stream: true}` emits the text as `delta` lines. A host falls back to
/// killing the helper when a capability is missing (an older build).
let helperCapabilities = ["cancel", "stream", "unload"]

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
/// `score` add optional top-level fields that older commands ignore. `cancel` names the request it
/// stops by that request's `requestId` and gets no answer of its own: the stopped request answers.
struct Request: Codable {
    let protocolVersion: Int
    let requestId: UUID
    let command: String
    let modelPath: String?
    let prompt: String?
    let parameters: GenerationParameters?
    // generate: emit `delta` lines with the text as it is generated
    let stream: Bool?
    // unload: `generate`, `embed` or `score`
    let slot: String?
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

/// The fields the stdin reader looks at before it hands a line to the worker.
struct RequestEnvelope: Decodable {
    let protocolVersion: Int?
    let requestId: UUID?
    let command: String?
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
/// messages are byte-for-byte the shape they had before `embed` and `score` existed (`health` adds
/// `capabilities`).
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
    // health
    var capabilities: [String]? = nil
    // generate with `stream`: a piece of the generated text
    var delta: String? = nil
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
    /// The host cancelled the request (`cancel {requestId}`); loaded models stay.
    case cancelled

    var description: String {
        switch self {
        case .invalidRequest(let detail): "invalid request: \(detail)"
        case .unsupportedCommand: "unsupported command"
        case .unsupportedProtocol: "unsupported protocol version"
        case .unsupportedArchitecture(let detail): "unsupported model architecture: \(detail)"
        case .tokenizerMismatch(let detail): "tokenizer mismatch: \(detail)"
        case .nonFiniteOutput: "the model produced a non-finite value"
        case .cancelled: "cancelled"
        }
    }

    var isCancellation: Bool {
        if case .cancelled = self { return true }
        return false
    }
}

enum Output {
    /// Lines are written one at a time, whichever task writes them.
    private static let lock = NSLock()

    static func emit(_ message: Message) {
        guard let data = try? JSONEncoder().encode(message),
            let line = String(data: data, encoding: .utf8)
        else {
            log("failed to encode a \(message.kind) message for \(message.requestId)")
            return
        }
        lock.lock()
        defer { lock.unlock() }
        print(line)
        fflush(stdout)
    }

    static func progress(_ requestId: UUID, _ progress: Double, _ messageKey: String) {
        emit(Message(
            protocolVersion: protocolVersion, requestId: requestId, kind: "progress",
            progress: min(1, max(0, progress)), messageKey: messageKey
        ))
    }

    /// A piece of streamed generated text; an empty piece is not sent.
    static func delta(_ requestId: UUID, _ text: String) {
        guard !text.isEmpty else { return }
        emit(Message(
            protocolVersion: protocolVersion, requestId: requestId, kind: "delta", delta: text
        ))
    }

    static func failure(_ requestId: UUID, _ error: any Error) {
        let cancelled = (error as? HelperError)?.isCancellation ?? false
        log(cancelled ? "request \(requestId) was cancelled" : "request \(requestId) failed: \(error)")
        emit(Message(
            protocolVersion: protocolVersion, requestId: requestId, kind: "result", ok: false,
            error: ErrorPayload(
                code: cancelled ? "cancelled" : String(describing: type(of: error)),
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

/// Requests the stdin reader handed to the worker and that have not finished, and which of them the
/// host cancelled. The reader runs on its own thread while the worker generates or scores, so a
/// `cancel` is read at once; the token loop and the scoring loop check it, and a registered handler
/// (a generation task's `cancel`) runs as soon as it arrives. A cancel for a request that already
/// finished, or that was never received, is ignored.
final class CancellationRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = Set<UUID>()
    private var cancelled = Set<UUID>()
    private var handlers: [UUID: @Sendable () -> Void] = [:]

    func received(_ requestId: UUID) {
        lock.lock()
        defer { lock.unlock() }
        pending.insert(requestId)
    }

    func cancel(_ requestId: UUID) {
        lock.lock()
        guard pending.contains(requestId) else {
            lock.unlock()
            return
        }
        cancelled.insert(requestId)
        let handler = handlers.removeValue(forKey: requestId)
        lock.unlock()
        handler?()
    }

    func isCancelled(_ requestId: UUID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled.contains(requestId)
    }

    func throwIfCancelled(_ requestId: UUID) throws {
        if isCancelled(requestId) { throw HelperError.cancelled }
    }

    /// Runs `handler` when the request is cancelled, at once if it already was.
    func onCancel(_ requestId: UUID, _ handler: @escaping @Sendable () -> Void) {
        lock.lock()
        if cancelled.contains(requestId) {
            lock.unlock()
            handler()
            return
        }
        handlers[requestId] = handler
        lock.unlock()
    }

    func finished(_ requestId: UUID) {
        lock.lock()
        defer { lock.unlock() }
        pending.remove(requestId)
        cancelled.remove(requestId)
        handlers.removeValue(forKey: requestId)
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
