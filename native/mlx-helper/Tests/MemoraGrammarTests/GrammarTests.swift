import Foundation
import XCTest

import MemoraGrammar

final class GrammarTests: XCTestCase {
    private var tokens: SyntheticVocabulary!

    override func setUpWithError() throws {
        tokens = try SyntheticVocabulary()
    }

    // MARK: Enums and literals

    private let typing = """
        {"type":"object","properties":{"pairs":{"type":"array","items":{"type":"object","properties":{
        "p":{"type":"string","enum":["p1","p2","p12"]},
        "t":{"type":"string","enum":["supports","depends_on","none"]},
        "d":{"type":"string","enum":["ab","ba","both","none"]}},
        "required":["p","t","d"],"additionalProperties":false}}},
        "required":["pairs"],"additionalProperties":false}
        """

    func testEnumsAcceptTheirValuesOnly() throws {
        XCTAssertEqual(
            try tokens.write(#"{"pairs":[{"p":"p1","t":"supports","d":"ab"},{"d":"none","p":"p12","t":"none"}]}"#, schema: typing),
            .complete(tokens: 32))
        XCTAssertEqual(try tokens.write(#"{"pairs":[{"p":"p3""#, schema: typing), .refused(at: 17))
        XCTAssertEqual(try tokens.write(#"{"pairs":[{"p":"p1","t":"depends""#, schema: typing), .refused(at: 32))
        // A required member cannot be left out, and none is written twice.
        XCTAssertEqual(try tokens.write(#"{"pairs":[{"p":"p1","t":"none"}"#, schema: typing), .refused(at: 30))
        XCTAssertEqual(try tokens.write(#"{"pairs":[{"p":"p1","p""#, schema: typing), .refused(at: 21))
        // Members the schema does not name are never written.
        XCTAssertEqual(try tokens.write(#"{"pairs":[],"notes""#, schema: typing), .refused(at: 11))
    }

    func testLiteralPrefixesWaitForTheNextByte() throws {
        let schema = #"{"type":"array","items":{"enum":[1,12,true,null]}}"#
        XCTAssertTrue(try accepts(schema, "[1,12,true,null,1]"))
        XCTAssertFalse(try accepts(schema, "[2]"))
        XCTAssertFalse(try accepts(schema, "[121]"))
        XCTAssertFalse(try accepts(schema, "[nul]"))
    }

    // MARK: Tuples

    private let confirmation = """
        {"type":"object","properties":{"matches":{"type":"array","maxItems":2,"items":{"type":"array",
        "prefixItems":[{"type":"string"},{"anyOf":[{"type":"string"},{"type":"null"}]}],
        "items":false,"minItems":2,"maxItems":2}}},"required":["matches"],"additionalProperties":false}
        """

    func testTuplesFollowPrefixItems() throws {
        XCTAssertEqual(
            try tokens.write(#"{"matches":[["r1","c2"],["r2",null]]}"#, schema: confirmation),
            .complete(tokens: 16))
        XCTAssertEqual(try tokens.write(#"{"matches":[["r1"]"#, schema: confirmation), .refused(at: 17))
        XCTAssertEqual(try tokens.write(#"{"matches":[["r1",null,"#, schema: confirmation), .refused(at: 22))
        XCTAssertEqual(try tokens.write(#"{"matches":[[null"#, schema: confirmation), .refused(at: 13))
        // maxItems of the outer list.
        XCTAssertEqual(
            try tokens.write(#"{"matches":[["a",null],["b",null],"#, schema: confirmation), .refused(at: 33))
    }

    // MARK: Patterns

    private let predicate = #"{"type":"string","minLength":1,"maxLength":12,"pattern":"^[a-z]+(?:_[a-z]+)*$"}"#

    func testPatternsConstrainStringContent() throws {
        XCTAssertTrue(try accepts(predicate, #""depends_on""#))
        XCTAssertFalse(try accepts(predicate, #""Depends""#))
        XCTAssertFalse(try accepts(predicate, #""a__b""#))
        XCTAssertFalse(try accepts(predicate, #""a_""#))
        XCTAssertFalse(try accepts(predicate, #""""#))
        XCTAssertFalse(try accepts(predicate, #""abcdefghijklm""#), "maxLength still applies")
        // No escape inside a pattern string, even one that would decode to an allowed character.
        XCTAssertFalse(try accepts(predicate, "\"\\u0061\""))
        XCTAssertEqual(try tokens.write(#""depends_on""#, schema: predicate), .complete(tokens: 3))
        XCTAssertEqual(try tokens.write(#""depends_"#, schema: predicate), .incomplete)
    }

    func testUnanchoredPatternsSearch() throws {
        let schema = #"{"type":"string","pattern":"\\d{2}"}"#
        XCTAssertTrue(try accepts(schema, #""ab12cd""#))
        XCTAssertFalse(try accepts(schema, #""ab1cd""#))
    }

    func testStableIdPatternAndUnsupportedPatterns() throws {
        let stable = #"{"type":"string","minLength":1,"pattern":"^[A-Za-z0-9][A-Za-z0-9:_-]*$"}"#
        XCTAssertTrue(try accepts(stable, #""E12""#))
        XCTAssertTrue(try accepts(stable, #""chunk:9_a-b""#))
        XCTAssertFalse(try accepts(stable, #""-x""#))
        XCTAssertFalse(try accepts(stable, #""a b""#))
        for pattern in [#"(?=a)b"#, #"(a)\\1"#, #"\\bword"#, #"a^b"#] {
            XCTAssertThrowsError(try Grammar.compile(try JSONValue.parse(#"{"type":"string","pattern":"\#(pattern)"}"#)))
        }
    }

    func testPatternsMatchUnicodeAcrossPartialTokens() throws {
        let schema = #"{"type":"string","pattern":"^[\\u4e00-\\u9fff]+$"}"#
        // 中 is E4 B8 AD: written as a partial token, then the rest with a stray letter that is cut.
        XCTAssertTrue(try acceptsBytes(schema, [0x22, 0xE4, 0xB8, 0xAD, 0x22]))
        XCTAssertFalse(try acceptsBytes(schema, [0x22, 0xC3, 0xA9, 0x22]), "é is outside the class")
        // A lead byte whose characters all fall outside the class is refused at once.
        let grammar = try Grammar.compile(try JSONValue.parse(schema))
        var cursor = GrammarCursor(grammar: grammar)
        XCTAssertTrue(cursor.step(0x22))
        XCTAssertFalse(cursor.step(0xC3))
    }

    // MARK: UTF-8 and escapes

    func testStringsHoldValidUTF8AndEscapes() throws {
        let schema = #"{"type":"string"}"#
        XCTAssertTrue(try accepts(schema, "\"café 中文 😀\""))
        XCTAssertTrue(try accepts(schema, "\"line\\nbreak \\\"quoted\\\" \\u00e9 \\/\""))
        XCTAssertFalse(try acceptsBytes(schema, [0x22, 0xC3, 0x41, 0x22]), "missing continuation")
        XCTAssertFalse(try acceptsBytes(schema, [0x22, 0xC0, 0x80, 0x22]), "overlong")
        XCTAssertFalse(try acceptsBytes(schema, [0x22, 0xED, 0xA0, 0x80, 0x22]), "encoded surrogate")
        XCTAssertFalse(try acceptsBytes(schema, [0x22, 0x0A, 0x22]), "raw control byte")
        XCTAssertFalse(try accepts(schema, "\"\\ud83d\\ude00\""), "surrogate escapes")
        XCTAssertFalse(try accepts(schema, #""\x""#))
        // Tokens that end inside a character: the next token must complete it.
        XCTAssertEqual(try tokens.write("\"中\"", schema: schema), .complete(tokens: 4))
        XCTAssertEqual(try tokens.write("\"😀\"", schema: schema), .complete(tokens: 3))
    }

    func testLengthsCountUTF16UnitsAsZod() throws {
        let schema = #"{"type":"string","minLength":2,"maxLength":3}"#
        XCTAssertTrue(try accepts(schema, "\"é😀\""), "1 + 2 units")
        XCTAssertFalse(try accepts(schema, "\"ab😀\""), "4 units")
        XCTAssertFalse(try accepts(schema, "\"😀😀\""))
        XCTAssertTrue(try accepts(schema, #""\n\t""#))
        XCTAssertFalse(try accepts(schema, "\"a\""))
    }

    // MARK: Numbers

    func testNumberRangesRefuseEarly() throws {
        let schema = #"{"type":"array","items":{"type":"number","minimum":0,"maximum":1}}"#
        XCTAssertTrue(try accepts(schema, "[0,1,0.85,1.0,0.5,-0]"))
        XCTAssertFalse(try accepts(schema, "[1.5]"))
        XCTAssertFalse(try accepts(schema, "[2]"))
        XCTAssertFalse(try accepts(schema, "[-0.1]"))
        XCTAssertFalse(try accepts(schema, "[1e0]"), "no exponent where bounds apply")
        XCTAssertFalse(try accepts(schema, "[01]"))
        // `2` is refused as soon as it is written, so no dead end follows.
        let grammar = try Grammar.compile(try JSONValue.parse(schema))
        var cursor = GrammarCursor(grammar: grammar)
        XCTAssertTrue(cursor.step(bytes: Array("[1".utf8)))
        XCTAssertFalse(cursor.step(UInt8(ascii: "2")))
    }

    func testIntegersAndExclusiveBounds() throws {
        let schema = #"{"type":"array","items":{"type":"integer","exclusiveMinimum":0,"maximum":20}}"#
        XCTAssertTrue(try accepts(schema, "[1,20,9]"))
        XCTAssertFalse(try accepts(schema, "[0]"))
        XCTAssertFalse(try accepts(schema, "[21]"))
        XCTAssertFalse(try accepts(schema, "[1.5]"))
        XCTAssertTrue(try accepts(#"{"type":"number"}"#, "-12.5e+3"))
        XCTAssertThrowsError(try Grammar.compile(try JSONValue.parse(#"{"type":"integer","minimum":0.2,"maximum":0.8}"#)))
    }

    // MARK: Objects, unions and any

    func testOptionalMembersMayBeLeftOut() throws {
        let schema = """
            {"type":"object","properties":{"title":{"type":"string","minLength":1},
            "language":{"type":"string","enum":["en","pt-BR"]}},"required":["title"]}
            """
        XCTAssertTrue(try accepts(schema, #"{"title":"a"}"#))
        XCTAssertTrue(try accepts(schema, #"{ "language" : "en" , "title" : "a" }"#))
        XCTAssertFalse(try accepts(schema, #"{"language":"en"}"#))
        XCTAssertFalse(try accepts(schema, #"{"title":"a",}"#))
        XCTAssertFalse(try accepts(schema, #"{"title":""}"#))
    }

    func testObjectUnionsKeepTheAlternativesApart() throws {
        let areas = """
            {"type":"object","properties":{"areas":{"type":"array","items":{"anyOf":[
            {"type":"object","properties":{"alias":{"type":"string","minLength":1},"members":{"type":"array","items":{"type":"string","minLength":1}}},"required":["alias","members"]},
            {"type":"object","properties":{"new":{"type":"object","properties":{"title":{"type":"string","minLength":1},"description":{"type":"string","minLength":1}},"required":["title","description"]},"members":{"type":"array","items":{"type":"string","minLength":1}}},"required":["new","members"]}]}}},"required":["areas"]}
            """
        XCTAssertTrue(try accepts(areas, #"{"areas":[{"alias":"a1","members":["n1"]},{"members":[],"new":{"title":"T","description":"D"}}]}"#))
        XCTAssertFalse(try accepts(areas, #"{"areas":[{"alias":"a1","new":{"title":"T","description":"D"},"members":[]}]}"#))
        XCTAssertFalse(try accepts(areas, #"{"areas":[{"members":[]}]}"#))
        let mixed = #"{"type":"array","items":{"anyOf":[{"type":"number"},{"type":"string"},{"type":"null"},{"type":"boolean"}]}}"#
        XCTAssertTrue(try accepts(mixed, #"[1,"a",null,true,false,-2.5]"#))
        XCTAssertFalse(try accepts(mixed, #"[{}]"#))
    }

    func testAnyValuesAreAnyJSON() throws {
        XCTAssertTrue(try accepts("{}", #"{"a":[1,{"b":null,"c":"d"}],"e":true}"#))
        XCTAssertTrue(try accepts(#"{"type":"object","properties":{"meta":{}},"required":["meta"]}"#, #"{"meta":[[],{}]}"#))
        XCTAssertFalse(try accepts("{}", #"{"a":}"#))
    }

    func testWhitespaceIsBounded() throws {
        let schema = #"{"type":"object","properties":{"a":{"type":"null"}},"required":["a"]}"#
        XCTAssertTrue(try accepts(schema, "{\n  \"a\": null\n}"))
        XCTAssertFalse(try accepts(schema, " {\"a\":null}"), "no whitespace before the root")
        XCTAssertFalse(try accepts(schema, "{\"a\":null}\n"), "nothing after the root")
        let long = String(repeating: " ", count: Int(Grammar.maxWhitespace) + 1)
        XCTAssertFalse(try accepts(schema, "{\(long)\"a\":null}"))
    }

    func testUnsupportedSchemasAreRefused() throws {
        for schema in [
            #"{"allOf":[{"type":"string"}]}"#, ##"{"$ref":"#/$defs/a"}"##, #"{"type":"string","enum":[]}"#,
            #"{"type":"array","minItems":3,"maxItems":2}"#, #"{"type":"object","required":["x"]}"#,
            #"{"anyOf":[{"type":"array","items":{"type":"string"}},{"type":"array","items":{"type":"number"}}]}"#,
        ] {
            XCTAssertThrowsError(try Grammar.compile(try JSONValue.parse(schema)), schema)
        }
    }

    // MARK: Masks

    func testEndOfSequenceOnlyAfterTheRootCloses() throws {
        let masker = try tokens.masker(#"{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}"#)
        for text in ["{\"", "a", "\":", "\"", "x", "\"}"] {
            let mask = masker.nextMask()
            XCTAssertFalse(mask.allows(tokens.stopToken))
            let token = tokens.byBytes.first { $0.bytes == Array(text.utf8) }!.id
            XCTAssertTrue(mask.allows(token), text)
            masker.accept(token)
        }
        let last = masker.nextMask()
        XCTAssertTrue(masker.isComplete)
        XCTAssertEqual(last.allowedCount, 1)
        XCTAssertTrue(last.allows(tokens.stopToken))
    }

    func testClosingReserveFinishesWithinMaxTokens() throws {
        let schema = """
            {"type":"object","properties":{"notes":{"type":"array","minItems":1,"items":{"type":"object",
            "properties":{"title":{"type":"string","minLength":1},"text":{"type":"string"}},
            "required":["title","text"]}}},"required":["notes"]}
            """
        for maxTokens in [40, 64, 200] {
            let masker = try tokens.masker(schema, maxTokens: maxTokens)
            let (text, stopped) = tokens.runaway(masker, prefer: Array("aaaaaaaa".utf8), maxTokens: maxTokens)
            XCTAssertTrue(masker.isComplete, "\(maxTokens): \(String(decoding: text, as: UTF8.self))")
            XCTAssertTrue(stopped || masker.statistics.steps >= maxTokens)
            XCTAssertNotNil(try? JSONSerialization.jsonObject(with: Data(text)))
            XCTAssertGreaterThan(masker.statistics.reserveSteps, 0)
        }
    }

    func testMasksAreCachedPerStateAndTheCacheIsBounded() throws {
        let schema = #"{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}"#
        let body = "{\"text\":\"" + String(repeating: "hello world ", count: 20) + "\"}"
        let cached = try tokens.masker(schema)
        XCTAssertEqual(tokens.write(Array(body.utf8), with: cached), .complete(tokens: 64))
        XCTAssertGreaterThan(cached.statistics.cacheHits, 30)
        let small = try tokens.masker(schema, cacheLimit: 2)
        XCTAssertEqual(tokens.write(Array(body.utf8), with: small), .complete(tokens: 64))
        XCTAssertLessThanOrEqual(small.statistics.cacheHits, cached.statistics.cacheHits)
        XCTAssertEqual(small.statistics.deadEnds, 0)
    }

    func testARefusedTokenStopsTheConstraint() throws {
        let masker = try tokens.masker(#"{"type":"null"}"#)
        let brace = tokens.byBytes.first { $0.bytes == [UInt8(ascii: "{")] }!.id
        XCTAssertFalse(masker.nextMask().allows(brace))
        masker.accept(brace)
        XCTAssertTrue(masker.isBroken)
        XCTAssertTrue(masker.nextMask().allowsAll)
        XCTAssertEqual(masker.statistics.violations, 1)
    }

    func testPlainStringMasksMatchTheFullWalk() throws {
        // The plain-text shortcut must allow exactly what walking every token allows, also close to
        // a maximum length.
        for schema in [
            #"{"type":"array","items":{"type":"string","minLength":1}}"#,
            #"{"type":"array","items":{"type":"string","minLength":1,"maxLength":4}}"#,
        ] {
            let shortcut = try tokens.masker(schema)
            for token in [Array("[\"".utf8), Array("a".utf8)] {
                let id = tokens.byBytes.first { $0.bytes == token }!.id
                _ = shortcut.nextMask()
                shortcut.accept(id)
            }
            let fast = shortcut.nextMask()
            let grammar = try Grammar.compile(try JSONValue.parse(schema))
            for id in 0..<tokens.stopToken {
                var cursor = GrammarCursor(grammar: grammar)
                let ok =
                    cursor.step(bytes: Array("[\"a".utf8))
                    && cursor.step(bytes: tokens.vocabulary.bytes(of: id)!)
                XCTAssertEqual(fast.allows(id), ok, "token \(id) \(Array(tokens.vocabulary.bytes(of: id)!))")
            }
        }
    }

    // MARK: Vocabulary

    func testByteLevelTokenizerJSON() throws {
        // GPT-2's map writes a space as Ġ (U+0120) and a newline as Ċ (U+010A).
        var vocab: [String: Int] = [:]
        var bytes: [Int] = Array(33...126) + Array(161...172) + Array(174...255)
        var characters = bytes
        var extra = 0
        for byte in 0..<256 where !bytes.contains(byte) {
            bytes.append(byte)
            characters.append(256 + extra)
            extra += 1
        }
        for (index, character) in characters.enumerated() {
            vocab[String(UnicodeScalar(UInt32(character))!)] = index
        }
        vocab["\u{0120}hello"] = 256
        vocab["\u{010A}\u{010A}"] = 257
        let tokenizer: [String: Any] = [
            "model": ["type": "BPE", "vocab": vocab],
            "decoder": ["type": "ByteLevel"],
            "added_tokens": [["id": 258, "content": "<|im_end|>", "special": true],
                             ["id": 259, "content": "<think>", "special": false]],
        ]
        let vocabulary = try TokenVocabulary.byteLevel(
            tokenizerJSON: try JSONSerialization.data(withJSONObject: tokenizer))
        XCTAssertEqual(vocabulary.size, 260)
        XCTAssertEqual(vocabulary.bytes(of: 256).map(Array.init), Array(" hello".utf8))
        XCTAssertEqual(vocabulary.bytes(of: 257).map(Array.init), [0x0A, 0x0A])
        XCTAssertNil(vocabulary.bytes(of: 258))
        XCTAssertNil(vocabulary.bytes(of: 259))
        XCTAssertEqual(vocabulary.bytes(of: Int(characters.firstIndex(of: 0x0120)!)).map(Array.init), [0x20])

        var sentencePiece = tokenizer
        sentencePiece["decoder"] = ["type": "Sequence", "decoders": [["type": "ByteFallback"]]]
        XCTAssertThrowsError(try TokenVocabulary.byteLevel(
            tokenizerJSON: try JSONSerialization.data(withJSONObject: sentencePiece))) { error in
            XCTAssertEqual(error as? VocabularyError, .notByteLevel)
        }
        var missing = vocab
        missing.removeValue(forKey: "a")
        var partial = tokenizer
        partial["model"] = ["type": "BPE", "vocab": missing]
        XCTAssertThrowsError(try TokenVocabulary.byteLevel(
            tokenizerJSON: try JSONSerialization.data(withJSONObject: partial))) { error in
            XCTAssertEqual(error as? VocabularyError, .missingByteTokens)
        }
    }
}
