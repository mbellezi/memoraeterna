import Foundation
import MLX
import MLXLLM
import MLXLMCommon
import MLXNN

/// Qwen3-Reranker prompt, exactly as its model card prescribes.
enum RerankerTemplate {
    static let prefix =
        "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query "
        + "and the Instruct provided. Note that the answer can only be \"yes\" or \"no\".<|im_end|>\n"
        + "<|im_start|>user\n"
    static let suffix = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
    static let defaultInstruction =
        "Given a web search query, retrieve relevant passages that answer the query"
    static let expectedYesTokenId = 9_693
    static let expectedNoTokenId = 2_152

    static func content(instruction: String, query: String, document: String) -> String {
        "<Instruct>: \(instruction)\n<Query>: \(query)\n<Document>: \(document)"
    }
}

private struct RerankerTokens: Sendable {
    let yes: Int
    let no: Int
    let prefix: [Int]
    let suffix: [Int]
    let pad: Int
}

private struct ScoreItem: Sendable {
    let instruction: String
    let query: String
    let document: String
}

private struct ScoreOutcome: Sendable {
    let scores: [Double]
    let logOdds: [Double]
    let tokenCounts: [Int]
    let truncated: [Bool]
    let tokenizeMs: Double
    let batches: [BatchTiming]
}

/// Keeps the most recently used reranker loaded across `score` requests.
final class ScorerCache {
    private var modelPath: String?
    private var container: ModelContainer?
    private var tokens: RerankerTokens?

    fileprivate func load(
        _ modelPath: String, requestId: UUID
    ) async throws -> (ModelContainer, RerankerTokens, loadMs: Double, cached: Bool) {
        if let container, let tokens, self.modelPath == modelPath {
            return (container, tokens, 0, true)
        }
        container = nil
        tokens = nil
        self.modelPath = nil
        Output.progress(requestId, 0.05, "localModels.progress.loading")
        let started = ContinuousClock.now
        let loaded = try await LLMModelFactory.shared.loadContainer(
            from: URL(filePath: modelPath), using: makeTokenizerLoader())
        let resolved = try await loaded.perform { context in
            guard context.model is MLXLLM.Qwen3Model else {
                throw HelperError.unsupportedArchitecture(
                    "score requires a Qwen3ForCausalLM reranker, got \(type(of: context.model))")
            }
            return try resolveTokens(context.tokenizer)
        }
        container = loaded
        tokens = resolved
        self.modelPath = modelPath
        return (loaded, resolved, elapsedMs(since: started), false)
    }
}

/// A pass-through KV "cache" that only supplies the attention mask and RoPE positions.
///
/// MLXLLM's Qwen3 builds its mask from the first layer cache and its RoPE positions from each
/// layer cache's `ropeOffset`. A cache that stores nothing, returns a left-padding mask and shifts
/// each row so its first real token sits at position 0 lets the stock model run a padded batch in
/// one forward pass with the same positions as an unpadded single-sequence pass.
private final class AttentionMaskCache: KVCache {
    private let mask: MLXFast.ScaledDotProductAttentionMaskMode
    let ropeOffset: RoPEOffset

    init(_ mask: MLXFast.ScaledDotProductAttentionMaskMode, ropeOffset: RoPEOffset) {
        self.mask = mask
        self.ropeOffset = ropeOffset
    }

    var offset: Int { 0 }
    var maxSize: Int? { nil }
    var state: [MLXArray] {
        get { [] }
        set {}
    }
    var metaState: [String] {
        get { [] }
        set {}
    }
    var isTrimmable: Bool { false }

    func update(keys: MLXArray, values: MLXArray) -> (MLXArray, MLXArray) { (keys, values) }
    func trim(_ n: Int) -> Int { 0 }
    func makeMask(
        n: Int, windowSize: Int?, returnArray: Bool
    ) -> MLXFast.ScaledDotProductAttentionMaskMode { mask }
    func copy() -> any KVCache { AttentionMaskCache(mask, ropeOffset: ropeOffset) }
    func innerState() -> [MLXArray] { [] }
}

enum Scorer {
    static let defaultMaxTokens = 8_192
    static let defaultBatchSize = 16

    /// `score`: Qwen3-Reranker relevance `softmax([logit_no, logit_yes])[1]` per document.
    static func score(_ request: Request, cache: ScorerCache) async throws {
        guard let modelPath = request.modelPath, !modelPath.isEmpty else {
            throw HelperError.invalidRequest("modelPath is required")
        }
        let items = try scoreItems(request)
        let maxTokens = request.maxTokens ?? defaultMaxTokens
        let batchSize = request.batchSize ?? defaultBatchSize
        try validateBatchOptions(maxTokens: maxTokens, batchSize: batchSize, minimumTokens: 64)
        let started = ContinuousClock.now
        let (container, tokens, loadMs, cached) = try await cache.load(
            modelPath, requestId: request.requestId)
        Output.progress(request.requestId, 0.1, "localModels.progress.scoring")
        let requestId = request.requestId
        let outcome = try await container.perform { context in
            try scoreBatches(
                context: context, tokens: tokens, items: items, maxTokens: maxTokens,
                batchSize: batchSize, requestId: requestId)
        }
        guard outcome.logOdds.allSatisfy(\.isFinite) else { throw HelperError.nonFiniteOutput }
        let inferenceMs = outcome.batches.reduce(0) { $0 + $1.ms }
        let totalMs = elapsedMs(since: started)
        Output.emit(Message(
            protocolVersion: protocolVersion, requestId: request.requestId, kind: "result",
            ok: true, durationMs: Int(totalMs.rounded()),
            inputTokens: outcome.tokenCounts.reduce(0, +),
            scores: outcome.scores, logOdds: outcome.logOdds,
            yesTokenId: tokens.yes, noTokenId: tokens.no,
            tokenCounts: outcome.tokenCounts, truncated: outcome.truncated,
            timing: Timing(
                loadMs: loadMs, modelCached: cached, tokenizeMs: outcome.tokenizeMs,
                inferenceMs: inferenceMs, perItemMs: inferenceMs / Double(items.count),
                totalMs: totalMs, batches: outcome.batches)
        ))
    }

    private static func scoreItems(_ request: Request) throws -> [ScoreItem] {
        let instruction = request.instruction ?? RerankerTemplate.defaultInstruction
        switch (request.documents, request.pairs) {
        case (let documents?, nil):
            guard let query = request.query else {
                throw HelperError.invalidRequest("query is required with documents")
            }
            guard !documents.isEmpty else {
                throw HelperError.invalidRequest("documents must not be empty")
            }
            return documents.map {
                ScoreItem(instruction: instruction, query: query, document: $0)
            }
        case (nil, let pairs?):
            guard request.query == nil else {
                throw HelperError.invalidRequest("query must not be combined with pairs")
            }
            guard !pairs.isEmpty else { throw HelperError.invalidRequest("pairs must not be empty") }
            return pairs.map {
                ScoreItem(
                    instruction: $0.instruction ?? instruction, query: $0.query, document: $0.document)
            }
        default:
            throw HelperError.invalidRequest("provide exactly one of documents or pairs")
        }
    }

    private static func scoreBatches(
        context: ModelContext, tokens: RerankerTokens, items: [ScoreItem], maxTokens: Int,
        batchSize: Int, requestId: UUID
    ) throws -> ScoreOutcome {
        guard let model = context.model as? MLXLLM.Qwen3Model else {
            throw HelperError.unsupportedArchitecture("score requires a Qwen3 reranker")
        }
        let project = try outputProjection(of: model)
        let contentBudget = maxTokens - tokens.prefix.count - tokens.suffix.count
        guard contentBudget > 0 else { throw HelperError.invalidRequest("maxTokens is too small") }

        let tokenizeStarted = ContinuousClock.now
        var sequences: [[Int]] = []
        var truncated: [Bool] = []
        for item in items {
            let text = RerankerTemplate.content(
                instruction: item.instruction, query: item.query, document: item.document)
            let content = context.tokenizer.encode(text: text, addSpecialTokens: false)
            truncated.append(content.count > contentBudget)
            sequences.append(tokens.prefix + content.prefix(contentBudget) + tokens.suffix)
        }
        let tokenizeMs = elapsedMs(since: tokenizeStarted)

        let layerCount = model.kvHeads.count
        var scores = [Double](repeating: 0, count: items.count)
        var logOdds = [Double](repeating: 0, count: items.count)
        var timings: [BatchTiming] = []
        let plan = BatchPlan.make(lengths: sequences.map(\.count), batchSize: batchSize)
        for (batchIndex, batch) in plan.enumerated() {
            let batchStarted = ContinuousClock.now
            let lengths = batch.map { sequences[$0].count }
            let width = lengths.max() ?? 0
            var flat: [Int32] = []
            flat.reserveCapacity(batch.count * width)
            for index in batch {
                let sequence = sequences[index]
                flat += Array(repeating: Int32(tokens.pad), count: width - sequence.count)
                flat += sequence.map { Int32($0) }
            }
            let inputs = MLXArray(flat, [batch.count, width])
            let maskCache =
                lengths.allSatisfy { $0 == width }
                ? AttentionMaskCache(.causal, ropeOffset: .scalar(0))
                : AttentionMaskCache(
                    .array(leftPaddingMask(lengths: lengths, width: width)),
                    ropeOffset: .batch(MLXArray(lengths.map { Int32($0 - width) })))
            let hidden = model.model(
                inputs, cache: Array(repeating: maskCache as any KVCache, count: layerCount))
            let lastHidden = hidden[0..., (width - 1)..., 0...]
            let logits = project(lastHidden).squeezed(axis: 1)
            let pair = stacked([logits[0..., tokens.no], logits[0..., tokens.yes]], axis: -1)
                .asType(.float32)
            eval(pair)
            let values = pair.asArray(Float.self)
            for (row, index) in batch.enumerated() {
                let margin = Double(values[row * 2 + 1]) - Double(values[row * 2])
                logOdds[index] = margin
                // softmax([logit_no, logit_yes])[1] == sigmoid(logit_yes - logit_no)
                scores[index] = 1 / (1 + exp(-margin))
            }
            timings.append(BatchTiming(
                size: batch.count, sequenceLength: width, ms: elapsedMs(since: batchStarted)))
            Output.progress(
                requestId, 0.1 + 0.9 * Double(batchIndex + 1) / Double(plan.count),
                "localModels.progress.scoring")
        }
        return ScoreOutcome(
            scores: scores, logOdds: logOdds, tokenCounts: sequences.map(\.count),
            truncated: truncated, tokenizeMs: tokenizeMs, batches: timings)
    }

    /// Causal attention restricted to real (non-padding) keys for a left-padded batch.
    /// Padding queries attend to themselves so no attention row is empty.
    private static func leftPaddingMask(lengths: [Int], width: Int) -> MLXArray {
        let positions = MLXArray(Int32(0) ..< Int32(width))
        let starts = MLXArray(lengths.map { Int32(width - $0) })
        let queries = positions.expandedDimensions(axis: 1)
        let keys = positions.expandedDimensions(axis: 0)
        let causal = queries .>= keys
        let diagonal = queries .== keys
        let realKey = (keys .>= starts.expandedDimensions(axis: 1)).expandedDimensions(axis: 1)
        return (causal & (realKey | diagonal)).expandedDimensions(axis: 1)
    }

    /// The LM head as a function of hidden states: `lm_head` when present, otherwise the tied
    /// input embedding (Qwen3-0.6B ties them).
    private static func outputProjection(
        of model: MLXLLM.Qwen3Model
    ) throws -> (MLXArray) -> MLXArray {
        let modules = model.namedModules()
        if let head = modules.first(where: { $0.0 == "lm_head" })?.1 as? Linear {
            return { head($0) }
        }
        if let embedding = modules.first(where: { $0.0 == "model.embed_tokens" })?.1 as? Embedding {
            return { embedding.asLinear($0) }
        }
        throw HelperError.unsupportedArchitecture("no output projection found")
    }
}

private func resolveTokens(_ tokenizer: any Tokenizer) throws -> RerankerTokens {
    guard let yes = tokenizer.convertTokenToId("yes"), let no = tokenizer.convertTokenToId("no")
    else {
        throw HelperError.tokenizerMismatch("the tokenizer has no 'yes'/'no' tokens")
    }
    guard yes == RerankerTemplate.expectedYesTokenId, no == RerankerTemplate.expectedNoTokenId
    else {
        throw HelperError.tokenizerMismatch("unexpected yes/no token ids \(yes)/\(no)")
    }
    let prefix = tokenizer.encode(text: RerankerTemplate.prefix, addSpecialTokens: false)
    let suffix = tokenizer.encode(text: RerankerTemplate.suffix, addSpecialTokens: false)
    guard let imStart = tokenizer.convertTokenToId("<|im_start|>"),
        let imEnd = tokenizer.convertTokenToId("<|im_end|>"),
        prefix.first == imStart, suffix.first == imEnd
    else {
        throw HelperError.tokenizerMismatch("chat special tokens are not parsed as single tokens")
    }
    let pad = tokenizer.convertTokenToId("<|endoftext|>") ?? tokenizer.eosTokenId ?? 0
    return RerankerTokens(yes: yes, no: no, prefix: prefix, suffix: suffix, pad: pad)
}
