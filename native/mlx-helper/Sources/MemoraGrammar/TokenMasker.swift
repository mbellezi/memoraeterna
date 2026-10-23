import Foundation

/// The tokens one decoding step may sample, as a bitset over the logits.
public final class TokenMask: @unchecked Sendable {
    /// Unique within its masker; the same mask object comes back for a cached state.
    public let id: Int
    /// Bit `t` of word `t / 64` allows token `t`.
    public let words: [UInt64]
    /// No constraint (the masker gave up after an unexpected token): leave the logits alone.
    public let allowsAll: Bool

    init(id: Int, words: [UInt64], allowsAll: Bool = false) {
        self.id = id
        self.words = words
        self.allowsAll = allowsAll
    }

    public func allows(_ token: Int) -> Bool {
        if allowsAll { return true }
        guard token >= 0, token >> 6 < words.count else { return false }
        return words[token >> 6] & (1 << UInt64(token & 63)) != 0
    }

    public var allowedCount: Int {
        words.reduce(0) { $0 + $1.nonzeroBitCount }
    }
}

/// One constrained generation: the grammar's state, the mask of each step, and what it cost.
///
/// Each step's mask is the set of tokens whose bytes the automaton accepts from the current state,
/// found by walking the token trie. Masks are cached per state signature for this call only (enums
/// and aliases differ per call, so nothing is shared across calls), and the cache is bounded. End of
/// sequence is allowed only once the root value is complete, and then nothing else is. A closing
/// reserve keeps the document completable within `maxTokens`: a token is allowed only if the fewest
/// bytes still needed after it fit in the tokens left (every byte is a token in a byte-level
/// vocabulary).
public final class TokenMasker: @unchecked Sendable {
    public struct Statistics: Sendable {
        /// Masks computed or served.
        public var steps = 0
        public var cacheHits = 0
        public var cacheMisses = 0
        /// Steps whose mask the closing reserve narrowed.
        public var reserveSteps = 0
        /// Steps with no grammatical token, answered with end of sequence (none expected).
        public var deadEnds = 0
        /// Sampled tokens the grammar refused; the masker stops constraining after one.
        public var violations = 0
        public var maskNanoseconds: UInt64 = 0
    }

    /// Bytes added to the closing reserve for the distances that are lower bounds (patterns with a
    /// minimum length, numbers with bounds).
    static let reserveMargin = 4

    public let grammar: Grammar
    public let vocabulary: TokenVocabulary
    private let stopTokens: [Int]
    private let wordCount: Int
    private let maxTokens: Int
    private let cacheLimit: Int
    private var cursor: GrammarCursor
    private var generated = 0
    private var finished = false
    private var broken = false
    private var nextId = 0
    private var cache: [[Int64]: (mask: TokenMask, maxDistance: Int)] = [:]
    private var stopMask: TokenMask?
    private var walkStack: [(end: Int32, mark: Int)] = []
    private var key: [Int64] = []
    /// Per pattern: the longest run of its characters one token writes.
    private let reaches: [Int32]
    public private(set) var statistics = Statistics()

    /// - Parameters:
    ///   - stopTokens: the tokens that end generation (end of sequence and its kin).
    ///   - maskSize: the logits' width; tokens at or past it are never allowed.
    ///   - maxTokens: the generation's token limit, for the closing reserve.
    ///   - cacheLimit: masks kept for this call before the cache is cleared.
    public init(
        grammar: Grammar, vocabulary: TokenVocabulary, stopTokens: Set<Int>, maskSize: Int,
        maxTokens: Int, cacheLimit: Int = 512
    ) {
        self.grammar = grammar
        self.vocabulary = vocabulary
        self.stopTokens = stopTokens.filter { $0 >= 0 && $0 < maskSize }.sorted()
        wordCount = (maskSize + 63) / 64
        self.maxTokens = maxTokens
        self.cacheLimit = cacheLimit
        cursor = GrammarCursor(grammar: grammar)
        reaches = grammar.patterns.indices.map {
            vocabulary.reach(pattern: grammar.patternSources[$0], alphabet: grammar.patterns[$0].alphabet)
        }
        key.reserveCapacity(64)
    }

    /// Whether the document is complete (only end of sequence may follow).
    public var isComplete: Bool { cursor.isComplete }

    /// Whether a sampled token broke the grammar and masks stopped.
    public var isBroken: Bool { broken }

    /// The mask of the next token.
    public func nextMask() -> TokenMask {
        let started = DispatchTime.now().uptimeNanoseconds
        defer {
            statistics.steps += 1
            statistics.maskNanoseconds += DispatchTime.now().uptimeNanoseconds - started
        }
        if broken { return TokenMask(id: -1, words: [], allowsAll: true) }
        if cursor.isComplete || finished { return stopOnly() }
        let remaining = maxTokens - generated
        let current = cursor.distance
        // Tokens left after this one must cover what the document still needs.
        let limit = max(remaining - 1 - Self.reserveMargin, current - 1)
        key.removeAll(keepingCapacity: true)
        let cacheable = cursor.signature(
            into: &key, maxTokenBytes: Int32(vocabulary.maxTokenBytes), reaches: reaches)
        if cacheable, let entry = cache[key], entry.maxDistance <= limit {
            statistics.cacheHits += 1
            return entry.mask
        }
        statistics.cacheMisses += 1
        var (words, maxDistance, narrowed) = compute(limit: limit, current: current)
        if !words.contains(where: { $0 != 0 }) {
            // The reserve's distances are lower bounds in a few states; without it there is always
            // a grammatical token.
            (words, maxDistance, narrowed) = compute(limit: Int.max, current: current)
            if !words.contains(where: { $0 != 0 }) {
                statistics.deadEnds += 1
                return stopOnly()
            }
        }
        if narrowed { statistics.reserveSteps += 1 }
        let mask = TokenMask(id: nextId, words: words)
        nextId += 1
        if cacheable, !narrowed {
            if cache.count >= cacheLimit { cache.removeAll(keepingCapacity: true) }
            cache[key] = (mask, maxDistance)
        }
        return mask
    }

    /// Advances past a sampled token. A stop token ends the document; a token the grammar refuses
    /// (which a mask never allows) stops the constraint.
    public func accept(_ token: Int) {
        generated += 1
        if broken || finished { return }
        if stopTokens.contains(token) {
            finished = true
            return
        }
        let mark = cursor.mark
        guard let bytes = vocabulary.bytes(of: token), cursor.step(bytes: bytes) else {
            cursor.rollback(to: mark)
            statistics.violations += 1
            broken = true
            return
        }
        cursor.commit()
    }

    private func stopOnly() -> TokenMask {
        if let stopMask { return stopMask }
        var words = [UInt64](repeating: 0, count: wordCount)
        for token in stopTokens { words[token >> 6] |= 1 << UInt64(token & 63) }
        let mask = TokenMask(id: nextId, words: words)
        nextId += 1
        stopMask = mask
        return mask
    }

    /// The allowed tokens under `limit`, the largest distance among them, and whether `limit` left
    /// out a grammatical token.
    private func compute(limit: Int, current: Int) -> ([UInt64], Int, Bool) {
        var words = [UInt64](repeating: 0, count: wordCount)
        var maxDistance = 0
        var narrowed = false
        let trie: TokenTrie
        if current <= limit, let room = cursor.plainStringRoom() {
            // Plain text that fits is always allowed and never moves the document further from its
            // end; only the other tokens need the walk.
            for index in 0..<min(words.count, vocabulary.plainWords.count) {
                words[index] = vocabulary.plainWords[index]
            }
            for entry in vocabulary.plainByUnits {
                guard entry.units > room else { break }
                let token = Int(entry.token)
                if token >> 6 < words.count { words[token >> 6] &= ~(1 << UInt64(token & 63)) }
            }
            maxDistance = current
            trie = vocabulary.specialTrie
        } else if let string = cursor.patternStringState(), grammar.patterns[string.pattern].isASCII,
            let entry = Optional(vocabulary.patternTokens(
                source: grammar.patternSources[string.pattern], machine: grammar.patterns[string.pattern],
                state: string.state)),
            current - string.remainder + max(string.missing, entry.maxDistance) + 1 <= limit
        {
            // The pattern's own characters, as cached for its state; only tokens that leave the
            // string (a quote) need the walk.
            for index in 0..<min(words.count, entry.words.count) { words[index] = entry.words[index] }
            for item in entry.byLength {
                guard item.length > string.room else { break }
                let token = Int(item.token)
                if token >> 6 < words.count { words[token >> 6] &= ~(1 << UInt64(token & 63)) }
            }
            maxDistance = current - string.remainder + max(string.missing, entry.maxDistance) + 1
            trie = vocabulary.specialTrie
        } else {
            trie = vocabulary.trie
        }
        walk(trie, limit: limit, words: &words, maxDistance: &maxDistance, narrowed: &narrowed)
        // A stop token ends generation, so it is allowed only once the document is complete.
        for token in stopTokens { words[token >> 6] &= ~(1 << UInt64(token & 63)) }
        return (words, maxDistance, narrowed)
    }

    private func walk(
        _ trie: TokenTrie, limit: Int, words: inout [UInt64], maxDistance: inout Int, narrowed: inout Bool
    ) {
        let base = cursor.mark
        walkStack.removeAll(keepingCapacity: true)
        let count = Int32(trie.count)
        var node: Int32 = 1
        while node < count {
            while let top = walkStack.last, node >= top.end {
                cursor.rollback(to: top.mark)
                walkStack.removeLast()
            }
            let mark = cursor.mark
            if cursor.step(trie.bytes[Int(node)]) {
                let first = trie.tokenStart[Int(node)]
                let last = trie.tokenEnd[Int(node)]
                if first < last {
                    let distance = cursor.distance
                    if distance <= limit {
                        maxDistance = max(maxDistance, distance)
                        for index in first..<last {
                            let token = Int(trie.tokenIds[Int(index)])
                            if token >> 6 < words.count { words[token >> 6] |= 1 << UInt64(token & 63) }
                        }
                    } else {
                        narrowed = true
                    }
                }
                walkStack.append((trie.end[Int(node)], mark))
                node += 1
            } else {
                cursor.rollback(to: mark)
                node = trie.end[Int(node)]
            }
        }
        cursor.rollback(to: base)
        walkStack.removeAll(keepingCapacity: true)
    }
}
