/// A set of Unicode scalar values as sorted, disjoint, non-adjacent closed ranges.
struct ScalarSet: Hashable, Sendable {
    static let maxScalar: UInt32 = 0x10FFFF
    static let empty = ScalarSet(normalized: [])
    static let all = ScalarSet(normalized: [0...maxScalar])

    /// What a JSON string may hold without an escape: no control character, quote or backslash.
    static let writable = ScalarSet([0x20...0x21, 0x23...0x5B, 0x5D...0xD7FF, 0xE000...maxScalar])

    private(set) var ranges: [ClosedRange<UInt32>]

    private init(normalized: [ClosedRange<UInt32>]) {
        ranges = normalized
    }

    init(_ ranges: [ClosedRange<UInt32>]) {
        let sorted = ranges.sorted { $0.lowerBound < $1.lowerBound }
        var merged: [ClosedRange<UInt32>] = []
        for range in sorted {
            if let last = merged.last, range.lowerBound <= last.upperBound &+ 1,
                last.upperBound != UInt32.max
            {
                merged[merged.count - 1] = last.lowerBound...max(last.upperBound, range.upperBound)
            } else {
                merged.append(range)
            }
        }
        self.ranges = merged
    }

    init(scalar: UInt32) {
        ranges = [scalar...scalar]
    }

    var isEmpty: Bool { ranges.isEmpty }

    var minimum: UInt32? { ranges.first?.lowerBound }

    func contains(_ scalar: UInt32) -> Bool {
        var low = 0
        var high = ranges.count - 1
        while low <= high {
            let middle = (low + high) / 2
            let range = ranges[middle]
            if scalar < range.lowerBound {
                high = middle - 1
            } else if scalar > range.upperBound {
                low = middle + 1
            } else {
                return true
            }
        }
        return false
    }

    /// Whether some scalar in `low...high` is in the set.
    func intersects(_ low: UInt32, _ high: UInt32) -> Bool {
        for range in ranges {
            if range.lowerBound > high { return false }
            if range.upperBound >= low { return true }
        }
        return false
    }

    func union(_ other: ScalarSet) -> ScalarSet {
        ScalarSet(ranges + other.ranges)
    }

    func intersection(_ other: ScalarSet) -> ScalarSet {
        var result: [ClosedRange<UInt32>] = []
        var left = 0
        var right = 0
        while left < ranges.count, right < other.ranges.count {
            let a = ranges[left]
            let b = other.ranges[right]
            let low = max(a.lowerBound, b.lowerBound)
            let high = min(a.upperBound, b.upperBound)
            if low <= high { result.append(low...high) }
            if a.upperBound < b.upperBound { left += 1 } else { right += 1 }
        }
        return ScalarSet(normalized: result)
    }

    /// The scalars of `0...maxScalar` that are not in the set.
    func complement() -> ScalarSet {
        var result: [ClosedRange<UInt32>] = []
        var next: UInt32 = 0
        for range in ranges {
            if range.lowerBound > next { result.append(next...(range.lowerBound - 1)) }
            if range.upperBound >= ScalarSet.maxScalar { return ScalarSet(normalized: result) }
            next = range.upperBound + 1
        }
        result.append(next...ScalarSet.maxScalar)
        return ScalarSet(normalized: result)
    }
}

/// UTF-8 facts the byte automaton uses inside strings.
enum UTF8Facts {
    /// The scalars a sequence of `length` bytes may encode (overlong forms excluded).
    static func scalarRange(length: Int) -> ClosedRange<UInt32> {
        switch length {
        case 1: return 0...0x7F
        case 2: return 0x80...0x7FF
        case 3: return 0x800...0xFFFF
        default: return 0x10000...0x10FFFF
        }
    }

    /// The number of continuation bytes after a lead byte, or nil for a byte that cannot lead.
    static func continuationCount(lead: UInt8) -> Int? {
        switch lead {
        case 0xC2...0xDF: return 1
        case 0xE0...0xEF: return 2
        case 0xF0...0xF4: return 3
        default: return nil
        }
    }

    /// The payload bits of a lead byte of a sequence with `continuations` continuation bytes.
    static func leadBits(_ lead: UInt8, continuations: Int) -> UInt32 {
        switch continuations {
        case 1: return UInt32(lead & 0x1F)
        case 2: return UInt32(lead & 0x0F)
        default: return UInt32(lead & 0x07)
        }
    }

    /// The scalars a partial sequence can still become: `accumulated` holds the bits read so far and
    /// `remaining` continuation bytes are missing. Surrogates are not scalars, so a range inside
    /// `D800-DFFF` is empty; one that spans it is reported whole (callers check sets that exclude it).
    static func completions(accumulated: UInt32, remaining: Int, length: Int) -> ClosedRange<UInt32>? {
        let shift = UInt32(6 * remaining)
        let low = accumulated << shift
        let high = low | ((1 << shift) - 1)
        let valid = scalarRange(length: length)
        let clampedLow = max(low, valid.lowerBound)
        let clampedHigh = min(high, valid.upperBound)
        guard clampedLow <= clampedHigh else { return nil }
        if clampedLow >= 0xD800, clampedHigh <= 0xDFFF { return nil }
        return clampedLow...clampedHigh
    }

    /// UTF-16 code units of a scalar: what JavaScript's `length` (and so Zod) counts.
    static func utf16Units(length: Int) -> Int32 {
        length == 4 ? 2 : 1
    }

    /// Bytes of the UTF-8 encoding of a scalar.
    static func byteLength(_ scalar: UInt32) -> Int {
        switch scalar {
        case 0..<0x80: return 1
        case 0x80..<0x800: return 2
        case 0x800..<0x10000: return 3
        default: return 4
        }
    }
}
