import Foundation

/// Why a tokenizer cannot be masked.
public enum VocabularyError: Error, Equatable, CustomStringConvertible {
    /// Not a byte-level BPE tokenizer (a SentencePiece or byte-fallback one, for example).
    case notByteLevel
    /// A token string outside the byte-level alphabet, or a malformed `tokenizer.json`.
    case malformed(String)
    /// Some single byte has no token, so some text could not be written.
    case missingByteTokens

    public var description: String {
        switch self {
        case .notByteLevel: "not a byte-level BPE tokenizer"
        case .malformed(let detail): "malformed tokenizer: \(detail)"
        case .missingByteTokens: "a single byte has no token"
        }
    }
}

/// The bytes each token writes, the token trie the masks walk, and the tokens that are plain string
/// text. Built once per model and shared by its calls.
public final class TokenVocabulary: @unchecked Sendable {
    /// Token ids covered: the largest id plus one.
    public let size: Int
    private let offsets: [Int32]
    private let storage: [UInt8]
    /// Every token a mask may allow.
    let trie: TokenTrie
    /// Allowed tokens that are not plain text (they hold `"`, `\`, a control byte, or a partial
    /// UTF-8 character): what a plain string state walks besides the plain set.
    let specialTrie: TokenTrie
    /// Tokens of complete UTF-8 characters without `"`, `\` or control bytes.
    let plainWords: [UInt64]
    /// Plain tokens by the UTF-16 units they write, most first: what a string close to its maximum
    /// length takes out of the plain set.
    let plainByUnits: [(units: Int32, token: Int32)]
    /// The most UTF-16 units a plain token writes.
    let maxPlainUnits: Int32
    /// The longest token, in bytes.
    public let maxTokenBytes: Int

    private let lock = NSLock()
    private var patternReach: [String: Int32] = [:]
    private var patternTokenSets: [String: PatternTokens] = [:]

    /// The tokens a string with an ASCII pattern takes from one state without leaving it: every byte
    /// a character of the pattern and the match still alive after each.
    final class PatternTokens: @unchecked Sendable {
        let words: [UInt64]
        /// Those tokens by length, longest first (ASCII: bytes are UTF-16 units).
        let byLength: [(length: Int32, token: Int32)]
        /// The largest distance to a match after one of them.
        let maxDistance: Int

        init(words: [UInt64], byLength: [(length: Int32, token: Int32)], maxDistance: Int) {
            self.words = words
            self.byLength = byLength
            self.maxDistance = maxDistance
        }
    }

    /// The tokens a pattern takes from `state`, cached per pattern source and NFA state set for the
    /// model's lifetime (the same pattern behaves the same in every call).
    func patternTokens(source: String, machine: PatternMachine, state: Int32) -> PatternTokens {
        let key = source + "\u{1}" + machine.stateKey(state).map(String.init).joined(separator: ",")
        lock.lock()
        defer { lock.unlock() }
        if let known = patternTokenSets[key] { return known }
        var words = [UInt64](repeating: 0, count: (size + 63) / 64)
        var byLength: [(length: Int32, token: Int32)] = []
        var maxDistance = 0
        var ends: [Int32] = []
        var states: [Int32] = [state]
        var node: Int32 = 1
        let count = Int32(trie.count)
        while node < count {
            while let end = ends.last, node >= end {
                ends.removeLast()
                states.removeLast()
            }
            let byte = trie.bytes[Int(node)]
            let next = byte < 0x80 && machine.alphabet[Int(byte)] ? machine.step(states[states.count - 1], UInt32(byte)) : -1
            guard next >= 0 else {
                node = trie.end[Int(node)]
                continue
            }
            let first = trie.tokenStart[Int(node)]
            let last = trie.tokenEnd[Int(node)]
            if first < last {
                maxDistance = max(maxDistance, machine.distance(next))
                for index in first..<last {
                    let token = trie.tokenIds[Int(index)]
                    words[Int(token) >> 6] |= 1 << UInt64(token & 63)
                    byLength.append((Int32(ends.count + 1), token))
                }
            }
            ends.append(trie.end[Int(node)])
            states.append(next)
            node += 1
        }
        byLength.sort { $0.length > $1.length }
        let entry = PatternTokens(words: words, byLength: byLength, maxDistance: maxDistance)
        patternTokenSets[key] = entry
        return entry
    }

    /// A vocabulary of token byte strings by id. Ids left out (special and added tokens) are never
    /// allowed by a mask.
    public convenience init(tokens: [Int: [UInt8]], size: Int? = nil) throws {
        let size = size ?? ((tokens.keys.max() ?? -1) + 1)
        var storage: [UInt8] = []
        var spans = [(start: Int32, end: Int32)](repeating: (0, 0), count: size)
        for (id, bytes) in tokens where id >= 0 && id < size {
            let start = Int32(storage.count)
            storage.append(contentsOf: bytes)
            spans[id] = (start, Int32(storage.count))
        }
        try self.init(storage: storage, spans: spans)
    }

    /// `spans[id]` is the token's range in `storage`; an empty range leaves the id out.
    init(storage: [UInt8], spans: [(start: Int32, end: Int32)]) throws {
        size = spans.count
        // Contiguous offsets by id, so a token's bytes are one slice.
        var ordered: [UInt8] = []
        ordered.reserveCapacity(storage.count)
        var offsets = [Int32](repeating: 0, count: size + 1)
        for id in 0..<size {
            offsets[id] = Int32(ordered.count)
            let span = spans[id]
            if span.end > span.start { ordered.append(contentsOf: storage[Int(span.start)..<Int(span.end)]) }
        }
        offsets[size] = Int32(ordered.count)
        self.offsets = offsets
        self.storage = ordered

        var singles = [Bool](repeating: false, count: 256)
        var all: [Int32] = []
        var special: [Int32] = []
        var plain = [UInt64](repeating: 0, count: (size + 63) / 64)
        var byUnits: [(units: Int32, token: Int32)] = []
        var maxUnits: Int32 = 0
        var maxBytes = 0
        all.reserveCapacity(size)
        byUnits.reserveCapacity(size)
        for id in 0..<size {
            let start = Int(offsets[id])
            let end = Int(offsets[id + 1])
            guard end > start else { continue }
            all.append(Int32(id))
            maxBytes = max(maxBytes, end - start)
            if end - start == 1 { singles[Int(ordered[start])] = true }
            if let units = Self.plainUnits(ordered[start..<end]) {
                plain[id >> 6] |= 1 << UInt64(id & 63)
                byUnits.append((units, Int32(id)))
                maxUnits = max(maxUnits, units)
            } else {
                special.append(Int32(id))
            }
        }
        guard !singles.contains(false) else { throw VocabularyError.missingByteTokens }
        plainWords = plain
        plainByUnits = byUnits.sorted { $0.units > $1.units }
        maxPlainUnits = maxUnits
        maxTokenBytes = maxBytes
        trie = TokenTrie(storage: ordered, offsets: offsets, tokens: all)
        specialTrie = TokenTrie(storage: ordered, offsets: offsets, tokens: special)
    }

    /// The bytes of a token, or nil for a token no mask allows.
    public func bytes(of token: Int) -> ArraySlice<UInt8>? {
        guard token >= 0, token < size else { return nil }
        let start = Int(offsets[token])
        let end = Int(offsets[token + 1])
        return end > start ? storage[start..<end] : nil
    }

    /// The most bytes any token writes before leaving `alphabet`: how far one token can extend a
    /// string whose pattern only takes those bytes. Cached per pattern for the model's lifetime.
    func reach(pattern source: String, alphabet: [Bool]) -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        if let known = patternReach[source] { return known }
        var ends: [Int32] = []
        var node: Int32 = 1
        var best = 0
        let count = Int32(trie.count)
        while node < count {
            while let end = ends.last, node >= end { ends.removeLast() }
            if alphabet[Int(trie.bytes[Int(node)])] {
                ends.append(trie.end[Int(node)])
                best = max(best, ends.count)
                node += 1
            } else {
                node = trie.end[Int(node)]
            }
        }
        patternReach[source] = Int32(best)
        return Int32(best)
    }

    /// UTF-16 units of a token that is plain string text, or nil when it is not.
    static func plainUnits(_ bytes: ArraySlice<UInt8>) -> Int32? {
        var units: Int32 = 0
        var index = bytes.startIndex
        while index < bytes.endIndex {
            let byte = bytes[index]
            if byte < 0x80 {
                if byte < 0x20 || byte == UInt8(ascii: "\"") || byte == UInt8(ascii: "\\") { return nil }
                units += 1
                index += 1
                continue
            }
            guard let continuations = UTF8Facts.continuationCount(lead: byte),
                index + continuations < bytes.endIndex
            else { return nil }
            var bits = UTF8Facts.leadBits(byte, continuations: continuations)
            for offset in 1...continuations {
                let next = bytes[index + offset]
                guard next & 0xC0 == 0x80 else { return nil }
                bits = (bits << 6) | UInt32(next & 0x3F)
            }
            let range = UTF8Facts.scalarRange(length: continuations + 1)
            guard range.contains(bits), !(0xD800...0xDFFF).contains(bits) else { return nil }
            units += UTF8Facts.utf16Units(length: continuations + 1)
            index += continuations + 1
        }
        return units
    }

    // MARK: Byte-level BPE

    /// GPT-2's byte-to-character map, inverted: for each character a byte-level BPE vocabulary
    /// writes (all below U+0144), the byte it stands for; -1 for any other character.
    static let byteLevelTable: [Int16] = {
        var bytes: [Int] = Array(33...126) + Array(161...172) + Array(174...255)
        var characters = bytes
        var extra = 0
        for byte in 0..<256 where !bytes.contains(byte) {
            bytes.append(byte)
            characters.append(256 + extra)
            extra += 1
        }
        var table = [Int16](repeating: -1, count: 324)
        for (byte, character) in zip(bytes, characters) { table[character] = Int16(byte) }
        return table
    }()

    /// The vocabulary of a Hugging Face `tokenizer.json` with a byte-level BPE model (the Qwen
    /// writers). Added tokens (special or not: `<|im_end|>`, `<think>`, ...) are left out.
    public static func byteLevel(tokenizerJSON data: Data) throws -> TokenVocabulary {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? NSDictionary,
            let model = root["model"] as? NSDictionary
        else { throw VocabularyError.malformed("no model") }
        guard (model["type"] as? String) == "BPE", isByteLevel(root["decoder"]) else {
            throw VocabularyError.notByteLevel
        }
        guard let vocab = model["vocab"] as? NSDictionary else {
            throw VocabularyError.malformed("no vocab")
        }
        var excluded = Set<Int>()
        var largest = -1
        for case let token as NSDictionary in root["added_tokens"] as? NSArray ?? [] {
            guard let id = (token["id"] as? NSNumber)?.intValue else { continue }
            excluded.insert(id)
            largest = max(largest, id)
        }
        var storage: [UInt8] = []
        storage.reserveCapacity(vocab.count * 8)
        var entries: [(id: Int, start: Int32, end: Int32)] = []
        entries.reserveCapacity(vocab.count)
        var units = [unichar](repeating: 0, count: 1_024)
        var failure: VocabularyError?
        let table = byteLevelTable
        vocab.enumerateKeysAndObjects { key, value, stop in
            guard let text = key as? NSString, let id = (value as? NSNumber)?.intValue, id >= 0 else {
                failure = .malformed("token")
                stop.pointee = true
                return
            }
            largest = max(largest, id)
            if excluded.contains(id) { return }
            let length = text.length
            if length > units.count { units = [unichar](repeating: 0, count: length) }
            text.getCharacters(&units, range: NSRange(location: 0, length: length))
            let start = Int32(storage.count)
            for index in 0..<length {
                let character = Int(units[index])
                guard character < table.count, table[character] >= 0 else {
                    failure = .notByteLevel
                    stop.pointee = true
                    return
                }
                storage.append(UInt8(table[character]))
            }
            entries.append((id, start, Int32(storage.count)))
        }
        if let failure { throw failure }
        var spans = [(start: Int32, end: Int32)](repeating: (0, 0), count: largest + 1)
        for entry in entries { spans[entry.id] = (entry.start, entry.end) }
        return try TokenVocabulary(storage: storage, spans: spans)
    }

    private static func isByteLevel(_ decoder: Any?) -> Bool {
        guard let decoder = decoder as? NSDictionary else { return false }
        if (decoder["type"] as? String) == "ByteLevel" { return true }
        if (decoder["type"] as? String) == "Sequence", let parts = decoder["decoders"] as? NSArray {
            return parts.contains { isByteLevel($0) }
        }
        return false
    }
}

/// The tokens' byte strings as a trie in preorder: node `i`'s subtree is `i..<end[i]`, so a walk
/// skips a refused prefix with all its extensions in one step.
struct TokenTrie: Sendable {
    /// Node 0 is the root (no byte).
    private(set) var bytes: [UInt8] = [0]
    private(set) var end: [Int32] = [0]
    private(set) var tokenStart: [Int32] = [0]
    private(set) var tokenEnd: [Int32] = [0]
    private(set) var tokenIds: [Int32] = []

    var count: Int { bytes.count }

    init(storage: [UInt8], offsets: [Int32], tokens: [Int32]) {
        let sorted = storage.withUnsafeBufferPointer { base -> [Int32] in
            tokens.sorted { left, right in
                let leftStart = Int(offsets[Int(left)])
                let leftLength = Int(offsets[Int(left) + 1]) - leftStart
                let rightStart = Int(offsets[Int(right)])
                let rightLength = Int(offsets[Int(right) + 1]) - rightStart
                let order = memcmp(
                    base.baseAddress! + leftStart, base.baseAddress! + rightStart,
                    min(leftLength, rightLength))
                if order != 0 { return order < 0 }
                if leftLength != rightLength { return leftLength < rightLength }
                return left < right
            }
        }
        bytes.reserveCapacity(sorted.count * 4)
        var path: [Int32] = [0]
        var previousStart = 0
        var previousLength = 0
        for token in sorted {
            let start = Int(offsets[Int(token)])
            let length = Int(offsets[Int(token) + 1]) - start
            var common = 0
            let limit = min(length, previousLength)
            while common < limit, storage[previousStart + common] == storage[start + common] {
                common += 1
            }
            while path.count - 1 > common {
                end[Int(path.removeLast())] = Int32(bytes.count)
            }
            for offset in common..<length {
                let node = Int32(bytes.count)
                bytes.append(storage[start + offset])
                end.append(0)
                tokenStart.append(Int32(tokenIds.count))
                tokenEnd.append(Int32(tokenIds.count))
                path.append(node)
            }
            let leaf = Int(path[path.count - 1])
            if tokenEnd[leaf] == tokenStart[leaf] { tokenStart[leaf] = Int32(tokenIds.count) }
            tokenIds.append(token)
            tokenEnd[leaf] = Int32(tokenIds.count)
            previousStart = start
            previousLength = length
        }
        while let node = path.popLast() { end[Int(node)] = Int32(bytes.count) }
    }
}
