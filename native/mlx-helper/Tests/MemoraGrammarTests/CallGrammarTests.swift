import Foundation
import XCTest

import MemoraGrammar

/// The grammars of one call (F4 D24, after T99's replay): the confirmation and typing contracts
/// narrowed to a call's own rows or pairs (`relationMatchCallSchema`, `relationTypingCallSchema`),
/// from the fixture the desktop's catalog test keeps equal to the emitter. Each row is written once,
/// in the order asked, under its own key, with one of its own candidates or null.
final class CallGrammarTests: XCTestCase {
    private func cases() throws -> [(name: String, schema: JSONValue, valid: [JSONValue], invalid: [JSONValue])] {
        try callSchemas().sorted { $0.key < $1.key }.map { name, entry in
            guard let schema = entry["schema"], case .array(let valid) = entry["valid"] ?? .null,
                case .array(let invalid) = entry["invalid"] ?? .null
            else { throw GrammarError.unsupported("fixture entry \(name)") }
            return (name, schema, valid, invalid)
        }
    }

    private func encoded(_ value: JSONValue, pretty: Bool) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = pretty ? [.prettyPrinted, .withoutEscapingSlashes] : [.withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    private func schema(_ name: String) throws -> String {
        guard let entry = try cases().first(where: { $0.name == name }) else {
            throw GrammarError.unsupported("no fixture \(name)")
        }
        return text(entry.schema)
    }

    func testEveryCallSchemaCompiles() throws {
        let all = try cases()
        XCTAssertEqual(all.map(\.name), [
            "entity_identity_call", "relation_identity_call_largest", "relation_typing_call",
        ])
        for entry in all {
            let grammar = try Grammar.compile(entry.schema)
            XCTAssertGreaterThan(grammar.minimumDocumentBytes, 2, entry.name)
        }
    }

    func testValidAnswersAreWritableCompactIndentedAndTokenByToken() throws {
        let tokens = try SyntheticVocabulary()
        for entry in try cases() {
            let schema = text(entry.schema)
            for answer in entry.valid {
                for pretty in [false, true] {
                    let document = try encoded(answer, pretty: pretty)
                    XCTAssertTrue(try accepts(schema, document), "\(entry.name): \(document)")
                }
                let compact = try encoded(answer, pretty: false)
                guard case .complete = try tokens.write(compact, schema: schema) else {
                    return XCTFail("\(entry.name): \(compact)")
                }
            }
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

    /// Cached and shortcut masks against the plain definition, along every valid answer.
    func testMasksMatchTheDefinitionAlongEveryAnswer() throws {
        let tokens = try SyntheticVocabulary()
        for entry in try cases() {
            let schema = text(entry.schema)
            let grammar = try Grammar.compile(entry.schema)
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
            }
        }
    }

    /// The row's key is the only one that can come next, and its candidate is one of its own or null.
    func testEachRowTakesItsOwnKeyAndCandidatesOnly() throws {
        let schema = try schema("entity_identity_call")
        let tokens = try SyntheticVocabulary()
        XCTAssertEqual(
            try tokens.write(#"{"matches":[["r1","c2"],["r2",null],["r3","r1"],["r4",null]]}"#, schema: schema),
            .complete(tokens: 29))
        // r1's candidates are c1 and c2: c3 is r2's.
        XCTAssertEqual(try tokens.write(#"{"matches":[["r1","c3"#, schema: schema), .refused(at: 20))
        // After r1 the next row is r2, and none may be skipped or closed early.
        XCTAssertEqual(try tokens.write(#"{"matches":[["r1",null],["r3""#, schema: schema), .refused(at: 27))
        XCTAssertEqual(try tokens.write(#"{"matches":[["r1",null]]"#, schema: schema), .refused(at: 23))
        // A row with no candidate answers null.
        XCTAssertEqual(
            try tokens.write(#"{"matches":[["r1",null],["r2",null],["r3",null],["r4","c1""#, schema: schema),
            .refused(at: 54))
        // An earlier row's key is a candidate where the row lists it.
        XCTAssertTrue(try accepts(schema, #"{"matches":[["r1",null],["r2",null],["r3","r1"],["r4",null]]}"#))
        XCTAssertFalse(try accepts(schema, #"{"matches":[["r1",null],["r2","r1"],["r3",null],["r4",null]]}"#))
    }

    /// The typing call: each asked pair once, in order, under its own id.
    func testTypingTakesTheAskedPairsInOrder() throws {
        let schema = try schema("relation_typing_call")
        XCTAssertTrue(try accepts(
            schema,
            #"{"pairs":[{"p":"p3","t":"none","d":"none"},{"p":"p7","t":"none","d":"none"},{"p":"p12","t":"none","d":"none"}]}"#))
        XCTAssertFalse(try accepts(
            schema,
            #"{"pairs":[{"p":"p3","t":"none","d":"none"},{"p":"p12","t":"none","d":"none"}]}"#))
        XCTAssertFalse(try accepts(schema, #"{"pairs":[{"p":"p7","t":"none","d":"none"}"#))
    }

    /// The largest call (the row cap, each row with the settings' largest candidate list) compiles
    /// with no blow-up. A guard only: `RealTokenizerTests` measures the cost against the replay's bar.
    func testTheLargestCallCompilesWithoutBlowUp() throws {
        let entry = try cases().first { $0.name == "relation_identity_call_largest" }!
        let started = Date()
        for _ in 0..<10 { _ = try Grammar.compile(entry.schema) }
        let seconds = Date().timeIntervalSince(started) / 10
        print(String(format: "largest call grammar: compile %.2f ms", seconds * 1_000))
        XCTAssertLessThan(seconds, 1)
    }
}
