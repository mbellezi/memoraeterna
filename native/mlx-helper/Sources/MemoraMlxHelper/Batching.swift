import Foundation
import MLXLMCommon

/// Upper bound of padded tokens (batch size x longest sequence) evaluated in one forward pass.
let maxBatchTokens = 32_768

enum BatchPlan {
    /// Groups input indices into batches of similar length (longest first) so padding stays small.
    /// Every batch has at most `batchSize` inputs and at most `tokenBudget` padded tokens, except
    /// that a single input longer than the budget still forms its own batch.
    static func make(lengths: [Int], batchSize: Int, tokenBudget: Int = maxBatchTokens) -> [[Int]] {
        let order = lengths.indices.sorted {
            lengths[$0] != lengths[$1] ? lengths[$0] > lengths[$1] : $0 < $1
        }
        var batches: [[Int]] = []
        var current: [Int] = []
        var longest = 0
        for index in order {
            let length = lengths[index]
            let candidateLongest = max(longest, length)
            if !current.isEmpty
                && (current.count >= batchSize || (current.count + 1) * candidateLongest > tokenBudget)
            {
                batches.append(current)
                current = []
                longest = 0
            }
            current.append(index)
            longest = max(longest, length)
        }
        if !current.isEmpty { batches.append(current) }
        return batches
    }
}

enum Tokenization {
    /// Tokenizes `text` with the tokenizer's special tokens and keeps at most `limit` tokens.
    ///
    /// When truncation is needed the content is cut at the end while the special tokens the
    /// tokenizer adds around it (for example Qwen3-Embedding's trailing `<|endoftext|>` or BERT's
    /// `[CLS]`/`[SEP]`) are preserved, matching Hugging Face `truncation=True`.
    static func encode(_ tokenizer: any Tokenizer, _ text: String, limit: Int) -> (
        tokens: [Int], truncated: Bool
    ) {
        let full = tokenizer.encode(text: text, addSpecialTokens: true)
        if full.count <= limit { return (full, false) }
        let content = tokenizer.encode(text: text, addSpecialTokens: false)
        let extra = full.count - content.count
        if extra >= 0, extra < limit, let start = offset(of: content, in: full) {
            let prefix = Array(full[..<start])
            let suffix = Array(full[(start + content.count)...])
            let kept = content.prefix(limit - prefix.count - suffix.count)
            return (prefix + kept + suffix, true)
        }
        return (Array(full.prefix(limit)), true)
    }

    private static func offset(of content: [Int], in full: [Int]) -> Int? {
        guard content.count <= full.count else { return nil }
        for start in 0 ... (full.count - content.count)
        where full[start ..< (start + content.count)].elementsEqual(content) {
            return start
        }
        return nil
    }
}

func validateBatchOptions(maxTokens: Int, batchSize: Int, minimumTokens: Int) throws {
    guard maxTokens >= minimumTokens, maxTokens <= 131_072 else {
        throw HelperError.invalidRequest("maxTokens must be between \(minimumTokens) and 131072")
    }
    guard (1 ... 512).contains(batchSize) else {
        throw HelperError.invalidRequest("batchSize must be between 1 and 512")
    }
}
