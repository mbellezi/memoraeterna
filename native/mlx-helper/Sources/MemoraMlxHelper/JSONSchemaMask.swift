import Foundation
import MLX
import MLXLMCommon
import MemoraGrammar

/// One generation decoded under a grammar (F4 D24): the masker of `MemoraGrammar`, the token sampled
/// last, and the masks already turned into MLX arrays. Used by the token loop's thread only.
final class GrammarSession: @unchecked Sendable {
    private let grammar: Grammar
    private let vocabulary: TokenVocabulary
    private let maxTokens: Int
    private var stopTokens: Set<Int> = []
    private var masker: TokenMasker?
    /// The token sampled at the previous step, read (which waits for it) when the next mask is due.
    var pending: MLXArray?
    private var arrays: [Int: MLXArray] = [:]
    private var arrayOrder: [Int] = []
    private static let arrayCacheLimit = 32

    init(grammar: Grammar, vocabulary: TokenVocabulary, maxTokens: Int) {
        self.grammar = grammar
        self.vocabulary = vocabulary
        self.maxTokens = maxTokens
    }

    /// The tokens that end generation: allowed only once the root value is complete.
    func prepare(stopTokens: Set<Int>) {
        self.stopTokens = stopTokens
    }

    var statistics: TokenMasker.Statistics? { masker?.statistics }

    /// The logits with every token the grammar refuses at -infinity. The first call sizes the masker
    /// to the logits (the model's vocabulary can be wider than the tokenizer's).
    func constrain(_ logits: MLXArray) -> MLXArray {
        let width = logits.dim(-1)
        let masker =
            self.masker
            ?? TokenMasker(
                grammar: grammar, vocabulary: vocabulary, stopTokens: stopTokens, maskSize: width,
                maxTokens: maxTokens)
        self.masker = masker
        if let pending {
            masker.accept(pending.item(Int.self))
            self.pending = nil
        }
        let mask = masker.nextMask()
        if mask.allowsAll { return logits }
        return MLX.where(allowed(mask, width: width), logits, -Float.infinity)
    }

    private func allowed(_ mask: TokenMask, width: Int) -> MLXArray {
        if let known = arrays[mask.id] { return known }
        var flags = [Bool](repeating: false, count: width)
        for (index, word) in mask.words.enumerated() where word != 0 {
            var bits = word
            while bits != 0 {
                let token = index << 6 + bits.trailingZeroBitCount
                if token < width { flags[token] = true }
                bits &= bits - 1
            }
        }
        let array = MLXArray(flags, [1, width])
        if arrayOrder.count >= Self.arrayCacheLimit {
            arrays.removeValue(forKey: arrayOrder.removeFirst())
        }
        arrays[mask.id] = array
        arrayOrder.append(mask.id)
        return array
    }
}

/// The grammar's mask as a logit processor, after the penalty processor of the request's parameters
/// (a masked token stays at -infinity whatever the penalties do).
struct JSONSchemaMask: LogitProcessor {
    var penalty: LogitProcessor?
    let session: GrammarSession

    mutating func prompt(_ prompt: MLXArray) {
        penalty?.prompt(prompt)
    }

    func process(logits: MLXArray) -> MLXArray {
        session.constrain(penalty?.process(logits: logits) ?? logits)
    }

    mutating func didSample(token: MLXArray) {
        penalty?.didSample(token: token)
        session.pending = token
    }
}

/// The tokens the token loop stops on, as `generateTask` builds them: the model's end-of-sequence
/// ids, the tokenizer's, and the configuration's extra ones.
func stopTokenIds(_ context: ModelContext) -> Set<Int> {
    var ids = context.configuration.eosTokenIds
    if let eos = context.tokenizer.eosTokenId { ids.insert(eos) }
    for token in context.configuration.extraEOSTokens {
        if let id = context.tokenizer.convertTokenToId(token) { ids.insert(id) }
    }
    return ids
}

/// The byte-level vocabulary of a model directory's `tokenizer.json`, for its masks.
func loadGrammarVocabulary(modelPath: String) throws -> TokenVocabulary {
    let url = URL(filePath: modelPath).appending(path: "tokenizer.json")
    return try TokenVocabulary.byteLevel(tokenizerJSON: try Data(contentsOf: url))
}
