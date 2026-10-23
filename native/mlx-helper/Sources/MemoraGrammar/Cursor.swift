/// The byte automaton of a grammar: a stack of frames, one per JSON value being written, stepped one
/// byte at a time. Inside strings it tracks UTF-8 sequences (a partial character keeps the range of
/// characters it can still become), escapes and the pattern's DFA state; numbers keep the range their
/// digits can still reach.
///
/// Every change is journaled, so a caller can try bytes and roll back (`mark`, `rollback(to:)`): the
/// token trie walk tries every token from the same state. `commit` forgets the journal once a token
/// is accepted for real.
public struct GrammarCursor {
    enum FrameKind: UInt8 {
        case document, object, array, string, number, literal, anyObject, anyArray
    }

    struct Frame: Equatable {
        var kind: FrameKind
        var phase: UInt8 = 0
        /// Whitespace bytes since the last token of this container.
        var ws: UInt8 = 0
        /// string: UTF-8 sequence length or `\u` digits read; number: bit 0 set when negative.
        var small: UInt8 = 0
        /// Index of the node in its kind's table (`Grammar.objects`, ...), or the grammar node for
        /// the document.
        var node: Int32
        /// object: key trie node; array: items started; string: UTF-16 units; number: bytes;
        /// literal: trie node.
        var a: Int32 = 0
        /// object: current key; string: pattern DFA state; number: fraction digits; any containers:
        /// nesting depth.
        var b: Int32 = 0
        /// string: UTF-8 bits read or `\u` value; number: integer digits.
        var c: UInt32 = 0
        /// string: continuation bytes missing; number: exponent digits.
        var d: UInt32 = 0
        /// object: keys written.
        var m1: UInt64 = 0
        /// object: alternatives still possible.
        var m2: UInt64 = 0
        /// number: value of the integer part.
        var x: Double = 0
        /// number: fraction digits as an integer.
        var y: Double = 0
    }

    enum Undo {
        case set(Int, Frame)
        case push
        case pop(Frame)
    }

    // Phases.
    static let documentStart: UInt8 = 0
    static let documentValue: UInt8 = 1
    static let documentDone: UInt8 = 2

    static let objectExpectOpen: UInt8 = 0
    static let objectOpen: UInt8 = 1
    static let objectKey: UInt8 = 2
    static let objectColon: UInt8 = 3
    static let objectValueStart: UInt8 = 4
    static let objectValue: UInt8 = 5
    static let objectAfter: UInt8 = 6
    static let objectNextKey: UInt8 = 7

    static let arrayExpectOpen: UInt8 = 0
    static let arrayOpen: UInt8 = 1
    static let arrayValue: UInt8 = 2
    static let arrayAfter: UInt8 = 3
    static let arrayNext: UInt8 = 4

    static let stringExpectQuote: UInt8 = 0
    static let stringContent: UInt8 = 1
    static let stringEscape: UInt8 = 2
    static let stringUnicode: UInt8 = 3
    static let stringUTF8: UInt8 = 4

    static let numberStart: UInt8 = 0
    static let numberSign: UInt8 = 1
    static let numberZero: UInt8 = 2
    static let numberInteger: UInt8 = 3
    static let numberDot: UInt8 = 4
    static let numberFraction: UInt8 = 5
    static let numberE: UInt8 = 6
    static let numberExponentSign: UInt8 = 7
    static let numberExponent: UInt8 = 8

    /// Longest number text, and digits kept exact in a double.
    static let maxNumberBytes: Int32 = 24
    static let maxNumberDigits: UInt32 = 15

    private enum Outcome {
        case consumed
        case rejected
        /// The frame changed and a child starts; the child reads the same byte.
        case pushed(Frame)
        /// The frame changed and a child starts after this byte (an any object's key).
        case consumedPush(Frame)
        /// The value is complete with this byte.
        case doneConsumed
        /// The value was complete before this byte; the parent reads it.
        case doneRetry
    }

    let grammar: Grammar
    private(set) var frames: [Frame]
    private var journal: [Undo] = []

    public init(grammar: Grammar) {
        self.grammar = grammar
        frames = [Frame(kind: .document, node: Int32(grammar.root))]
        journal.reserveCapacity(256)
    }

    // MARK: Journal

    var mark: Int { journal.count }

    mutating func rollback(to mark: Int) {
        while journal.count > mark {
            switch journal.removeLast() {
            case .set(let index, let frame): frames[index] = frame
            case .push: frames.removeLast()
            case .pop(let frame): frames.append(frame)
            }
        }
    }

    /// Forgets the journal: the bytes stepped so far are accepted.
    public mutating func commit() {
        journal.removeAll(keepingCapacity: true)
    }

    private mutating func replaceTop(_ frame: Frame) {
        let index = frames.count - 1
        journal.append(.set(index, frames[index]))
        frames[index] = frame
    }

    private mutating func push(_ frame: Frame) {
        journal.append(.push)
        frames.append(frame)
    }

    private mutating func popTop() {
        journal.append(.pop(frames.removeLast()))
    }

    // MARK: Stepping

    /// Steps one byte. On `false` the state may be partly changed: roll back to a mark taken before.
    public mutating func step(_ byte: UInt8) -> Bool {
        while true {
            var frame = frames[frames.count - 1]
            let outcome: Outcome
            switch frame.kind {
            case .document: outcome = stepDocument(&frame, byte)
            case .object: outcome = stepObject(&frame, byte)
            case .array: outcome = stepArray(&frame, byte)
            case .string: outcome = stepString(&frame, byte)
            case .number: outcome = stepNumber(&frame, byte)
            case .literal: outcome = stepLiteral(&frame, byte)
            case .anyObject: outcome = stepAnyObject(&frame, byte)
            case .anyArray: outcome = stepAnyArray(&frame, byte)
            }
            switch outcome {
            case .consumed:
                replaceTop(frame)
                return true
            case .rejected:
                return false
            case .pushed(let child):
                replaceTop(frame)
                push(child)
            case .consumedPush(let child):
                replaceTop(frame)
                push(child)
                return true
            case .doneConsumed:
                completeTop()
                return true
            case .doneRetry:
                completeTop()
            }
        }
    }

    /// Steps every byte; false at the first byte the grammar refuses.
    public mutating func step<Bytes: Sequence>(bytes: Bytes) -> Bool where Bytes.Element == UInt8 {
        for byte in bytes where !step(byte) { return false }
        return true
    }

    private mutating func completeTop() {
        popTop()
        var parent = frames[frames.count - 1]
        switch parent.kind {
        case .document:
            parent.phase = Self.documentDone
        case .object:
            parent.phase = Self.objectAfter
        case .anyObject:
            parent.phase = parent.phase == Self.objectKey ? Self.objectColon : Self.objectAfter
        case .array, .anyArray:
            parent.phase = Self.arrayAfter
        default:
            break
        }
        parent.ws = 0
        replaceTop(parent)
    }

    @inline(__always)
    private static func isWhitespace(_ byte: UInt8) -> Bool {
        byte == 0x20 || byte == 0x0A || byte == 0x0D || byte == 0x09
    }

    @inline(__always)
    private func whitespace(_ frame: inout Frame) -> Outcome {
        guard frame.ws < Grammar.maxWhitespace else { return .rejected }
        frame.ws += 1
        return .consumed
    }

    /// The frame of a value of grammar node `node` that starts with `byte`, before reading it.
    private func valueFrame(_ node: Int, _ byte: UInt8, depth: Int32) -> Frame? {
        guard let resolved = grammar.resolve(node, byte) else { return nil }
        let ref = grammar.refs[resolved]
        switch ref.kind {
        case .object:
            let object = grammar.objects[Int(ref.index)]
            return Frame(kind: .object, node: ref.index, m2: object.allAlternatives)
        case .array:
            return Frame(kind: .array, node: ref.index)
        case .string:
            let pattern = grammar.strings[Int(ref.index)].pattern
            return Frame(kind: .string, node: ref.index, b: pattern.map { grammar.patterns[$0].start } ?? 0)
        case .number:
            return Frame(kind: .number, node: ref.index)
        case .literals:
            return Frame(kind: .literal, node: ref.index)
        case .any:
            switch byte {
            case UInt8(ascii: "{"):
                return depth < Grammar.maxAnyDepth ? Frame(kind: .anyObject, node: 0, b: depth) : nil
            case UInt8(ascii: "["):
                return depth < Grammar.maxAnyDepth ? Frame(kind: .anyArray, node: 0, b: depth) : nil
            case UInt8(ascii: "\""):
                return valueFrame(grammar.anyString, byte, depth: depth)
            case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"):
                return valueFrame(grammar.anyNumber, byte, depth: depth)
            default:
                return valueFrame(grammar.anyLiterals, byte, depth: depth)
            }
        case .union:
            return nil
        }
    }

    private func stepDocument(_ frame: inout Frame, _ byte: UInt8) -> Outcome {
        guard frame.phase == Self.documentStart,
            let child = valueFrame(Int(frame.node), byte, depth: 0)
        else { return .rejected }
        frame.phase = Self.documentValue
        return .pushed(child)
    }

    private func stepObject(_ frame: inout Frame, _ byte: UInt8) -> Outcome {
        let object = grammar.objects[Int(frame.node)]
        switch frame.phase {
        case Self.objectExpectOpen:
            guard byte == UInt8(ascii: "{") else { return .rejected }
            frame.phase = Self.objectOpen
            return .consumed
        case Self.objectOpen, Self.objectNextKey:
            if Self.isWhitespace(byte) { return whitespace(&frame) }
            if byte == UInt8(ascii: "\"") {
                guard object.allowedKeys(seen: frame.m1, live: frame.m2) != 0 else { return .rejected }
                frame.phase = Self.objectKey
                frame.a = 0
                frame.ws = 0
                return .consumed
            }
            if byte == UInt8(ascii: "}"), frame.phase == Self.objectOpen,
                object.closable(seen: frame.m1, live: frame.m2)
            {
                return .doneConsumed
            }
            return .rejected
        case Self.objectKey:
            let allowed = object.allowedKeys(seen: frame.m1, live: frame.m2)
            guard let child = object.trieChild(frame.a, byte),
                object.trieSubtree[Int(child)] & allowed != 0
            else { return .rejected }
            frame.a = child
            let key = object.trieKey[Int(child)]
            if key >= 0 {
                frame.b = Int32(key)
                frame.m1 |= 1 << UInt64(key)
                frame.m2 &= object.alternativesWithKey[Int(key)]
                frame.phase = Self.objectColon
            }
            return .consumed
        case Self.objectColon:
            if Self.isWhitespace(byte) { return whitespace(&frame) }
            guard byte == UInt8(ascii: ":") else { return .rejected }
            frame.phase = Self.objectValueStart
            frame.ws = 0
            return .consumed
        case Self.objectValueStart:
            if Self.isWhitespace(byte) { return whitespace(&frame) }
            guard let child = valueFrame(object.values[Int(frame.b)], byte, depth: 0) else {
                return .rejected
            }
            frame.phase = Self.objectValue
            frame.ws = 0
            return .pushed(child)
        case Self.objectAfter:
            if Self.isWhitespace(byte) { return whitespace(&frame) }
            if byte == UInt8(ascii: ",") {
                guard object.allowedKeys(seen: frame.m1, live: frame.m2) != 0 else { return .rejected }
                frame.phase = Self.objectNextKey
                frame.ws = 0
                return .consumed
            }
            if byte == UInt8(ascii: "}"), object.closable(seen: frame.m1, live: frame.m2) {
                return .doneConsumed
            }
            return .rejected
        default:
            return .rejected
        }
    }

    private func stepAnyObject(_ frame: inout Frame, _ byte: UInt8) -> Outcome {
        switch frame.phase {
        case Self.objectExpectOpen:
            guard byte == UInt8(ascii: "{") else { return .rejected }
            frame.phase = Self.objectOpen
            return .consumed
        case Self.objectOpen, Self.objectNextKey:
            if Self.isWhitespace(byte) { return whitespace(&frame) }
            if byte == UInt8(ascii: "\"") {
                frame.phase = Self.objectKey
                frame.ws = 0
                let index = grammar.refs[grammar.anyString].index
                return .consumedPush(Frame(kind: .string, phase: Self.stringContent, node: index))
            }
            if byte == UInt8(ascii: "}"), frame.phase == Self.objectOpen { return .doneConsumed }
            return .rejected
        case Self.objectColon:
            if Self.isWhitespace(byte) { return whitespace(&frame) }
            guard byte == UInt8(ascii: ":") else { return .rejected }
            frame.phase = Self.objectValueStart
            frame.ws = 0
            return .consumed
        case Self.objectValueStart:
            if Self.isWhitespace(byte) { return whitespace(&frame) }
            guard let child = valueFrame(grammar.anyNode, byte, depth: frame.b + 1) else {
                return .rejected
            }
            frame.phase = Self.objectValue
            frame.ws = 0
            return .pushed(child)
        case Self.objectAfter:
            if Self.isWhitespace(byte) { return whitespace(&frame) }
            if byte == UInt8(ascii: ",") {
                frame.phase = Self.objectNextKey
                frame.ws = 0
                return .consumed
            }
            return byte == UInt8(ascii: "}") ? .doneConsumed : .rejected
        default:
            return .rejected
        }
    }

    private func stepArray(_ frame: inout Frame, _ byte: UInt8) -> Outcome {
        let array = grammar.arrays[Int(frame.node)]
        switch frame.phase {
        case Self.arrayExpectOpen:
            guard byte == UInt8(ascii: "[") else { return .rejected }
            frame.phase = Self.arrayOpen
            return .consumed
        case Self.arrayOpen, Self.arrayNext:
            if Self.isWhitespace(byte) { return whitespace(&frame) }
            if byte == UInt8(ascii: "]"), frame.phase == Self.arrayOpen {
                return array.minItems == 0 ? .doneConsumed : .rejected
            }
            guard let node = array.itemNode(Int(frame.a)),
                let child = valueFrame(node, byte, depth: 0)
            else { return .rejected }
            frame.a += 1
            frame.phase = Self.arrayValue
            frame.ws = 0
            return .pushed(child)
        case Self.arrayAfter:
            if Self.isWhitespace(byte) { return whitespace(&frame) }
            if byte == UInt8(ascii: ",") {
                guard array.itemNode(Int(frame.a)) != nil else { return .rejected }
                frame.phase = Self.arrayNext
                frame.ws = 0
                return .consumed
            }
            if byte == UInt8(ascii: "]"), Int(frame.a) >= array.minItems { return .doneConsumed }
            return .rejected
        default:
            return .rejected
        }
    }

    private func stepAnyArray(_ frame: inout Frame, _ byte: UInt8) -> Outcome {
        switch frame.phase {
        case Self.arrayExpectOpen:
            guard byte == UInt8(ascii: "[") else { return .rejected }
            frame.phase = Self.arrayOpen
            return .consumed
        case Self.arrayOpen, Self.arrayNext:
            if Self.isWhitespace(byte) { return whitespace(&frame) }
            if byte == UInt8(ascii: "]"), frame.phase == Self.arrayOpen { return .doneConsumed }
            guard let child = valueFrame(grammar.anyNode, byte, depth: frame.b + 1) else {
                return .rejected
            }
            frame.a += 1
            frame.phase = Self.arrayValue
            frame.ws = 0
            return .pushed(child)
        case Self.arrayAfter:
            if Self.isWhitespace(byte) { return whitespace(&frame) }
            if byte == UInt8(ascii: ",") {
                frame.phase = Self.arrayNext
                frame.ws = 0
                return .consumed
            }
            return byte == UInt8(ascii: "]") ? .doneConsumed : .rejected
        default:
            return .rejected
        }
    }

    private func stepString(_ frame: inout Frame, _ byte: UInt8) -> Outcome {
        let string = grammar.strings[Int(frame.node)]
        switch frame.phase {
        case Self.stringExpectQuote:
            guard byte == UInt8(ascii: "\"") else { return .rejected }
            frame.phase = Self.stringContent
            return .consumed
        case Self.stringContent:
            if byte == UInt8(ascii: "\"") {
                guard frame.a >= string.minLength else { return .rejected }
                if let pattern = string.pattern, !grammar.patterns[pattern].isAccepting(frame.b) {
                    return .rejected
                }
                return .doneConsumed
            }
            if byte == UInt8(ascii: "\\") {
                // A pattern string is written without escapes.
                guard string.pattern == nil, fits(string, frame.a, 1) else { return .rejected }
                frame.phase = Self.stringEscape
                return .consumed
            }
            if byte < 0x20 { return .rejected }
            if byte < 0x80 {
                guard fits(string, frame.a, 1) else { return .rejected }
                if let pattern = string.pattern {
                    let next = grammar.patterns[pattern].step(frame.b, UInt32(byte))
                    guard next >= 0 else { return .rejected }
                    frame.b = next
                }
                frame.a += 1
                return .consumed
            }
            guard let continuations = UTF8Facts.continuationCount(lead: byte) else { return .rejected }
            let length = continuations + 1
            guard fits(string, frame.a, UTF8Facts.utf16Units(length: length)) else { return .rejected }
            let bits = UTF8Facts.leadBits(byte, continuations: continuations)
            guard let range = UTF8Facts.completions(accumulated: bits, remaining: continuations, length: length)
            else { return .rejected }
            if let pattern = string.pattern,
                !grammar.patterns[pattern].acceptsRange(frame.b, range.lowerBound, range.upperBound)
            {
                return .rejected
            }
            frame.phase = Self.stringUTF8
            frame.c = bits
            frame.d = UInt32(continuations)
            frame.small = UInt8(length)
            return .consumed
        case Self.stringUTF8:
            guard byte & 0xC0 == 0x80 else { return .rejected }
            let bits = (frame.c << 6) | UInt32(byte & 0x3F)
            let remaining = Int(frame.d) - 1
            let length = Int(frame.small)
            guard let range = UTF8Facts.completions(accumulated: bits, remaining: remaining, length: length)
            else { return .rejected }
            if let pattern = string.pattern {
                let machine = grammar.patterns[pattern]
                if remaining > 0 {
                    guard machine.acceptsRange(frame.b, range.lowerBound, range.upperBound) else {
                        return .rejected
                    }
                } else {
                    let next = machine.step(frame.b, bits)
                    guard next >= 0 else { return .rejected }
                    frame.b = next
                }
            }
            frame.c = bits
            frame.d = UInt32(remaining)
            if remaining == 0 {
                frame.phase = Self.stringContent
                frame.a += UTF8Facts.utf16Units(length: length)
                frame.small = 0
                frame.c = 0
            }
            return .consumed
        case Self.stringEscape:
            switch byte {
            case UInt8(ascii: "\""), UInt8(ascii: "\\"), UInt8(ascii: "/"), UInt8(ascii: "b"),
                UInt8(ascii: "f"), UInt8(ascii: "n"), UInt8(ascii: "r"), UInt8(ascii: "t"):
                frame.a += 1
                frame.phase = Self.stringContent
                return .consumed
            case UInt8(ascii: "u"):
                frame.phase = Self.stringUnicode
                frame.small = 0
                frame.c = 0
                return .consumed
            default:
                return .rejected
            }
        case Self.stringUnicode:
            guard let digit = Self.hexValue(byte) else { return .rejected }
            let value = (frame.c << 4) | digit
            let digits = Int(frame.small) + 1
            // Surrogate escapes are not written: a `\u` that can only be one is refused early.
            let shift = UInt32(4 * (4 - digits))
            let low = value << shift
            let high = low | ((1 << shift) - 1)
            if low >= 0xD800, high <= 0xDFFF { return .rejected }
            if digits == 4 {
                frame.a += 1
                frame.phase = Self.stringContent
                frame.small = 0
                frame.c = 0
            } else {
                frame.c = value
                frame.small = UInt8(digits)
            }
            return .consumed
        default:
            return .rejected
        }
    }

    @inline(__always)
    private func fits(_ string: StringNode, _ length: Int32, _ units: Int32) -> Bool {
        guard let maxLength = string.maxLength else { return true }
        return length + units <= maxLength
    }

    private static func hexValue(_ byte: UInt8) -> UInt32? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return UInt32(byte - UInt8(ascii: "0"))
        case UInt8(ascii: "a")...UInt8(ascii: "f"): return UInt32(byte - UInt8(ascii: "a") + 10)
        case UInt8(ascii: "A")...UInt8(ascii: "F"): return UInt32(byte - UInt8(ascii: "A") + 10)
        default: return nil
        }
    }

    private func stepNumber(_ frame: inout Frame, _ byte: UInt8) -> Outcome {
        let number = grammar.numbers[Int(frame.node)]
        let isDigit = byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9")
        let digit = Double(byte &- UInt8(ascii: "0"))
        switch frame.phase {
        case Self.numberStart, Self.numberSign:
            if byte == UInt8(ascii: "-"), frame.phase == Self.numberStart {
                frame.small |= 1
                frame.phase = Self.numberSign
            } else if byte == UInt8(ascii: "0") {
                frame.phase = Self.numberZero
            } else if isDigit {
                frame.phase = Self.numberInteger
                frame.x = digit
                frame.c = 1
            } else {
                return .rejected
            }
            frame.a += 1
            return Self.feasible(frame, number) ? .consumed : .rejected
        case Self.numberZero, Self.numberInteger, Self.numberFraction, Self.numberExponent:
            if isDigit {
                switch frame.phase {
                case Self.numberZero:
                    return .rejected
                case Self.numberInteger:
                    guard frame.c < Self.maxNumberDigits else { return .rejected }
                    frame.x = frame.x * 10 + digit
                    frame.c += 1
                case Self.numberFraction:
                    guard frame.b < Int32(Self.maxNumberDigits) else { return .rejected }
                    frame.y = frame.y * 10 + digit
                    frame.b += 1
                default:
                    guard frame.d < 3 else { return .rejected }
                    frame.d += 1
                }
                frame.a += 1
                guard frame.a <= Self.maxNumberBytes else { return .rejected }
                return Self.feasible(frame, number) ? .consumed : .rejected
            }
            if byte == UInt8(ascii: "."),
                frame.phase == Self.numberZero || frame.phase == Self.numberInteger, !number.integer
            {
                frame.phase = Self.numberDot
                frame.a += 1
                return Self.feasible(frame, number) ? .consumed : .rejected
            }
            if byte == UInt8(ascii: "e") || byte == UInt8(ascii: "E") {
                // Exponents only where nothing bounds the value.
                guard frame.phase != Self.numberExponent, !number.integer, !number.bounded else {
                    return .rejected
                }
                frame.phase = Self.numberE
                frame.a += 1
                return .consumed
            }
            return Self.inRange(frame, number) ? .doneRetry : .rejected
        case Self.numberDot:
            guard isDigit else { return .rejected }
            frame.phase = Self.numberFraction
            frame.y = digit
            frame.b = 1
            frame.a += 1
            return Self.feasible(frame, number) ? .consumed : .rejected
        case Self.numberE:
            if byte == UInt8(ascii: "+") || byte == UInt8(ascii: "-") {
                frame.phase = Self.numberExponentSign
                frame.a += 1
                return .consumed
            }
            guard isDigit else { return .rejected }
            frame.phase = Self.numberExponent
            frame.d = 1
            frame.a += 1
            return .consumed
        case Self.numberExponentSign:
            guard isDigit else { return .rejected }
            frame.phase = Self.numberExponent
            frame.d = 1
            frame.a += 1
            return .consumed
        default:
            return .rejected
        }
    }

    /// The value of a number frame (exponents are only written unbounded, so they are not read).
    private static func value(_ frame: Frame) -> Double {
        var magnitude = frame.x
        if frame.b > 0 { magnitude += frame.y / pow10(Int(frame.b)) }
        return frame.small & 1 != 0 ? -magnitude : magnitude
    }

    private static func pow10(_ exponent: Int) -> Double {
        var result = 1.0
        for _ in 0..<exponent { result *= 10 }
        return result
    }

    static func isNumberComplete(_ phase: UInt8) -> Bool {
        phase == numberZero || phase == numberInteger || phase == numberFraction
            || phase == numberExponent
    }

    private static func inRange(_ frame: Frame, _ number: NumberNode) -> Bool {
        guard isNumberComplete(frame.phase) else { return false }
        if !number.bounded || frame.phase == numberExponent { return true }
        return number.contains(value(frame))
    }

    /// Whether the digits written so far can still end inside the bounds.
    private static func feasible(_ frame: Frame, _ number: NumberNode) -> Bool {
        guard number.bounded else { return true }
        let negative = frame.small & 1 != 0
        // Magnitudes the number can still reach: [low, high) (`high` closed when `closed`).
        func check(_ low: Double, _ high: Double, highClosed: Bool) -> Bool {
            negative
                ? number.meets(-high, highClosed, -low, true)
                : number.meets(low, true, high, highClosed)
        }
        switch frame.phase {
        case numberSign:
            return check(0, .infinity, highClosed: false)
        case numberZero:
            return number.integer ? check(0, 0, highClosed: true) : check(0, 1, highClosed: false)
        case numberInteger:
            // More digits multiply the integer part by ten each.
            var scale = 1.0
            var digits = frame.c
            while digits <= maxNumberDigits {
                let low = frame.x * scale
                let high = (frame.x + 1) * scale
                if number.integer {
                    if check(low, high - 1, highClosed: true) { return true }
                } else if check(low, high, highClosed: false) {
                    return true
                }
                scale *= 10
                digits += 1
            }
            return false
        case numberDot:
            return check(frame.x, frame.x + 1, highClosed: false)
        case numberFraction:
            let unit = 1 / pow10(Int(frame.b))
            let low = frame.x + frame.y * unit
            return check(low, low + unit, highClosed: false)
        default:
            return true
        }
    }

    private func stepLiteral(_ frame: inout Frame, _ byte: UInt8) -> Outcome {
        let trie = grammar.literals[Int(frame.node)]
        if let child = trie.child(frame.a, byte) {
            frame.a = child
            if trie.terminal[Int(child)], trie.children[Int(child)].isEmpty { return .doneConsumed }
            return .consumed
        }
        return trie.terminal[Int(frame.a)] ? .doneRetry : .rejected
    }

    // MARK: Queries

    /// Whether the document is complete: only an end-of-sequence token may follow.
    public var isComplete: Bool {
        if frames.count == 1 { return frames[0].phase == Self.documentDone }
        // A number or a literal at the root ends with the text.
        guard frames.count == 2 else { return false }
        let top = frames[1]
        switch top.kind {
        case .number: return Self.inRange(top, grammar.numbers[Int(top.node)])
        case .literal: return grammar.literals[Int(top.node)].terminal[Int(top.a)]
        default: return false
        }
    }

    /// The fewest bytes that complete the document from here.
    public var distance: Int {
        var total = 0
        for frame in frames { total += remainder(frame) }
        return total
    }

    private func remainder(_ frame: Frame) -> Int {
        switch frame.kind {
        case .document:
            return frame.phase == Self.documentStart ? grammar.minSizes[Int(frame.node)] : 0
        case .object:
            let object = grammar.objects[Int(frame.node)]
            switch frame.phase {
            case Self.objectExpectOpen:
                return object.minClose(seen: 0, live: object.allAlternatives, first: true) + 1
            case Self.objectOpen:
                return object.minClose(seen: frame.m1, live: frame.m2, first: true)
            case Self.objectKey:
                return object.minFromKey(node: frame.a, seen: frame.m1, live: frame.m2)
            case Self.objectColon:
                return 1 + object.valueMin[Int(frame.b)]
                    + object.minClose(seen: frame.m1, live: frame.m2, first: false)
            case Self.objectValueStart:
                return object.valueMin[Int(frame.b)]
                    + object.minClose(seen: frame.m1, live: frame.m2, first: false)
            case Self.objectNextKey:
                return object.minNextPair(seen: frame.m1, live: frame.m2)
            default:
                return object.minClose(seen: frame.m1, live: frame.m2, first: false)
            }
        case .array:
            let array = grammar.arrays[Int(frame.node)]
            let count = Int(frame.a)
            switch frame.phase {
            case Self.arrayExpectOpen:
                return array.minItems == 0 ? 2 : array.suffix[0] + 1
            case Self.arrayOpen:
                return array.minItems == 0 ? 1 : array.suffix[0]
            case Self.arrayNext:
                let rest = count + 1 < array.minItems ? array.suffix[count + 1] : 0
                return array.itemMinimum(count) + rest + 1
            default:
                return (count < array.minItems ? array.suffix[count] : 0) + 1
            }
        case .string:
            let string = grammar.strings[Int(frame.node)]
            let missing = max(0, Int(string.minLength) - Int(frame.a))
            let patternBytes = string.pattern.map { grammar.patterns[$0].distance(frame.b) } ?? 0
            switch frame.phase {
            case Self.stringExpectQuote:
                return 2 + max(Int(string.minLength), patternBytes)
            case Self.stringEscape:
                return 1 + max(0, missing - 1) + 1
            case Self.stringUnicode:
                return (4 - Int(frame.small)) + max(0, missing - 1) + 1
            case Self.stringUTF8:
                let pending = Int(frame.d)
                let written = Int(frame.small) - pending
                return max(pending + max(0, missing - 1), patternBytes - written) + 1
            default:
                return max(missing, patternBytes) + 1
            }
        case .number:
            let number = grammar.numbers[Int(frame.node)]
            switch frame.phase {
            case Self.numberStart:
                return NumberText.shortestLength(number) ?? 1
            case Self.numberSign, Self.numberDot, Self.numberE, Self.numberExponentSign:
                return number.bounded ? 2 : 1
            default:
                return Self.inRange(frame, number) ? 0 : 2
            }
        case .literal:
            return Int(grammar.literals[Int(frame.node)].minRemaining[Int(frame.a)])
        case .anyObject:
            switch frame.phase {
            case Self.objectExpectOpen: return 2
            case Self.objectOpen, Self.objectAfter, Self.objectValue: return 1
            case Self.objectKey, Self.objectColon: return 3
            case Self.objectValueStart: return 2
            default: return 5
            }
        case .anyArray:
            switch frame.phase {
            case Self.arrayExpectOpen: return 2
            case Self.arrayNext: return 2
            default: return 1
            }
        }
    }

    /// The state as far as masks can tell, appended to `key`; false when it is not worth caching
    /// (inside a number). A counter reads the same however far it is from every bound one token can
    /// reach: a string's length once its minimum is met and its maximum is further than the longest
    /// run of its characters in a token (`reaches[pattern]`, else `maxTokenBytes`); an array's count
    /// once its minimum is met and its maximum is further than the items one token can hold.
    func signature(into key: inout [Int64], maxTokenBytes: Int32, reaches: [Int32]) -> Bool {
        for frame in frames {
            key.append(
                Int64(frame.kind.rawValue) | Int64(frame.phase) << 8 | Int64(frame.ws) << 16
                    | Int64(frame.small) << 24 | Int64(frame.node) << 32)
            switch frame.kind {
            case .document:
                break
            case .object:
                key.append(Int64(frame.a) | Int64(frame.b) << 32)
                key.append(Int64(bitPattern: frame.m1))
                key.append(Int64(bitPattern: frame.m2))
            case .array:
                let array = grammar.arrays[Int(frame.node)]
                let count = Int(frame.a)
                let perToken = (Int(maxTokenBytes) + 1) / (array.minItemBytes + 1) + 1
                let exact =
                    count < array.minItems || count <= array.prefix.count
                    || (array.maxItems.map { $0 - count <= perToken } ?? false)
                key.append(exact ? Int64(count) : -1)
            case .string:
                let string = grammar.strings[Int(frame.node)]
                let length = frame.a
                let reach = string.pattern.map { reaches[$0] } ?? maxTokenBytes
                let room = string.maxLength.map { $0 - length }
                let near = room.map { $0 < reach } ?? false
                key.append(Int64(min(length, string.minLength)) | (near ? Int64(room!) : -1) << 32)
                key.append(Int64(frame.b) | Int64(frame.c) << 32)
                key.append(Int64(frame.d))
            case .number:
                return false
            case .literal:
                key.append(Int64(frame.a))
            case .anyObject, .anyArray:
                key.append(Int64(frame.b))
            }
        }
        return true
    }

    /// When the top frame is the content of a string with a pattern: the pattern, its DFA state, the
    /// UTF-16 units the string may still hold, the frame's share of `distance`, and the characters
    /// its minimum length still needs.
    func patternStringState() -> (pattern: Int, state: Int32, room: Int32, remainder: Int, missing: Int)? {
        let top = frames[frames.count - 1]
        guard top.kind == .string, top.phase == Self.stringContent else { return nil }
        let string = grammar.strings[Int(top.node)]
        guard let pattern = string.pattern else { return nil }
        return (
            pattern, top.b, string.maxLength.map { $0 - top.a } ?? Int32.max, remainder(top),
            max(0, Int(string.minLength) - Int(top.a))
        )
    }

    /// When the top frame is the content of a string without a pattern: the UTF-16 units it may
    /// still hold (`Int32.max` without a maximum). Every token of plain characters that fits is
    /// allowed there. Nil anywhere else.
    func plainStringRoom() -> Int32? {
        let top = frames[frames.count - 1]
        guard top.kind == .string, top.phase == Self.stringContent else { return nil }
        let string = grammar.strings[Int(top.node)]
        guard string.pattern == nil else { return nil }
        return string.maxLength.map { $0 - top.a } ?? Int32.max
    }
}
