import Foundation
import XCTest

import MemoraGrammar

/// The schemas the host emits for every catalog contract (the fixture the desktop's catalog test
/// keeps equal to `toGrammarJsonSchema`), with answers Zod accepts and answers it refuses for their
/// shape.
final class CatalogTests: XCTestCase {
    private func encoded(_ value: JSONValue, pretty: Bool) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = pretty ? [.prettyPrinted, .withoutEscapingSlashes] : [.withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    private func cases() throws -> [(name: String, schema: JSONValue, valid: [JSONValue], invalid: [JSONValue])] {
        try catalogSchemas().sorted { $0.key < $1.key }.map { name, entry in
            guard let schema = entry["schema"], case .array(let valid) = entry["valid"] ?? .null,
                case .array(let invalid) = entry["invalid"] ?? .null
            else { throw GrammarError.unsupported("fixture entry \(name)") }
            return (name, schema, valid, invalid)
        }
    }

    func testEveryCatalogContractCompiles() throws {
        let all = try cases()
        XCTAssertEqual(all.map(\.name), [
            "atomic_notes", "entity_identity", "knowledge_graph", "relation_typing", "topic_areas",
            "topic_naming", "topic_overview", "topic_overview_patch",
        ])
        for entry in all {
            let grammar = try Grammar.compile(entry.schema)
            XCTAssertGreaterThan(grammar.minimumDocumentBytes, 2, entry.name)
        }
    }

    func testValidAnswersAreWritableCompactAndIndented() throws {
        for entry in try cases() {
            let schema = text(entry.schema)
            for answer in entry.valid {
                for pretty in [false, true] {
                    let document = try encoded(answer, pretty: pretty)
                    XCTAssertTrue(try accepts(schema, document), "\(entry.name): \(document)")
                }
            }
        }
    }

    func testValidAnswersAreWritableTokenByToken() throws {
        let tokens = try SyntheticVocabulary()
        for entry in try cases() {
            for answer in entry.valid {
                let document = try encoded(answer, pretty: false)
                guard case .complete = try tokens.write(document, schema: text(entry.schema)) else {
                    return XCTFail("\(entry.name): \(document)")
                }
            }
        }
    }

    /// Cached and shortcut masks against the plain definition: a token is allowed when its bytes
    /// step from the state the text so far reached.
    func testMasksMatchTheDefinitionAlongEveryAnswer() throws {
        let tokens = try SyntheticVocabulary()
        for entry in try cases() {
            let schema = text(entry.schema)
            let grammar = try Grammar.compile(entry.schema)
            var hits = 0
            for answer in entry.valid {
                let document = Array(try encoded(answer, pretty: true).utf8)
                let masker = try tokens.masker(schema)
                var state = GrammarCursor(grammar: grammar)
                var offset = 0
                while offset < document.count {
                    let mask = masker.nextMask()
                    for id in 0..<tokens.stopToken {
                        var probe = state
                        let allowed = probe.step(bytes: tokens.vocabulary.bytes(of: id)!)
                        if mask.allows(id) != allowed {
                            return XCTFail("\(entry.name) at \(offset): token \(id) \(allowed)")
                        }
                    }
                    let next = tokens.byBytes.first { candidate in
                        mask.allows(candidate.id) && offset + candidate.bytes.count <= document.count
                            && Array(document[offset..<offset + candidate.bytes.count]) == candidate.bytes
                    }!
                    masker.accept(next.id)
                    XCTAssertTrue(state.step(bytes: next.bytes))
                    state.commit()
                    offset += next.bytes.count
                }
                hits += masker.statistics.cacheHits
            }
            XCTAssertGreaterThan(hits, 0, entry.name)
        }
    }

    func testAnswersOfTheWrongShapeAreNot() throws {
        for entry in try cases() {
            for answer in entry.invalid {
                let document = try encoded(answer, pretty: false)
                XCTAssertFalse(try accepts(text(entry.schema), document), "\(entry.name): \(document)")
            }
        }
    }
}
