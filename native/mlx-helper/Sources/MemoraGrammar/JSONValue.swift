import Foundation

/// A JSON value: the `schema` of a `generate` request and the literals (`enum`, `const`) it names.
public enum JSONValue: Equatable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    /// Parses JSON text.
    public static func parse(_ data: Data) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: data)
    }

    public static func parse(_ text: String) throws -> JSONValue {
        try parse(Data(text.utf8))
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let members) = self { return members[key] }
        return nil
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// A non-negative integer (`minLength`, `maxItems`, ...), or nil when the value is not one.
    var countValue: Int? {
        guard case .number(let value) = self, value >= 0, value.rounded() == value,
            value <= Double(Int32.max)
        else { return nil }
        return Int(value)
    }

    /// The bytes a model writes for this value in compact JSON: strings escape only what JSON
    /// requires, numbers use their shortest form, object members are sorted by key.
    public var canonicalBytes: [UInt8] {
        var bytes: [UInt8] = []
        appendCanonical(to: &bytes)
        return bytes
    }

    private func appendCanonical(to bytes: inout [UInt8]) {
        switch self {
        case .null: bytes.append(contentsOf: Array("null".utf8))
        case .bool(let value): bytes.append(contentsOf: Array((value ? "true" : "false").utf8))
        case .number(let value): bytes.append(contentsOf: Array(Self.numberText(value).utf8))
        case .string(let value): Self.appendString(value, to: &bytes)
        case .array(let items):
            bytes.append(UInt8(ascii: "["))
            for (index, item) in items.enumerated() {
                if index > 0 { bytes.append(UInt8(ascii: ",")) }
                item.appendCanonical(to: &bytes)
            }
            bytes.append(UInt8(ascii: "]"))
        case .object(let members):
            bytes.append(UInt8(ascii: "{"))
            for (index, key) in members.keys.sorted().enumerated() {
                if index > 0 { bytes.append(UInt8(ascii: ",")) }
                Self.appendString(key, to: &bytes)
                bytes.append(UInt8(ascii: ":"))
                members[key]!.appendCanonical(to: &bytes)
            }
            bytes.append(UInt8(ascii: "}"))
        }
    }

    /// A JSON string literal: `"` and `\` escaped, control characters as their short escape or
    /// `\u00XX`, everything else as its UTF-8 bytes.
    static func appendString(_ value: String, to bytes: inout [UInt8]) {
        bytes.append(UInt8(ascii: "\""))
        bytes.append(contentsOf: escapedStringContent(value))
        bytes.append(UInt8(ascii: "\""))
    }

    static func escapedStringContent(_ value: String) -> [UInt8] {
        var bytes: [UInt8] = []
        for byte in value.utf8 {
            switch byte {
            case UInt8(ascii: "\""): bytes.append(contentsOf: [0x5C, 0x22])
            case UInt8(ascii: "\\"): bytes.append(contentsOf: [0x5C, 0x5C])
            case 0x08: bytes.append(contentsOf: [0x5C, UInt8(ascii: "b")])
            case 0x0C: bytes.append(contentsOf: [0x5C, UInt8(ascii: "f")])
            case 0x0A: bytes.append(contentsOf: [0x5C, UInt8(ascii: "n")])
            case 0x0D: bytes.append(contentsOf: [0x5C, UInt8(ascii: "r")])
            case 0x09: bytes.append(contentsOf: [0x5C, UInt8(ascii: "t")])
            case 0..<0x20:
                bytes.append(contentsOf: Array(String(format: "\\u%04x", Int(byte)).utf8))
            default: bytes.append(byte)
            }
        }
        return bytes
    }

    /// The shortest text of a number as JavaScript writes it (`1`, `0.5`, `1e-7`).
    static func numberText(_ value: Double) -> String {
        if value.rounded() == value, abs(value) < 1e21 {
            return String(format: "%.0f", value)
        }
        var text = "\(value)"
        // Swift writes `1e-07`; JSON.stringify writes `1e-7`.
        if let exponent = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            let mantissa = text[..<exponent]
            var power = text[text.index(after: exponent)...]
            var sign = ""
            if power.first == "-" || power.first == "+" {
                if power.first == "-" { sign = "-" } else { sign = "+" }
                power = power.dropFirst()
            }
            while power.count > 1, power.first == "0" { power = power.dropFirst() }
            text = "\(mantissa)e\(sign)\(power)"
        }
        return text
    }
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}
