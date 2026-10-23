import Foundation

/// Why a schema cannot become a grammar. The helper then generates without one (`schemaMode`
/// `none`), as it does for a tokenizer it cannot mask.
public enum GrammarError: Error, Equatable, CustomStringConvertible {
    /// A keyword or construct outside the subset (`allOf`, `$ref`, a lookaround, ...).
    case unsupported(String)
    /// A schema no JSON value satisfies (`minItems` above `maxItems`, an empty range, ...).
    case unsatisfiable(String)
    /// Bounds on the compiled grammar (keys per object, nesting, literals, states).
    case tooLarge(String)

    public var description: String {
        switch self {
        case .unsupported(let detail): "unsupported schema: \(detail)"
        case .unsatisfiable(let detail): "unsatisfiable schema: \(detail)"
        case .tooLarge(let detail): "schema too large: \(detail)"
        }
    }
}

/// A JSON Schema subset compiled for constrained decoding (F4 D24).
///
/// The subset is what the host's grammar emitter sends: `type` (one or several), objects with
/// `properties` and `required` (always closed: the grammar never writes a member the schema does not
/// name), arrays with `items` (a schema or `false`), `prefixItems`, `minItems` and `maxItems`, strings
/// with `minLength`, `maxLength` (UTF-16 units, as Zod counts) and `pattern`, numbers and integers
/// with `minimum`, `maximum`, `exclusiveMinimum` and `exclusiveMaximum`, booleans, `null`, `enum`,
/// `const`, `anyOf` (or `oneOf`, read as `anyOf`) and `{}` for any value. Annotations (`description`,
/// `default`, `format`, ...) are ignored; anything else is refused.
///
/// Every value the grammar accepts is one the schema accepts, except where a union is widened: two
/// object alternatives that give a key different schemas accept either schema for it, two string or
/// number alternatives merge their bounds. The answer is still validated by Zod.
public final class Grammar: @unchecked Sendable {
    static let maxDepth = 32
    static let maxKeys = 64
    static let maxNodes = 10_000
    static let maxLiterals = 4_096
    /// Insignificant whitespace allowed between two tokens of the JSON text.
    public static let maxWhitespace: UInt8 = 32
    /// Nesting of containers inside a `{}` (any) value.
    static let maxAnyDepth: Int32 = 8

    enum Kind: UInt8 {
        case object, array, string, number, literals, union, any
    }

    struct Ref {
        var kind: Kind
        var index: Int32
    }

    private(set) var refs: [Ref] = []
    private(set) var objects: [ObjectNode] = []
    private(set) var arrays: [ArrayNode] = []
    private(set) var strings: [StringNode] = []
    private(set) var numbers: [NumberNode] = []
    private(set) var literals: [LiteralTrie] = []
    private(set) var unions: [UnionNode] = []
    private(set) var patterns: [PatternMachine] = []
    /// The source of each pattern, which keys what the vocabulary caches about it.
    private(set) var patternSources: [String] = []
    /// The fewest bytes of a value of each node.
    private(set) var minSizes: [Int] = []
    /// The schema each node was compiled from (union merging compares them).
    private var sources: [JSONValue] = []
    private var patternIndex: [String: Int] = [:]

    private(set) var root = 0
    /// The nodes a `{}` value uses for its strings, numbers and `true`/`false`/`null`.
    private(set) var anyNode = -1
    private(set) var anyString = -1
    private(set) var anyNumber = -1
    private(set) var anyLiterals = -1

    private init() {}

    /// Compiles a schema. Throws `GrammarError` for anything outside the subset.
    public static func compile(_ schema: JSONValue) throws -> Grammar {
        let grammar = Grammar()
        grammar.anyNode = grammar.add(.any, index: 0, source: .object([:]))
        grammar.anyString = try grammar.compileNode(.object(["type": .string("string")]), depth: 0)
        grammar.anyNumber = try grammar.compileNode(.object(["type": .string("number")]), depth: 0)
        grammar.anyLiterals = try grammar.literalNode([.bool(true), .bool(false), .null])
        grammar.root = try grammar.compileNode(schema, depth: 0)
        try grammar.computeSizes()
        return grammar
    }

    /// The fewest bytes of a document of this grammar.
    public var minimumDocumentBytes: Int { minSizes[root] }

    // MARK: Node tables

    private func add(_ kind: Kind, index: Int, source: JSONValue) -> Int {
        refs.append(Ref(kind: kind, index: Int32(index)))
        sources.append(source)
        return refs.count - 1
    }

    private func checkNodeCount() throws {
        if refs.count > Self.maxNodes { throw GrammarError.tooLarge("nodes") }
    }

    // MARK: Compilation

    private static let annotations: Set<String> = [
        "$schema", "$id", "$comment", "title", "description", "default", "examples", "readOnly",
        "writeOnly", "deprecated", "format", "contentEncoding", "contentMediaType", "$anchor",
    ]

    private func compileNode(_ schema: JSONValue, depth: Int) throws -> Int {
        try checkNodeCount()
        if depth > Self.maxDepth { throw GrammarError.tooLarge("nesting") }
        switch schema {
        case .bool(true): return anyNode
        case .bool(false): throw GrammarError.unsatisfiable("false schema")
        case .object(let members):
            if members.keys.allSatisfy({ Self.annotations.contains($0) }) { return anyNode }
            for keyword in ["allOf", "not", "$ref", "$defs", "definitions", "if", "then", "else",
                "patternProperties", "propertyNames", "dependentRequired", "dependentSchemas",
                "unevaluatedProperties", "unevaluatedItems", "contains", "uniqueItems",
                "multipleOf", "minProperties", "maxProperties"]
            where members[keyword] != nil {
                throw GrammarError.unsupported(keyword)
            }
            if let values = members["enum"] {
                guard case .array(let items) = values, !items.isEmpty else {
                    throw GrammarError.unsatisfiable("empty enum")
                }
                return try literalNode(items)
            }
            if let value = members["const"] { return try literalNode([value]) }
            if let alternatives = members["anyOf"] ?? members["oneOf"] {
                guard case .array(let items) = alternatives, !items.isEmpty else {
                    throw GrammarError.unsatisfiable("empty anyOf")
                }
                return try unionNode(items.map { try compileNode($0, depth: depth + 1) }, depth: depth)
            }
            switch members["type"] {
            case .some(.array(let types)):
                guard !types.isEmpty else { throw GrammarError.unsatisfiable("empty type list") }
                let nodes = try types.map { type -> Int in
                    var single = members
                    single["type"] = type
                    return try compileNode(.object(single), depth: depth + 1)
                }
                return try unionNode(nodes, depth: depth)
            case .some(.string(let type)):
                return try typedNode(type, members, schema: schema, depth: depth)
            case .some:
                throw GrammarError.unsupported("type")
            case .none:
                if members["properties"] != nil || members["required"] != nil {
                    return try typedNode("object", members, schema: schema, depth: depth)
                }
                if members["items"] != nil || members["prefixItems"] != nil {
                    return try typedNode("array", members, schema: schema, depth: depth)
                }
                if members["pattern"] != nil || members["minLength"] != nil
                    || members["maxLength"] != nil
                {
                    return try typedNode("string", members, schema: schema, depth: depth)
                }
                if members["minimum"] != nil || members["maximum"] != nil
                    || members["exclusiveMinimum"] != nil || members["exclusiveMaximum"] != nil
                {
                    return try typedNode("number", members, schema: schema, depth: depth)
                }
                return anyNode
            }
        default:
            throw GrammarError.unsupported("schema that is not an object")
        }
    }

    private func typedNode(
        _ type: String, _ members: [String: JSONValue], schema: JSONValue, depth: Int
    ) throws -> Int {
        switch type {
        case "object": return try objectNode(members, schema: schema, depth: depth)
        case "array": return try arrayNode(members, schema: schema, depth: depth)
        case "string": return try stringNode(members, schema: schema)
        case "number", "integer": return try numberNode(members, integer: type == "integer", schema: schema)
        case "boolean": return try literalNode([.bool(true), .bool(false)])
        case "null": return try literalNode([.null])
        default: throw GrammarError.unsupported("type \(type)")
        }
    }

    private func objectNode(_ members: [String: JSONValue], schema: JSONValue, depth: Int) throws -> Int {
        var properties: [String: JSONValue] = [:]
        if let value = members["properties"] {
            guard case .object(let map) = value else { throw GrammarError.unsupported("properties") }
            properties = map
        }
        var required: [String] = []
        if let value = members["required"] {
            guard case .array(let names) = value else { throw GrammarError.unsupported("required") }
            required = try names.map {
                guard let name = $0.stringValue else { throw GrammarError.unsupported("required") }
                return name
            }
        }
        if properties.isEmpty, required.isEmpty {
            // An open record (`additionalProperties` a schema or left out) takes any value.
            if case .bool(false) = members["additionalProperties"] ?? .bool(true) {
                // The empty object `{}`.
            } else {
                return anyNode
            }
        }
        let names = properties.keys.sorted()
        if names.count > Self.maxKeys { throw GrammarError.tooLarge("keys per object") }
        for name in required where properties[name] == nil {
            throw GrammarError.unsatisfiable("required key \(name) has no property")
        }
        let values = try names.map { try compileNode(properties[$0]!, depth: depth + 1) }
        var requiredMask: UInt64 = 0
        for (index, name) in names.enumerated() where required.contains(name) {
            requiredMask |= 1 << UInt64(index)
        }
        let allProperties: UInt64 = names.isEmpty ? 0 : (names.count == 64 ? ~0 : (1 << UInt64(names.count)) - 1)
        let node = ObjectNode(
            names: names, values: values,
            alternatives: [ObjectNode.Alternative(properties: allProperties, required: requiredMask)],
            sources: names.map { properties[$0]! })
        objects.append(node)
        return add(.object, index: objects.count - 1, source: schema)
    }

    private func arrayNode(_ members: [String: JSONValue], schema: JSONValue, depth: Int) throws -> Int {
        var prefix: [Int] = []
        if let value = members["prefixItems"] {
            guard case .array(let items) = value else { throw GrammarError.unsupported("prefixItems") }
            prefix = try items.map { try compileNode($0, depth: depth + 1) }
        }
        var items: Int? = anyNode
        if let value = members["items"] {
            if case .bool(false) = value {
                items = nil
            } else if case .array = value {
                throw GrammarError.unsupported("items as a list")
            } else {
                items = try compileNode(value, depth: depth + 1)
            }
        }
        let minItems = try count(members["minItems"], "minItems") ?? 0
        var maxItems = try count(members["maxItems"], "maxItems")
        if items == nil { maxItems = min(maxItems ?? prefix.count, prefix.count) }
        if let maxItems, minItems > maxItems { throw GrammarError.unsatisfiable("minItems above maxItems") }
        if minItems > 1_000 { throw GrammarError.tooLarge("minItems") }
        arrays.append(ArrayNode(prefix: prefix, items: items, minItems: minItems, maxItems: maxItems))
        return add(.array, index: arrays.count - 1, source: schema)
    }

    private func stringNode(_ members: [String: JSONValue], schema: JSONValue) throws -> Int {
        let minLength = try count(members["minLength"], "minLength") ?? 0
        let maxLength = try count(members["maxLength"], "maxLength")
        if let maxLength, minLength > maxLength { throw GrammarError.unsatisfiable("minLength above maxLength") }
        if minLength > 100_000 { throw GrammarError.tooLarge("minLength") }
        var pattern: Int?
        if let value = members["pattern"] {
            guard let source = value.stringValue else { throw GrammarError.unsupported("pattern") }
            if let known = patternIndex[source] {
                pattern = known
            } else {
                patterns.append(try PatternMachine(source: source))
                patternSources.append(source)
                patternIndex[source] = patterns.count - 1
                pattern = patterns.count - 1
            }
        }
        strings.append(StringNode(
            minLength: Int32(minLength), maxLength: maxLength.map { Int32($0) }, pattern: pattern))
        return add(.string, index: strings.count - 1, source: schema)
    }

    private func numberNode(_ members: [String: JSONValue], integer: Bool, schema: JSONValue) throws -> Int {
        var node = NumberNode(integer: integer)
        func bound(_ key: String) throws -> Double? {
            guard let value = members[key] else { return nil }
            if case .bool = value { return nil }
            guard let number = value.numberValue, number.isFinite else {
                throw GrammarError.unsupported(key)
            }
            return number
        }
        node.minimum = try bound("minimum")
        node.maximum = try bound("maximum")
        if let exclusive = try bound("exclusiveMinimum"), exclusive >= (node.minimum ?? -.infinity) {
            node.minimum = exclusive
            node.minimumExclusive = true
        }
        if let exclusive = try bound("exclusiveMaximum"), exclusive <= (node.maximum ?? .infinity) {
            node.maximum = exclusive
            node.maximumExclusive = true
        }
        // Draft-04 booleans: `exclusiveMinimum: true` makes `minimum` exclusive.
        if case .bool(true) = members["exclusiveMinimum"] ?? .null { node.minimumExclusive = true }
        if case .bool(true) = members["exclusiveMaximum"] ?? .null { node.maximumExclusive = true }
        guard NumberText.shortestLength(node) != nil else {
            throw GrammarError.unsatisfiable("empty number range")
        }
        numbers.append(node)
        return add(.number, index: numbers.count - 1, source: schema)
    }

    private func literalNode(_ values: [JSONValue]) throws -> Int {
        if values.count > Self.maxLiterals { throw GrammarError.tooLarge("enum") }
        var unique: [JSONValue] = []
        for value in values where !unique.contains(value) { unique.append(value) }
        literals.append(LiteralTrie(values: unique))
        return add(.literals, index: literals.count - 1, source: .object(["enum": .array(unique)]))
    }

    /// A union of compiled nodes: alternatives of each JSON type merge, and the value's first byte
    /// picks the type.
    private func unionNode(_ nodes: [Int], depth: Int) throws -> Int {
        var flat: [Int] = []
        func flatten(_ node: Int) {
            let ref = refs[node]
            if ref.kind == .union {
                let union = unions[Int(ref.index)]
                for part in [union.object, union.array, union.string, union.number, union.literals] {
                    if let part { flatten(part) }
                }
            } else if !flat.contains(node) {
                flat.append(node)
            }
        }
        nodes.forEach(flatten)
        if flat.contains(where: { refs[$0].kind == .any }) { return anyNode }
        if flat.count == 1 { return flat[0] }

        var objectNodes: [Int] = []
        var arrayNodes: [Int] = []
        var stringNodes: [Int] = []
        var numberNodes: [Int] = []
        var literalValues: [JSONValue] = []
        for node in flat {
            let ref = refs[node]
            switch ref.kind {
            case .object: objectNodes.append(node)
            case .array: arrayNodes.append(node)
            case .string: stringNodes.append(node)
            case .number: numberNodes.append(node)
            case .literals: literalValues.append(contentsOf: literals[Int(ref.index)].values)
            case .union, .any: break
            }
        }
        var union = UnionNode()
        if !objectNodes.isEmpty {
            union.object = objectNodes.count == 1 ? objectNodes[0] : try mergeObjects(objectNodes, depth: depth)
        }
        if !arrayNodes.isEmpty {
            let distinct = arrayNodes.reduce(into: [Int]()) { found, node in
                if !found.contains(where: { sources[$0] == sources[node] }) { found.append(node) }
            }
            if distinct.count > 1 { throw GrammarError.unsupported("union of different arrays") }
            union.array = distinct[0]
        }
        if !stringNodes.isEmpty { union.string = mergeStrings(stringNodes) }
        if !numberNodes.isEmpty { union.number = mergeNumbers(numberNodes) }
        // A literal of a type the union also has a node for is already one of its values or outside
        // that node's constraints; the node's own values keep the grammar inside the schema.
        literalValues.removeAll { value in
            switch value {
            case .string: return union.string != nil
            case .number: return union.number != nil
            case .object: return union.object != nil
            case .array: return union.array != nil
            case .bool, .null: return false
            }
        }
        if !literalValues.isEmpty { union.literals = try literalNode(literalValues) }
        let parts = [union.object, union.array, union.string, union.number, union.literals].compactMap { $0 }
        if parts.count == 1 { return parts[0] }
        unions.append(union)
        return add(.union, index: unions.count - 1, source: .object(["anyOf": .array(parts.map { sources[$0] })]))
    }

    /// Object alternatives as one node: its keys are the union of theirs, and the alternatives that
    /// can still hold the keys written so far decide which keys come next and when `}` may close.
    private func mergeObjects(_ nodes: [Int], depth: Int) throws -> Int {
        var names: [String] = []
        var keySources: [String: [JSONValue]] = [:]
        var alternatives: [(properties: [String], required: [String])] = []
        for node in nodes {
            let object = objects[Int(refs[node].index)]
            for alternative in object.alternatives {
                var properties: [String] = []
                var required: [String] = []
                for (index, name) in object.names.enumerated() {
                    let bit: UInt64 = 1 << UInt64(index)
                    guard alternative.properties & bit != 0 else { continue }
                    properties.append(name)
                    if alternative.required & bit != 0 { required.append(name) }
                    if !names.contains(name) { names.append(name) }
                    var known = keySources[name] ?? []
                    if !known.contains(object.sources[index]) { known.append(object.sources[index]) }
                    keySources[name] = known
                }
                alternatives.append((properties, required))
            }
        }
        names.sort()
        if names.count > Self.maxKeys { throw GrammarError.tooLarge("keys per object") }
        if alternatives.count > 64 { throw GrammarError.tooLarge("object alternatives") }
        var values: [Int] = []
        var valueSources: [JSONValue] = []
        for name in names {
            let known = keySources[name]!
            let source: JSONValue = known.count == 1 ? known[0] : .object(["anyOf": .array(known)])
            values.append(try compileNode(source, depth: depth + 1))
            valueSources.append(source)
        }
        let masks = alternatives.map { alternative -> ObjectNode.Alternative in
            var properties: UInt64 = 0
            var required: UInt64 = 0
            for (index, name) in names.enumerated() {
                if alternative.properties.contains(name) { properties |= 1 << UInt64(index) }
                if alternative.required.contains(name) { required |= 1 << UInt64(index) }
            }
            return ObjectNode.Alternative(properties: properties, required: required)
        }
        objects.append(ObjectNode(names: names, values: values, alternatives: masks, sources: valueSources))
        return add(.object, index: objects.count - 1, source: .object(["anyOf": .array(nodes.map { sources[$0] })]))
    }

    private func mergeStrings(_ nodes: [Int]) -> Int {
        let specs = nodes.map { strings[Int(refs[$0].index)] }
        if specs.allSatisfy({ $0 == specs[0] }) { return nodes[0] }
        let minLength = specs.map(\.minLength).min()!
        let maxLength: Int32? = specs.contains { $0.maxLength == nil } ? nil : specs.compactMap(\.maxLength).max()
        let pattern = specs.allSatisfy({ $0.pattern == specs[0].pattern }) ? specs[0].pattern : nil
        strings.append(StringNode(minLength: minLength, maxLength: maxLength, pattern: pattern))
        return add(.string, index: strings.count - 1, source: .object(["anyOf": .array(nodes.map { sources[$0] })]))
    }

    private func mergeNumbers(_ nodes: [Int]) -> Int {
        let specs = nodes.map { numbers[Int(refs[$0].index)] }
        if specs.allSatisfy({ $0 == specs[0] }) { return nodes[0] }
        var merged = NumberNode(integer: specs.allSatisfy(\.integer))
        if !specs.contains(where: { $0.minimum == nil }) {
            merged.minimum = specs.compactMap(\.minimum).min()
        }
        if !specs.contains(where: { $0.maximum == nil }) {
            merged.maximum = specs.compactMap(\.maximum).max()
        }
        numbers.append(merged)
        return add(.number, index: numbers.count - 1, source: .object(["anyOf": .array(nodes.map { sources[$0] })]))
    }

    private func count(_ value: JSONValue?, _ keyword: String) throws -> Int? {
        guard let value else { return nil }
        guard let count = value.countValue else { throw GrammarError.unsupported(keyword) }
        return count
    }

    // MARK: Sizes

    private func computeSizes() throws {
        minSizes = Array(repeating: -1, count: refs.count)
        for node in 0..<refs.count { _ = try minSize(node) }
        for index in objects.indices { objects[index].finish(minSizes: minSizes) }
        for index in arrays.indices { arrays[index].finish(minSizes: minSizes) }
    }

    private func minSize(_ node: Int) throws -> Int {
        if minSizes[node] >= 0 { return minSizes[node] }
        let ref = refs[node]
        let index = Int(ref.index)
        var size: Int
        switch ref.kind {
        case .any:
            size = 1
        case .object:
            let object = objects[index]
            size = Int.max
            for alternative in object.alternatives {
                var total = 2
                var pairs = 0
                for key in 0..<object.names.count where alternative.required & (1 << UInt64(key)) != 0 {
                    total += 2 + object.keyBytes[key].count + (try minSize(object.values[key]))
                    pairs += 1
                }
                size = min(size, total + max(0, pairs - 1))
            }
        case .array:
            let array = arrays[index]
            size = 2 + max(0, array.minItems - 1)
            for item in 0..<array.minItems {
                guard let node = array.itemNode(item) else { throw GrammarError.unsatisfiable("array") }
                size += try minSize(node)
            }
        case .string:
            let string = strings[index]
            let patternBytes = string.pattern.map { patterns[$0].distance(patterns[$0].start) } ?? 0
            size = 2 + max(Int(string.minLength), patternBytes)
        case .number:
            size = NumberText.shortestLength(numbers[index]) ?? 1
        case .literals:
            size = Int(literals[index].minRemaining[0])
        case .union:
            let union = unions[index]
            size = Int.max
            for part in [union.object, union.array, union.string, union.number, union.literals] {
                if let part { size = min(size, try minSize(part)) }
            }
        }
        minSizes[node] = size
        return size
    }

    // MARK: Runtime lookups

    /// The node a value of `node` that starts with `byte` is: a union picks its alternative.
    func resolve(_ node: Int, _ byte: UInt8) -> Int? {
        let ref = refs[node]
        guard ref.kind == .union else { return node }
        let union = unions[Int(ref.index)]
        let candidate: Int?
        switch byte {
        case UInt8(ascii: "{"): candidate = union.object
        case UInt8(ascii: "["): candidate = union.array
        case UInt8(ascii: "\""): candidate = union.string
        case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): candidate = union.number
        default: candidate = nil
        }
        if let candidate { return candidate }
        if let literal = union.literals, literals[Int(refs[literal].index)].child(0, byte) != nil {
            return literal
        }
        return nil
    }
}

/// An object's keys, alternatives and key trie. The key bytes are the escaped name followed by the
/// closing quote, so the trie's terminal nodes have no children.
struct ObjectNode: Sendable {
    struct Alternative: Sendable {
        var properties: UInt64
        var required: UInt64
    }

    let names: [String]
    let values: [Int]
    let alternatives: [Alternative]
    let sources: [JSONValue]
    let keyBytes: [[UInt8]]
    /// Per key: the alternatives that have it.
    let alternativesWithKey: [UInt64]
    let allAlternatives: UInt64
    // Key trie.
    private(set) var trieChildren: [[(byte: UInt8, node: Int32)]] = [[]]
    private(set) var trieKey: [Int16] = [-1]
    private(set) var trieSubtree: [UInt64] = [0]
    private(set) var trieDepth: [Int16] = [0]
    /// Per key: bytes of a whole pair (`"name":` plus the shortest value); set by `finish`.
    private(set) var pairMin: [Int] = []
    private(set) var valueMin: [Int] = []

    init(names: [String], values: [Int], alternatives: [Alternative], sources: [JSONValue]) {
        self.names = names
        self.values = values
        self.alternatives = alternatives
        self.sources = sources
        keyBytes = names.map { JSONValue.escapedStringContent($0) + [UInt8(ascii: "\"")] }
        alternativesWithKey = names.indices.map { key in
            var mask: UInt64 = 0
            for (index, alternative) in alternatives.enumerated()
            where alternative.properties & (1 << UInt64(key)) != 0 {
                mask |= 1 << UInt64(index)
            }
            return mask
        }
        allAlternatives = alternatives.count == 64 ? ~0 : (1 << UInt64(alternatives.count)) - 1
        for (key, bytes) in keyBytes.enumerated() {
            var node: Int32 = 0
            trieSubtree[0] |= 1 << UInt64(key)
            for byte in bytes {
                if let next = trieChildren[Int(node)].first(where: { $0.byte == byte })?.node {
                    node = next
                } else {
                    let next = Int32(trieChildren.count)
                    trieChildren.append([])
                    trieKey.append(-1)
                    trieSubtree.append(0)
                    trieDepth.append(trieDepth[Int(node)] + 1)
                    trieChildren[Int(node)].append((byte, next))
                    node = next
                }
                trieSubtree[Int(node)] |= 1 << UInt64(key)
            }
            trieKey[Int(node)] = Int16(key)
        }
    }

    mutating func finish(minSizes: [Int]) {
        valueMin = values.map { minSizes[$0] }
        pairMin = keyBytes.indices.map { 2 + keyBytes[$0].count + valueMin[$0] }
    }

    func trieChild(_ node: Int32, _ byte: UInt8) -> Int32? {
        for child in trieChildren[Int(node)] where child.byte == byte { return child.node }
        return nil
    }

    /// Keys that may still be written: in a live alternative, not written yet.
    func allowedKeys(seen: UInt64, live: UInt64) -> UInt64 {
        var properties: UInt64 = 0
        var remaining = live
        while remaining != 0 {
            let index = remaining.trailingZeroBitCount
            properties |= alternatives[index].properties
            remaining &= remaining - 1
        }
        return properties & ~seen
    }

    /// Whether `}` may close the object: a live alternative has all its required keys.
    func closable(seen: UInt64, live: UInt64) -> Bool {
        var remaining = live
        while remaining != 0 {
            let index = remaining.trailingZeroBitCount
            if alternatives[index].required & ~seen == 0 { return true }
            remaining &= remaining - 1
        }
        return false
    }

    /// The fewest bytes that close the object: the missing required pairs, their commas and `}`.
    func minClose(seen: UInt64, live: UInt64, first: Bool) -> Int {
        var best = Int.max / 4
        var remaining = live
        while remaining != 0 {
            let index = remaining.trailingZeroBitCount
            remaining &= remaining - 1
            var missing = alternatives[index].required & ~seen
            var total = 0
            var pairs = 0
            while missing != 0 {
                total += pairMin[missing.trailingZeroBitCount]
                pairs += 1
                missing &= missing - 1
            }
            best = min(best, total + (first ? max(0, pairs - 1) : pairs))
        }
        return best + 1
    }

    /// The fewest bytes from inside a key (trie node `node`) to the end of the object.
    func minFromKey(node: Int32, seen: UInt64, live: UInt64) -> Int {
        var best = Int.max / 4
        var keys = trieSubtree[Int(node)] & allowedKeys(seen: seen, live: live)
        while keys != 0 {
            let key = keys.trailingZeroBitCount
            keys &= keys - 1
            let rest = keyBytes[key].count - Int(trieDepth[Int(node)]) + 1 + valueMin[key]
            let bit: UInt64 = 1 << UInt64(key)
            best = min(best, rest + minClose(seen: seen | bit, live: live & alternativesWithKey[key], first: false))
        }
        return best
    }

    /// The fewest bytes after a comma: one more pair, then the close.
    func minNextPair(seen: UInt64, live: UInt64) -> Int {
        var best = Int.max / 4
        var keys = allowedKeys(seen: seen, live: live)
        while keys != 0 {
            let key = keys.trailingZeroBitCount
            keys &= keys - 1
            let bit: UInt64 = 1 << UInt64(key)
            best = min(best, pairMin[key] + minClose(seen: seen | bit, live: live & alternativesWithKey[key], first: false))
        }
        return best
    }
}

struct ArrayNode: Sendable {
    let prefix: [Int]
    /// The schema of items past the prefix; nil when there may be none.
    let items: Int?
    let minItems: Int
    /// The most items, the prefix's length included when `items` is nil.
    let maxItems: Int?
    /// `suffix[i]`: bytes of the required items from `i` on, each with its comma.
    private(set) var suffix: [Int] = []
    private(set) var itemMin: [Int] = []
    private(set) var defaultItemMin = 0

    init(prefix: [Int], items: Int?, minItems: Int, maxItems: Int?) {
        self.prefix = prefix
        self.items = items
        self.minItems = minItems
        self.maxItems = maxItems
    }

    func itemNode(_ index: Int) -> Int? {
        if index < prefix.count { return prefix[index] }
        if let maxItems, index >= maxItems { return nil }
        return items
    }

    /// The fewest bytes of any item: how many items one token can hold at most.
    private(set) var minItemBytes = 1

    mutating func finish(minSizes: [Int]) {
        itemMin = prefix.map { minSizes[$0] }
        defaultItemMin = items.map { minSizes[$0] } ?? 0
        minItemBytes = max(1, (itemMin + (items == nil ? [] : [defaultItemMin])).min() ?? 1)
        suffix = Array(repeating: 0, count: minItems + 1)
        if minItems > 0 {
            for index in stride(from: minItems - 1, through: 0, by: -1) {
                suffix[index] = suffix[index + 1] + 1 + itemMinimum(index)
            }
        }
    }

    func itemMinimum(_ index: Int) -> Int {
        index < itemMin.count ? itemMin[index] : defaultItemMin
    }
}

struct StringNode: Equatable, Sendable {
    var minLength: Int32
    var maxLength: Int32?
    var pattern: Int?
}

struct NumberNode: Equatable, Sendable {
    var integer: Bool
    var minimum: Double?
    var minimumExclusive = false
    var maximum: Double?
    var maximumExclusive = false

    init(integer: Bool) {
        self.integer = integer
    }

    var bounded: Bool { minimum != nil || maximum != nil }

    func contains(_ value: Double) -> Bool {
        if let minimum, value < minimum || (minimumExclusive && value == minimum) { return false }
        if let maximum, value > maximum || (maximumExclusive && value == maximum) { return false }
        return true
    }

    /// Whether the interval between `low` and `high` (each end closed or open) meets the bounds; for
    /// an integer node, whether it holds an integer that does.
    func meets(_ low: Double, _ lowClosed: Bool, _ high: Double, _ highClosed: Bool) -> Bool {
        var low = low
        var lowClosed = lowClosed
        var high = high
        var highClosed = highClosed
        if let minimum {
            if minimum > low {
                low = minimum
                lowClosed = !minimumExclusive
            } else if minimum == low {
                lowClosed = lowClosed && !minimumExclusive
            }
        }
        if let maximum {
            if maximum < high {
                high = maximum
                highClosed = !maximumExclusive
            } else if maximum == high {
                highClosed = highClosed && !maximumExclusive
            }
        }
        if integer {
            let first = lowClosed ? low.rounded(.up) : (low.rounded(.down) + 1)
            let last = highClosed ? high.rounded(.down) : (high.rounded(.up) - 1)
            return first <= last
        }
        if low < high { return true }
        return low == high && lowClosed && highClosed
    }
}

/// The literal values of an `enum` or `const` as a byte trie of their compact JSON text.
struct LiteralTrie: Sendable {
    let values: [JSONValue]
    private(set) var children: [[(byte: UInt8, node: Int32)]] = [[]]
    private(set) var terminal: [Bool] = [false]
    /// Bytes from a node to the nearest end of a literal.
    private(set) var minRemaining: [Int32] = [0]

    init(values: [JSONValue]) {
        self.values = values
        for value in values {
            var node: Int32 = 0
            for byte in value.canonicalBytes {
                if let next = children[Int(node)].first(where: { $0.byte == byte })?.node {
                    node = next
                } else {
                    let next = Int32(children.count)
                    children.append([])
                    terminal.append(false)
                    minRemaining.append(0)
                    children[Int(node)].append((byte, next))
                    node = next
                }
            }
            terminal[Int(node)] = true
        }
        // Nodes are created after their parent, so a reverse pass sees children first.
        for node in stride(from: children.count - 1, through: 0, by: -1) {
            if terminal[node] {
                minRemaining[node] = 0
            } else {
                minRemaining[node] = (children[node].map { minRemaining[Int($0.node)] }.min() ?? 0) + 1
            }
        }
    }

    func child(_ node: Int32, _ byte: UInt8) -> Int32? {
        for child in children[Int(node)] where child.byte == byte { return child.node }
        return nil
    }
}

struct UnionNode: Sendable {
    var object: Int?
    var array: Int?
    var string: Int?
    var number: Int?
    var literals: Int?
}

/// Lengths of number texts.
enum NumberText {
    /// The shortest JSON text of a number the node accepts, or nil when it accepts none.
    static func shortestLength(_ node: NumberNode) -> Int? {
        if !node.bounded { return 1 }
        // An integer: zero, else the one closest to zero.
        let low = node.minimum.map { node.minimumExclusive ? $0.rounded(.down) + 1 : $0.rounded(.up) }
        let high = node.maximum.map { node.maximumExclusive ? $0.rounded(.up) - 1 : $0.rounded(.down) }
        if (low ?? -.infinity) <= (high ?? .infinity) {
            if (low ?? -.infinity) <= 0, (high ?? .infinity) >= 0 { return 1 }
            if let low, low > 0 { return digits(low) }
            if let high, high < 0 { return digits(-high) + 1 }
        }
        if node.integer { return nil }
        // A decimal with the fewest fraction digits.
        for places in 1...12 {
            let scale = pow(10.0, Double(places))
            var candidate: Double
            if let minimum = node.minimum {
                candidate = (minimum * scale).rounded(.up) / scale
                if node.minimumExclusive, candidate <= minimum { candidate += 1 / scale }
            } else if let maximum = node.maximum {
                candidate = (maximum * scale).rounded(.down) / scale
                if node.maximumExclusive, candidate >= maximum { candidate -= 1 / scale }
            } else {
                return 1
            }
            if node.contains(candidate) {
                let whole = digits(abs(candidate).rounded(.down))
                return whole + 1 + places + (candidate < 0 ? 1 : 0)
            }
        }
        return nil
    }

    private static func digits(_ value: Double) -> Int {
        value < 10 ? 1 : Int(log10(value).rounded(.down)) + 1
    }
}
