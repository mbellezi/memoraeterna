import Foundation
import MLX
import MLXEmbedders
import MLXLMCommon

/// Keeps the most recently used embedding model loaded across `embed` requests.
final class EmbedderCache {
    private var modelPath: String?
    private var container: EmbedderModelContainer?

    func container(
        for modelPath: String, requestId: UUID
    ) async throws -> (EmbedderModelContainer, loadMs: Double, cached: Bool) {
        if let container, self.modelPath == modelPath { return (container, 0, true) }
        container = nil
        self.modelPath = nil
        Output.progress(requestId, 0.05, "localModels.progress.loading")
        let started = ContinuousClock.now
        let loaded = try await EmbedderModelFactory.shared.loadContainer(
            from: URL(filePath: modelPath), using: makeTokenizerLoader()
        )
        container = loaded
        self.modelPath = modelPath
        return (loaded, elapsedMs(since: started), false)
    }
}

private struct EmbedOutcome: Sendable {
    let vectors: [[Float]]
    let tokenCounts: [Int]
    let truncated: [Bool]
    let tokenizeMs: Double
    let batches: [BatchTiming]
    let pooling: String
}

enum Embedder {
    static let defaultMaxTokens = 8_192
    static let defaultBatchSize = 16

    /// `embed`: pooled (and by default L2-normalized) sentence embeddings for `texts`.
    ///
    /// Inputs are tokenized with the model tokenizer's special tokens, right-padded, and pooled with
    /// the strategy from `1_Pooling/config.json` or the model's own default (last token for Qwen3,
    /// which attends causally so right padding never reaches a real token). Texts are passed through
    /// unchanged: query instructions are the caller's responsibility.
    static func embed(_ request: Request, cache: EmbedderCache) async throws {
        guard let modelPath = request.modelPath, !modelPath.isEmpty else {
            throw HelperError.invalidRequest("modelPath is required")
        }
        guard let texts = request.texts, !texts.isEmpty else {
            throw HelperError.invalidRequest("texts must not be empty")
        }
        let maxTokens = request.maxTokens ?? defaultMaxTokens
        let batchSize = request.batchSize ?? defaultBatchSize
        let normalize = request.normalize ?? true
        try validateBatchOptions(maxTokens: maxTokens, batchSize: batchSize, minimumTokens: 2)
        if let dimensions = request.dimensions, dimensions < 1 {
            throw HelperError.invalidRequest("dimensions must be positive")
        }
        let started = ContinuousClock.now
        let (container, loadMs, cached) = try await cache.container(
            for: modelPath, requestId: request.requestId)
        Output.progress(request.requestId, 0.1, "localModels.progress.embedding")
        let requestId = request.requestId
        let requestedDimensions = request.dimensions
        let outcome = try await container.perform { context in
            try embedBatches(
                context: context, texts: texts, maxTokens: maxTokens, batchSize: batchSize,
                normalize: normalize, dimensions: requestedDimensions, requestId: requestId)
        }
        guard outcome.vectors.allSatisfy({ $0.allSatisfy(\.isFinite) }) else {
            throw HelperError.nonFiniteOutput
        }
        let inferenceMs = outcome.batches.reduce(0) { $0 + $1.ms }
        let totalMs = elapsedMs(since: started)
        Output.emit(Message(
            protocolVersion: protocolVersion, requestId: request.requestId, kind: "result",
            ok: true, durationMs: Int(totalMs.rounded()),
            inputTokens: outcome.tokenCounts.reduce(0, +),
            embeddings: outcome.vectors, dimensions: outcome.vectors.first?.count ?? 0,
            normalized: normalize, pooling: outcome.pooling,
            tokenCounts: outcome.tokenCounts, truncated: outcome.truncated,
            timing: Timing(
                loadMs: loadMs, modelCached: cached, tokenizeMs: outcome.tokenizeMs,
                inferenceMs: inferenceMs, perItemMs: inferenceMs / Double(texts.count),
                totalMs: totalMs, batches: outcome.batches)
        ))
    }

    private static func embedBatches(
        context: EmbedderModelContext, texts: [String], maxTokens: Int, batchSize: Int,
        normalize: Bool, dimensions: Int?, requestId: UUID
    ) throws -> EmbedOutcome {
        let tokenizer = context.tokenizer
        let model = context.model
        var limit = maxTokens
        if let positions = model.maxPositionEmbeddings { limit = min(limit, positions) }

        let tokenizeStarted = ContinuousClock.now
        var sequences: [[Int]] = []
        var truncated: [Bool] = []
        for text in texts {
            let encoded = Tokenization.encode(tokenizer, text, limit: limit)
            guard !encoded.tokens.isEmpty else {
                throw HelperError.invalidRequest("a text produced no tokens")
            }
            sequences.append(encoded.tokens)
            truncated.append(encoded.truncated)
        }
        let tokenizeMs = elapsedMs(since: tokenizeStarted)

        let padToken = tokenizer.eosTokenId ?? 0
        let strategy = context.pooling.strategy
        var vectors = [[Float]](repeating: [], count: texts.count)
        var timings: [BatchTiming] = []
        let plan = BatchPlan.make(lengths: sequences.map(\.count), batchSize: batchSize)
        for (batchIndex, batch) in plan.enumerated() {
            let batchStarted = ContinuousClock.now
            let lengths = batch.map { sequences[$0].count }
            let width = lengths.max() ?? 0
            var tokens: [Int32] = []
            var mask: [Int32] = []
            tokens.reserveCapacity(batch.count * width)
            mask.reserveCapacity(batch.count * width)
            for index in batch {
                let sequence = sequences[index]
                let padding = width - sequence.count
                tokens += sequence.map { Int32($0) } + Array(repeating: Int32(padToken), count: padding)
                mask += Array(repeating: 1, count: sequence.count) + Array(repeating: 0, count: padding)
            }
            let inputs = MLXArray(tokens, [batch.count, width])
            let attentionMask = MLXArray(mask, [batch.count, width])
            let output = model(
                inputs, positionIds: nil, tokenTypeIds: MLXArray.zeros(like: inputs),
                attentionMask: attentionMask)
            var pooled = try pool(output, strategy: strategy, lengths: lengths, mask: attentionMask)
                .asType(.float32)
            if let configured = context.pooling.dimension, configured < pooled.dim(-1) {
                pooled = pooled[0..., 0 ..< configured]
            }
            if let dimensions {
                guard dimensions <= pooled.dim(-1) else {
                    throw HelperError.invalidRequest(
                        "dimensions exceeds the model dimension \(pooled.dim(-1))")
                }
                pooled = pooled[0..., 0 ..< dimensions]
            }
            if normalize {
                let norms = sqrt((pooled * pooled).sum(axis: -1, keepDims: true))
                pooled = pooled / maximum(norms, MLXArray(Float(1e-12)))
            }
            eval(pooled)
            let dimension = pooled.dim(-1)
            let flat = pooled.asArray(Float.self)
            for (row, index) in batch.enumerated() {
                vectors[index] = Array(flat[(row * dimension) ..< ((row + 1) * dimension)])
            }
            timings.append(BatchTiming(
                size: batch.count, sequenceLength: width, ms: elapsedMs(since: batchStarted)))
            Output.progress(
                requestId, 0.1 + 0.9 * Double(batchIndex + 1) / Double(plan.count),
                "localModels.progress.embedding")
        }
        return EmbedOutcome(
            vectors: vectors, tokenCounts: sequences.map(\.count), truncated: truncated,
            tokenizeMs: tokenizeMs, batches: timings, pooling: name(of: strategy))
    }

    /// Sentence-transformers pooling over right-padded hidden states.
    private static func pool(
        _ output: EmbeddingModelOutput, strategy: Pooling.Strategy, lengths: [Int], mask: MLXArray
    ) throws -> MLXArray {
        if strategy == .none {
            guard let pooled = output.pooledOutput ?? output.hiddenStates else {
                throw HelperError.unsupportedArchitecture("the model returned no hidden states")
            }
            return pooled
        }
        guard let hidden = output.hiddenStates else {
            throw HelperError.unsupportedArchitecture("the model returned no hidden states")
        }
        switch strategy {
        case .last:
            let last = MLXArray(lengths.map { Int32($0 - 1) }).reshaped(lengths.count, 1, 1)
            return takeAlong(hidden, last, axis: 1).squeezed(axis: 1)
        case .cls, .first:
            // sentence-transformers CLS pooling is the first token's hidden state (no pooler head).
            return hidden[0..., 0, 0...]
        case .mean:
            let weights = mask.asType(.float32).expandedDimensions(axis: -1)
            return (hidden.asType(.float32) * weights).sum(axis: 1) / weights.sum(axis: 1)
        case .max:
            let valid = mask.expandedDimensions(axis: -1) .> 0
            return which(valid, hidden.asType(.float32), MLXArray(-Float.infinity)).max(axis: 1)
        case .none:
            return hidden
        }
    }

    private static func name(of strategy: Pooling.Strategy) -> String {
        switch strategy {
        case .mean: "mean"
        case .cls: "cls"
        case .first: "first"
        case .last: "last"
        case .max: "max"
        case .none: "none"
        }
    }
}
