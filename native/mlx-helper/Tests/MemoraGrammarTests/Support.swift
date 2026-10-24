import Foundation
import XCTest

import MemoraGrammar

/// A synthetic byte-level vocabulary: every single byte, then multi-byte tokens chosen to cross the
/// automaton's boundaries (a quote with what follows it, partial UTF-8 characters, whole literals).
/// The stop token is the id after the last one and is not a vocabulary token, like an added
/// `<|im_end|>`.
struct SyntheticVocabulary {
    static let pieces: [[UInt8]] = {
        let texts = [
            "{\"", "\"}", "\":", "\",", "\":\"", "\",\"", "\"]", "\"],", "\"]}", "]}", "}]", "},{\"",
            "[\"", "[[\"", "\"],[\"", "\"]]", "\"]]}", "null", "true", "false", "nu", "ll",
            "p1", "p2", "p12", "supports", "depends_on", "depends", "_on", "ab", "both", "none",
            "pairs", "matches", "notes", "title", "language", "en", "pt-BR", "alias", "members", "new",
            "description", "areas", "text", "citations", "paragraphs", "evidenceChunkIds",
            "0.", "0.8", "85", "1.", "12", "-", "-0", ".5", "1e", "e5",
            "\\n", "\\\"", "\\u00e9", "\\ud83d", "\n", "\n  ", "  ", " \"", ": ", ", ",
            "hello", " world", "abc", "aaaa", "aaaaaaaa", "\"a", "a\"", "é", "café", "😀",
            "\u{4E2D}\u{6587}",
        ]
        var pieces = texts.map { Array($0.utf8) }
        // Partial UTF-8: a lead with one continuation of a 3-byte character, and a lone continuation.
        pieces.append([0xE4, 0xB8])
        pieces.append([0xAD, 0x61])
        pieces.append([0xF0, 0x9F])
        pieces.append([0x98, 0x80])
        return pieces
    }()

    let vocabulary: TokenVocabulary
    let stopToken: Int
    let maskSize: Int
    /// Token ids by their bytes, longest first, for greedy tokenization.
    let byBytes: [(bytes: [UInt8], id: Int)]

    init() throws {
        var tokens: [Int: [UInt8]] = [:]
        for byte in 0..<256 { tokens[byte] = [UInt8(byte)] }
        for (offset, piece) in Self.pieces.enumerated() { tokens[256 + offset] = piece }
        stopToken = 256 + Self.pieces.count
        maskSize = stopToken + 1
        vocabulary = try TokenVocabulary(tokens: tokens, size: stopToken)
        byBytes = tokens.map { ($0.value, $0.key) }.sorted { $0.bytes.count > $1.bytes.count }
    }

    func masker(_ schema: String, maxTokens: Int = 100_000, cacheLimit: Int = 512) throws -> TokenMasker {
        let grammar = try Grammar.compile(try JSONValue.parse(schema))
        return TokenMasker(
            grammar: grammar, vocabulary: vocabulary, stopTokens: [stopToken], maskSize: maskSize,
            maxTokens: maxTokens, cacheLimit: cacheLimit)
    }

    enum Outcome: Equatable {
        /// The whole text was written and only the stop token may follow.
        case complete(tokens: Int)
        /// The text was written but the document is not complete.
        case incomplete
        /// No allowed token continues the text at this byte offset.
        case refused(at: Int)
    }

    /// Writes `text` as a model whose favourite next tokens spell it would: at each step the longest
    /// allowed token that continues the text.
    func write(_ text: String, schema: String, maxTokens: Int = 100_000) throws -> Outcome {
        let masker = try masker(schema, maxTokens: maxTokens)
        return write(Array(text.utf8), with: masker)
    }

    func write(_ bytes: [UInt8], with masker: TokenMasker) -> Outcome {
        var offset = 0
        var tokens = 0
        while offset < bytes.count {
            let mask = masker.nextMask()
            XCTAssertFalse(mask.allows(stopToken), "stop allowed before the end at \(offset)")
            guard
                let token = byBytes.first(where: { candidate in
                    mask.allows(candidate.id) && offset + candidate.bytes.count <= bytes.count
                        && Array(bytes[offset..<offset + candidate.bytes.count]) == candidate.bytes
                })
            else { return .refused(at: offset) }
            masker.accept(token.id)
            offset += token.bytes.count
            tokens += 1
        }
        let last = masker.nextMask()
        guard masker.isComplete else { return .incomplete }
        XCTAssertTrue(last.allows(stopToken))
        XCTAssertEqual(last.allowedCount, 1, "only the stop token after the root closes")
        return .complete(tokens: tokens)
    }

    /// A model that always prefers the same bytes when the mask lets it (a runaway string), else the
    /// lowest allowed token: generates until the stop token or `maxTokens`.
    func runaway(_ masker: TokenMasker, prefer: [UInt8], maxTokens: Int) -> (text: [UInt8], stopped: Bool) {
        var text: [UInt8] = []
        for _ in 0..<maxTokens {
            let mask = masker.nextMask()
            if mask.allows(stopToken) {
                return (text, true)
            }
            let token =
                byBytes.first(where: { $0.bytes == prefer && mask.allows($0.id) })?.id
                ?? (0..<maskSize).first(where: { mask.allows($0) })!
            masker.accept(token)
            text.append(contentsOf: vocabulary.bytes(of: token)!)
        }
        return (text, false)
    }
}

/// Steps raw bytes through a fresh cursor: whether the grammar accepts them as a whole document.
func accepts(_ schema: String, _ text: String) throws -> Bool {
    let grammar = try Grammar.compile(try JSONValue.parse(schema))
    var cursor = GrammarCursor(grammar: grammar)
    return cursor.step(bytes: Array(text.utf8)) && cursor.isComplete
}

func acceptsBytes(_ schema: String, _ bytes: [UInt8]) throws -> Bool {
    let grammar = try Grammar.compile(try JSONValue.parse(schema))
    var cursor = GrammarCursor(grammar: grammar)
    return cursor.step(bytes: bytes) && cursor.isComplete
}

/// The schemas the host's grammar emitter sends for the catalog contracts (`toGrammarJsonSchema`),
/// checked in by the desktop's catalog test.
func catalogSchemas() throws -> [String: JSONValue] {
    try fixtureSchemas("catalog-grammar-schemas.json")
}

/// The schemas of single calls (the confirmation and typing contracts narrowed to one call's rows or
/// pairs), checked in by the same test.
func callSchemas() throws -> [String: JSONValue] {
    try fixtureSchemas("call-grammar-schemas.json")
}

private func fixtureSchemas(_ file: String) throws -> [String: JSONValue] {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures/\(file)")
    guard case .object(let schemas) = try JSONValue.parse(try Data(contentsOf: url)) else {
        throw GrammarError.unsupported("fixture \(file)")
    }
    return schemas
}

func text(_ value: JSONValue) -> String {
    String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
}
