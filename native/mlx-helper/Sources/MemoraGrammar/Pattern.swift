/// The `pattern` of a string schema: an ECMAScript regular expression subset compiled to an NFA over
/// Unicode scalars and run as a lazily built DFA.
///
/// Supported: literals and escapes (`\d \D \w \W \s \S \n \r \t \f \v \0 \xHH \uHHHH \u{H…}` and
/// escaped metacharacters), `.`, classes with ranges and negation, groups (capturing, `(?:…)`,
/// `(?<name>…)`), alternation, the quantifiers `* + ? {n} {n,} {n,m}` (lazy forms match the same
/// strings), and `^`/`$` only at the start and end of the whole pattern. A pattern without them is a
/// search, as JSON Schema says. Lookarounds, backreferences and word boundaries are refused.
///
/// The automaton matches the characters a model writes inside the string literally: a pattern string
/// takes no escape sequence, so its edges exclude the quote, the backslash and control characters.
final class PatternMachine: @unchecked Sendable {
    static let maxStates = 4_096

    /// Per NFA state: the scalar sets of its edges and their targets.
    private let edges: [[(set: ScalarSet, target: Int32)]]
    /// Per NFA state: its epsilon closure (sorted).
    private let closures: [[Int32]]
    private let acceptState: Int32
    /// Per NFA state: the fewest UTF-8 bytes that reach acceptance.
    private let nfaDistance: [Int32]

    private var dfaSets: [[Int32]] = []
    private var dfaIndex: [[Int32]: Int32] = [:]
    private var dfaAccepting: [Bool] = []
    private var dfaDistance: [Int32] = []
    /// `dfa * 128 + byte` → next DFA state, `-1` dead, `-2` not computed yet.
    private var asciiNext: [Int32] = []

    /// The DFA state before the first character.
    private(set) var start: Int32 = -1

    /// The bytes a match can hold: the ASCII characters of its classes, and every byte from 0x80 on
    /// when a class holds a non-ASCII character.
    let alphabet: [Bool]

    init(source: String) throws {
        var parser = RegexParser(Array(source.unicodeScalars.map(\.value)))
        let (ast, anchoredStart, anchoredEnd) = try parser.parsePattern()
        let builder = NFABuilder()
        let begin = builder.newState()
        var body = ast
        let any = RegexAST.repetition(.set(.all), 0, nil)
        if !anchoredStart { body = .concat([any, body]) }
        if !anchoredEnd { body = .concat([body, any]) }
        let end = try builder.build(body, from: begin)
        let compiled = try builder.finish(start: begin, accept: end)
        edges = compiled.edges
        closures = compiled.closures
        acceptState = Int32(end)
        nfaDistance = compiled.distance
        var alphabet = [Bool](repeating: false, count: 256)
        for state in compiled.edges {
            for edge in state {
                for range in edge.set.ranges {
                    if range.lowerBound < 0x80 {
                        for byte in range.lowerBound...min(range.upperBound, 0x7F) { alphabet[Int(byte)] = true }
                    }
                    if range.upperBound >= 0x80 {
                        for byte in 0x80..<256 { alphabet[byte] = true }
                    }
                }
            }
        }
        self.alphabet = alphabet
        start = intern(closures[begin])
        if start < 0 { throw GrammarError.unsupported("pattern matches no string") }
    }

    /// Whether every character a match holds is ASCII.
    var isASCII: Bool { !alphabet[0x80] }

    /// The NFA states behind a DFA state: the same for the same pattern in every call, unlike the
    /// DFA state's number, which depends on the order states were met.
    func stateKey(_ state: Int32) -> [Int32] {
        dfaSets[Int(state)]
    }

    func isAccepting(_ state: Int32) -> Bool {
        state >= 0 && dfaAccepting[Int(state)]
    }

    /// The fewest UTF-8 bytes that complete a match from `state`.
    func distance(_ state: Int32) -> Int {
        state >= 0 ? Int(dfaDistance[Int(state)]) : Int.max / 4
    }

    /// The state after one character, or -1 when the pattern can no longer match.
    func step(_ state: Int32, _ scalar: UInt32) -> Int32 {
        if scalar < 128 {
            let slot = Int(state) * 128 + Int(scalar)
            let known = asciiNext[slot]
            if known != -2 { return known }
            let next = computeNext(state, scalar)
            asciiNext[slot] = next
            return next
        }
        return computeNext(state, scalar)
    }

    /// Whether some character in `low...high` keeps the match alive (a partial UTF-8 sequence).
    func acceptsRange(_ state: Int32, _ low: UInt32, _ high: UInt32) -> Bool {
        for nfa in dfaSets[Int(state)] {
            for edge in edges[Int(nfa)] where edge.set.intersects(low, high) { return true }
        }
        return false
    }

    private func computeNext(_ state: Int32, _ scalar: UInt32) -> Int32 {
        var targets = Set<Int32>()
        for nfa in dfaSets[Int(state)] {
            for edge in edges[Int(nfa)] where edge.set.contains(scalar) {
                targets.formUnion(closures[Int(edge.target)])
            }
        }
        if targets.isEmpty { return -1 }
        return intern(targets.sorted())
    }

    private func intern(_ set: [Int32]) -> Int32 {
        if set.isEmpty { return -1 }
        if let known = dfaIndex[set] { return known }
        let id = Int32(dfaSets.count)
        dfaSets.append(set)
        dfaIndex[set] = id
        dfaAccepting.append(set.contains(acceptState))
        dfaDistance.append(set.map { nfaDistance[Int($0)] }.min() ?? Int32.max / 4)
        asciiNext.append(contentsOf: repeatElement(-2, count: 128))
        return id
    }
}

indirect enum RegexAST {
    case set(ScalarSet)
    case concat([RegexAST])
    case alternation([RegexAST])
    case repetition(RegexAST, Int, Int?)
    case empty
}

/// Parses an ECMAScript pattern (without flags) into a `RegexAST`.
struct RegexParser {
    private let scalars: [UInt32]
    private var position = 0

    init(_ scalars: [UInt32]) {
        self.scalars = scalars
    }

    private static func ascii(_ character: Character) -> UInt32 {
        character.unicodeScalars.first!.value
    }

    private static let caret = ascii("^")
    private static let dollar = ascii("$")
    private static let pipe = ascii("|")
    private static let openParen = ascii("(")
    private static let closeParen = ascii(")")
    private static let openBracket = ascii("[")
    private static let closeBracket = ascii("]")
    private static let backslash = ascii("\\")
    private static let dot = ascii(".")
    private static let star = ascii("*")
    private static let plus = ascii("+")
    private static let question = ascii("?")
    private static let openBrace = ascii("{")
    private static let closeBrace = ascii("}")
    private static let comma = ascii(",")
    private static let hyphen = ascii("-")

    static let digits = ScalarSet([0x30...0x39])
    static let word = ScalarSet([0x30...0x39, 0x41...0x5A, 0x5F...0x5F, 0x61...0x7A])
    /// ECMAScript `\s`: white space and line terminators.
    static let space = ScalarSet([
        0x09...0x0D, 0x20...0x20, 0xA0...0xA0, 0x1680...0x1680, 0x2000...0x200A,
        0x2028...0x2029, 0x202F...0x202F, 0x205F...0x205F, 0x3000...0x3000, 0xFEFF...0xFEFF,
    ])
    /// ECMAScript `.` without the `s` flag: anything but a line terminator.
    static let dotSet = ScalarSet([0x0A...0x0A, 0x0D...0x0D, 0x2028...0x2029]).complement()

    /// The pattern, and whether it is anchored at its start and end.
    mutating func parsePattern() throws -> (RegexAST, Bool, Bool) {
        var anchoredStart = false
        var anchoredEnd = false
        if peek() == Self.caret {
            anchoredStart = true
            position += 1
        }
        var end = scalars.count
        if end > position, scalars[end - 1] == Self.dollar, !isEscaped(at: end - 1) {
            anchoredEnd = true
            end -= 1
        }
        let limit = end
        let ast = try parseAlternation(limit: limit)
        if position != limit { throw GrammarError.unsupported("pattern syntax") }
        return (ast, anchoredStart, anchoredEnd)
    }

    private func isEscaped(at index: Int) -> Bool {
        var backslashes = 0
        var cursor = index - 1
        while cursor >= 0, scalars[cursor] == Self.backslash {
            backslashes += 1
            cursor -= 1
        }
        return backslashes % 2 == 1
    }

    private func peek() -> UInt32? {
        position < scalars.count ? scalars[position] : nil
    }

    private mutating func parseAlternation(limit: Int) throws -> RegexAST {
        var branches = [try parseConcat(limit: limit)]
        while position < limit, scalars[position] == Self.pipe {
            position += 1
            branches.append(try parseConcat(limit: limit))
        }
        return branches.count == 1 ? branches[0] : .alternation(branches)
    }

    private mutating func parseConcat(limit: Int) throws -> RegexAST {
        var items: [RegexAST] = []
        while position < limit {
            let scalar = scalars[position]
            if scalar == Self.pipe || scalar == Self.closeParen { break }
            let atom = try parseAtom(limit: limit)
            items.append(try parseQuantifier(atom, limit: limit))
        }
        if items.isEmpty { return .empty }
        return items.count == 1 ? items[0] : .concat(items)
    }

    private mutating func parseQuantifier(_ atom: RegexAST, limit: Int) throws -> RegexAST {
        guard position < limit else { return atom }
        var result: RegexAST
        switch scalars[position] {
        case Self.star:
            position += 1
            result = .repetition(atom, 0, nil)
        case Self.plus:
            position += 1
            result = .repetition(atom, 1, nil)
        case Self.question:
            position += 1
            result = .repetition(atom, 0, 1)
        case Self.openBrace:
            guard let (low, high, length) = braceQuantifier(limit: limit) else { return atom }
            position += length
            if let high, high < low { throw GrammarError.unsupported("pattern quantifier") }
            if low > 1_000 || (high ?? 0) > 1_000 {
                throw GrammarError.unsupported("pattern quantifier too large")
            }
            result = .repetition(atom, low, high)
        default:
            return atom
        }
        // A lazy quantifier matches the same strings.
        if position < limit, scalars[position] == Self.question { position += 1 }
        if position < limit,
            [Self.star, Self.plus, Self.question].contains(scalars[position])
        {
            throw GrammarError.unsupported("pattern quantifier")
        }
        return result
    }

    /// `{n}`, `{n,}` or `{n,m}` at the current position, with its length; nil when the brace is a
    /// literal character.
    private func braceQuantifier(limit: Int) -> (Int, Int?, Int)? {
        var cursor = position + 1
        func number() -> Int? {
            var value = 0
            var digits = 0
            while cursor < limit, scalars[cursor] >= 0x30, scalars[cursor] <= 0x39 {
                value = min(value * 10 + Int(scalars[cursor] - 0x30), 1_000_000)
                digits += 1
                cursor += 1
            }
            return digits > 0 ? value : nil
        }
        guard let low = number() else { return nil }
        var high: Int? = low
        if cursor < limit, scalars[cursor] == Self.comma {
            cursor += 1
            high = number()
        }
        guard cursor < limit, scalars[cursor] == Self.closeBrace else { return nil }
        return (low, high, cursor + 1 - position)
    }

    private mutating func parseAtom(limit: Int) throws -> RegexAST {
        let scalar = scalars[position]
        switch scalar {
        case Self.openParen:
            position += 1
            if peek() == Self.question {
                // `(?:…)` and `(?<name>…)` group; lookarounds are not supported.
                guard position + 1 < limit else { throw GrammarError.unsupported("pattern group") }
                let kind = scalars[position + 1]
                if kind == Self.ascii(":") {
                    position += 2
                } else if kind == Self.ascii("<"), position + 2 < limit,
                    scalars[position + 2] != Self.ascii("="), scalars[position + 2] != Self.ascii("!")
                {
                    position += 2
                    while position < limit, scalars[position] != Self.ascii(">") { position += 1 }
                    guard position < limit else { throw GrammarError.unsupported("pattern group") }
                    position += 1
                } else {
                    throw GrammarError.unsupported("pattern lookaround")
                }
            }
            let inner = try parseAlternation(limit: limit)
            guard position < limit, scalars[position] == Self.closeParen else {
                throw GrammarError.unsupported("pattern group")
            }
            position += 1
            return inner
        case Self.openBracket:
            position += 1
            return .set(try parseClass(limit: limit))
        case Self.dot:
            position += 1
            return .set(Self.dotSet)
        case Self.backslash:
            position += 1
            return .set(try parseEscape(limit: limit, inClass: false))
        case Self.caret, Self.dollar:
            throw GrammarError.unsupported("pattern anchor inside the pattern")
        case Self.star, Self.plus, Self.question:
            throw GrammarError.unsupported("pattern quantifier without a target")
        case Self.closeBracket, Self.closeBrace, Self.openBrace:
            position += 1
            return .set(ScalarSet(scalar: scalar))
        default:
            position += 1
            return .set(ScalarSet(scalar: scalar))
        }
    }

    private mutating func parseClass(limit: Int) throws -> ScalarSet {
        var negated = false
        if peek() == Self.caret {
            negated = true
            position += 1
        }
        var set = ScalarSet.empty
        while position < limit {
            // As in ECMAScript, `]` closes the class even first: `[]` matches nothing, `[^]` anything.
            if scalars[position] == Self.closeBracket {
                position += 1
                return negated ? set.complement() : set
            }
            let low = try classAtom(limit: limit)
            if position + 1 < limit, scalars[position] == Self.hyphen,
                scalars[position + 1] != Self.closeBracket
            {
                position += 1
                let high = try classAtom(limit: limit)
                guard case .single(let lowScalar) = low, case .single(let highScalar) = high,
                    lowScalar <= highScalar
                else { throw GrammarError.unsupported("pattern class range") }
                set = set.union(ScalarSet([lowScalar...highScalar]))
            } else {
                switch low {
                case .single(let value): set = set.union(ScalarSet(scalar: value))
                case .set(let value): set = set.union(value)
                }
            }
        }
        throw GrammarError.unsupported("pattern class")
    }

    private enum ClassAtom {
        case single(UInt32)
        case set(ScalarSet)
    }

    private mutating func classAtom(limit: Int) throws -> ClassAtom {
        let scalar = scalars[position]
        position += 1
        guard scalar == Self.backslash else { return .single(scalar) }
        guard position < limit else { throw GrammarError.unsupported("pattern escape") }
        if scalars[position] == Self.ascii("b") {
            position += 1
            return .single(0x08)
        }
        let set = try parseEscape(limit: limit, inClass: true)
        if set.ranges.count == 1, set.ranges[0].lowerBound == set.ranges[0].upperBound {
            return .single(set.ranges[0].lowerBound)
        }
        return .set(set)
    }

    private mutating func parseEscape(limit: Int, inClass: Bool) throws -> ScalarSet {
        guard position < limit else { throw GrammarError.unsupported("pattern escape") }
        let scalar = scalars[position]
        position += 1
        switch scalar {
        case Self.ascii("d"): return Self.digits
        case Self.ascii("D"): return Self.digits.complement()
        case Self.ascii("w"): return Self.word
        case Self.ascii("W"): return Self.word.complement()
        case Self.ascii("s"): return Self.space
        case Self.ascii("S"): return Self.space.complement()
        case Self.ascii("n"): return ScalarSet(scalar: 0x0A)
        case Self.ascii("r"): return ScalarSet(scalar: 0x0D)
        case Self.ascii("t"): return ScalarSet(scalar: 0x09)
        case Self.ascii("f"): return ScalarSet(scalar: 0x0C)
        case Self.ascii("v"): return ScalarSet(scalar: 0x0B)
        case Self.ascii("0"):
            if let next = peek(), next >= 0x30, next <= 0x39 {
                throw GrammarError.unsupported("pattern octal escape")
            }
            return ScalarSet(scalar: 0)
        case Self.ascii("x"):
            return ScalarSet(scalar: try hexDigits(count: 2, limit: limit))
        case Self.ascii("u"):
            if peek() == Self.openBrace {
                position += 1
                var value: UInt32 = 0
                var digits = 0
                while position < limit, let digit = Self.hexValue(scalars[position]) {
                    value = value * 16 + digit
                    digits += 1
                    position += 1
                    if value > ScalarSet.maxScalar { throw GrammarError.unsupported("pattern escape") }
                }
                guard digits > 0, position < limit, scalars[position] == Self.closeBrace else {
                    throw GrammarError.unsupported("pattern escape")
                }
                position += 1
                return ScalarSet(scalar: value)
            }
            return ScalarSet(scalar: try hexDigits(count: 4, limit: limit))
        case Self.ascii("b"), Self.ascii("B"):
            throw GrammarError.unsupported("pattern word boundary")
        case Self.ascii("c"), Self.ascii("k"), Self.ascii("p"), Self.ascii("P"):
            throw GrammarError.unsupported("pattern escape")
        case 0x31...0x39:
            throw GrammarError.unsupported("pattern backreference")
        default:
            // An identity escape: the character itself (`\.`, `\-`, `\/`, ...).
            return ScalarSet(scalar: scalar)
        }
    }

    private mutating func hexDigits(count: Int, limit: Int) throws -> UInt32 {
        var value: UInt32 = 0
        for _ in 0..<count {
            guard position < limit, let digit = Self.hexValue(scalars[position]) else {
                throw GrammarError.unsupported("pattern escape")
            }
            value = value * 16 + digit
            position += 1
        }
        return value
    }

    private static func hexValue(_ scalar: UInt32) -> UInt32? {
        switch scalar {
        case 0x30...0x39: return scalar - 0x30
        case 0x41...0x46: return scalar - 0x41 + 10
        case 0x61...0x66: return scalar - 0x61 + 10
        default: return nil
        }
    }
}

/// Thompson construction of the NFA, then the steps that make it fit for masking: edges cut to what
/// a JSON string holds literally, states that cannot reach acceptance removed, epsilon closures and
/// the shortest distance (in UTF-8 bytes) to acceptance.
final class NFABuilder {
    private var edges: [[(set: ScalarSet, target: Int32)]] = []
    private var epsilons: [[Int32]] = []

    func newState() -> Int {
        edges.append([])
        epsilons.append([])
        return edges.count - 1
    }

    private func checkSize() throws {
        if edges.count > PatternMachine.maxStates {
            throw GrammarError.unsupported("pattern too large")
        }
    }

    /// Builds `ast` from `from` and returns its end state.
    func build(_ ast: RegexAST, from: Int) throws -> Int {
        try checkSize()
        switch ast {
        case .empty:
            return from
        case .set(let set):
            let end = newState()
            edges[from].append((set, Int32(end)))
            return end
        case .concat(let items):
            var current = from
            for item in items { current = try build(item, from: current) }
            return current
        case .alternation(let branches):
            let end = newState()
            for branch in branches {
                let start = newState()
                epsilons[from].append(Int32(start))
                let branchEnd = try build(branch, from: start)
                epsilons[branchEnd].append(Int32(end))
            }
            return end
        case .repetition(let inner, let low, let high):
            var current = from
            for _ in 0..<low { current = try build(inner, from: current) }
            if let high {
                let end = newState()
                epsilons[current].append(Int32(end))
                for _ in low..<high {
                    let next = try build(inner, from: current)
                    epsilons[next].append(Int32(end))
                    current = next
                }
                return end
            }
            let loop = newState()
            epsilons[current].append(Int32(loop))
            let bodyEnd = try build(inner, from: loop)
            epsilons[bodyEnd].append(Int32(loop))
            let end = newState()
            epsilons[loop].append(Int32(end))
            return end
        }
    }

    struct Compiled {
        var edges: [[(set: ScalarSet, target: Int32)]]
        var closures: [[Int32]]
        var distance: [Int32]
    }

    func finish(start: Int, accept: Int) throws -> Compiled {
        let count = edges.count
        // Only what a JSON string holds without an escape.
        var cut = edges.map { list in
            list.compactMap { edge -> (set: ScalarSet, target: Int32)? in
                let set = edge.set.intersection(.writable)
                return set.isEmpty ? nil : (set, edge.target)
            }
        }
        // States that can still reach acceptance.
        var reverse = Array(repeating: [Int](), count: count)
        for state in 0..<count {
            for edge in cut[state] { reverse[Int(edge.target)].append(state) }
            for target in epsilons[state] { reverse[Int(target)].append(state) }
        }
        var live = Array(repeating: false, count: count)
        var queue = [accept]
        live[accept] = true
        while let state = queue.popLast() {
            for source in reverse[state] where !live[source] {
                live[source] = true
                queue.append(source)
            }
        }
        if !live[start] { throw GrammarError.unsupported("pattern matches no string") }
        for state in 0..<count {
            cut[state] = live[state] ? cut[state].filter { live[Int($0.target)] } : []
        }
        // Epsilon closures over live states.
        var closures = Array(repeating: [Int32](), count: count)
        for state in 0..<count where live[state] {
            var seen: Set<Int32> = [Int32(state)]
            var stack = [Int32(state)]
            while let current = stack.popLast() {
                for target in epsilons[Int(current)] where live[Int(target)] && !seen.contains(target) {
                    seen.insert(target)
                    stack.append(target)
                }
            }
            closures[state] = seen.sorted()
        }
        // Shortest distance to acceptance: an edge costs the bytes of its smallest character.
        let unreachable = Int32.max / 4
        var distance = Array(repeating: unreachable, count: count)
        distance[accept] = 0
        var changed = true
        while changed {
            changed = false
            for state in 0..<count where live[state] {
                var best = distance[state]
                for target in epsilons[state] where live[Int(target)] {
                    best = min(best, distance[Int(target)])
                }
                for edge in cut[state] {
                    let cost = Int32(UTF8Facts.byteLength(edge.set.minimum ?? 0))
                    best = min(best, cost + distance[Int(edge.target)])
                }
                if best < distance[state] {
                    distance[state] = best
                    changed = true
                }
            }
        }
        return Compiled(edges: cut, closures: closures, distance: distance)
    }
}
