import Foundation
import XCTest

import MemoraGrammar

/// What the grammar costs on a real vocabulary, without a model: `MEMORA_GRAMMAR_TOKENIZER` names a
/// byte-level `tokenizer.json` (the Qwen writer's). Skipped otherwise. Prints the vocabulary load,
/// the compile time per call (schema plus masker, p50 and p95) and the mask time per token while
/// writing each catalog contract's and each single call's valid answers, the inputs of the replay
/// bars (compile ≤100 ms p95; decode ≥0.85× the unconstrained tok/s is measured with the model).
final class RealTokenizerTests: XCTestCase {
    func testCompileAndMaskCostOnARealTokenizer() throws {
        guard let path = ProcessInfo.processInfo.environment["MEMORA_GRAMMAR_TOKENIZER"] else {
            throw XCTSkip("Set MEMORA_GRAMMAR_TOKENIZER to a byte-level tokenizer.json.")
        }
        let loadStarted = Date()
        let vocabulary = try TokenVocabulary.byteLevel(
            tokenizerJSON: try Data(contentsOf: URL(fileURLWithPath: path)))
        let loadMs = Date().timeIntervalSince(loadStarted) * 1_000
        var byBytes: [[UInt8]: Int] = [:]
        for id in 0..<vocabulary.size {
            if let bytes = vocabulary.bytes(of: id) { byBytes[Array(bytes)] = byBytes[Array(bytes)] ?? id }
        }
        let stop = vocabulary.size
        let maskSize = vocabulary.size + 1
        print(String(format: "vocabulary: %d tokens, longest %d bytes, loaded in %.0f ms",
            vocabulary.size, vocabulary.maxTokenBytes, loadMs))

        var allCompile: [Double] = []
        // The catalog contracts, then the single calls' grammars (the confirmation and typing calls).
        let schemas = try catalogSchemas().sorted(by: { $0.key < $1.key })
            + callSchemas().sorted(by: { $0.key < $1.key })
        for (name, entry) in schemas {
            guard let schema = entry["schema"], case .array(let valid) = entry["valid"] ?? .null else {
                return XCTFail(name)
            }
            var compile: [Double] = []
            for _ in 0..<40 {
                let started = DispatchTime.now().uptimeNanoseconds
                let grammar = try Grammar.compile(schema)
                _ = TokenMasker(
                    grammar: grammar, vocabulary: vocabulary, stopTokens: [stop], maskSize: maskSize,
                    maxTokens: 4_096)
                compile.append(Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6)
            }
            allCompile.append(contentsOf: compile)
            var steps = 0
            var maskNanoseconds: UInt64 = 0
            var hits = 0
            var misses = 0
            var stepTimes: [Double] = []
            for answer in valid {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.withoutEscapingSlashes]
                let text = Array(try encoder.encode(answer))
                let masker = TokenMasker(
                    grammar: try Grammar.compile(schema), vocabulary: vocabulary, stopTokens: [stop],
                    maskSize: maskSize, maxTokens: 4_096)
                var offset = 0
                while offset < text.count {
                    let before = masker.statistics.maskNanoseconds
                    let mask = masker.nextMask()
                    stepTimes.append(Double(masker.statistics.maskNanoseconds - before) / 1e3)
                    var chosen: (id: Int, length: Int)?
                    for length in stride(from: min(vocabulary.maxTokenBytes, text.count - offset), through: 1, by: -1) {
                        if let id = byBytes[Array(text[offset..<offset + length])], mask.allows(id) {
                            chosen = (id, length)
                            break
                        }
                    }
                    guard let chosen else { return XCTFail("\(name): refused at \(offset)") }
                    masker.accept(chosen.id)
                    offset += chosen.length
                }
                XCTAssertTrue(masker.nextMask().allows(stop), name)
                steps += masker.statistics.steps
                maskNanoseconds += masker.statistics.maskNanoseconds
                hits += masker.statistics.cacheHits
                misses += masker.statistics.cacheMisses
            }
            print(String(
                format: "%@: compile p50 %.2f ms p95 %.2f ms; %d steps, mask mean %.0f µs p95 %.0f µs max %.0f µs, cache %d hits / %d misses",
                name, percentile(compile, 50), percentile(compile, 95), steps,
                Double(maskNanoseconds) / 1e3 / Double(max(steps, 1)), percentile(stepTimes, 95),
                stepTimes.max() ?? 0, hits, misses))
        }
        print(String(format: "all contracts: compile p95 %.2f ms", percentile(allCompile, 95)))
    }

    private func percentile(_ values: [Double], _ p: Double) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let rank = min(sorted.count, max(1, Int((p / 100 * Double(sorted.count)).rounded(.up))))
        return sorted[rank - 1]
    }
}
