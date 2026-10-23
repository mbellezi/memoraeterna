// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "MemoraMlxHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "memora-mlx-helper", targets: ["MemoraMlxHelper"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift", exact: "0.31.6"),
        .package(url: "https://github.com/ml-explore/mlx-swift-lm", exact: "3.31.4"),
        .package(url: "https://github.com/huggingface/swift-transformers", exact: "1.3.3"),
    ],
    targets: [
        .executableTarget(
            name: "MemoraMlxHelper",
            dependencies: [
                "MemoraGrammar",
                .product(name: "MLXLLM", package: "mlx-swift-lm"),
                .product(name: "MLXVLM", package: "mlx-swift-lm"),
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
                .product(name: "MLXEmbedders", package: "mlx-swift-lm"),
                .product(name: "MLXHuggingFace", package: "mlx-swift-lm"),
                .product(name: "Tokenizers", package: "swift-transformers"),
            ]
        ),
        // JSON-constrained decoding (F4 D24): schema compiler, byte automaton, token trie and masks.
        // Pure Swift with no MLX import, so `swift test` runs it without the Metal library.
        .target(name: "MemoraGrammar"),
        // The fixture is read from the source tree (it is the desktop's catalog test output).
        .testTarget(name: "MemoraGrammarTests", dependencies: ["MemoraGrammar"], exclude: ["Fixtures"]),
    ]
)
