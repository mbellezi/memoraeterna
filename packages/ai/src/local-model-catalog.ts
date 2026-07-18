import { createHash } from "node:crypto";

import { z } from "zod";
import {
  AiCapabilitySchema,
  AiModelParameterCapabilitiesSchema,
  AiModelParametersSchema,
  normalizeAiModelParameters,
  type AiModelParameterCapabilities,
  type AiModelParameters
} from "@app/domain";

export const localModelRuntimeSchema = z.enum(["gguf", "mlx"]);
export type LocalModelRuntime = z.infer<typeof localModelRuntimeSchema>;

export const localModelCatalogFileSchema = z.object({
  path: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type LocalModelCatalogFile = z.infer<typeof localModelCatalogFileSchema>;

export const localModelRecommendedParametersSchema = z.object({
  reasoning: AiModelParametersSchema.optional(),
  nonReasoning: AiModelParametersSchema.optional()
}).strict().refine(
  (presets) => presets.reasoning !== undefined || presets.nonReasoning !== undefined,
  { message: "At least one recommended parameter preset is required." }
);
export type LocalModelRecommendedParameters = z.infer<typeof localModelRecommendedParametersSchema>;

export const localModelCatalogEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]+$/),
  displayName: z.string().min(1),
  family: z.string().min(1),
  variant: z.string().min(1),
  runtime: localModelRuntimeSchema,
  repository: z.string().min(3),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  format: z.enum(["safetensors", "gguf"]),
  quantization: z.string().min(1),
  capabilities: z.array(AiCapabilitySchema).min(1),
  parameterCapabilities: AiModelParameterCapabilitiesSchema,
  defaultParameters: AiModelParametersSchema.default({}),
  recommendedParameters: localModelRecommendedParametersSchema.optional(),
  minimumMemoryBytes: z.number().int().positive(),
  recommendedMemoryBytes: z.number().int().positive(),
  license: z.string().min(1),
  licenseUrl: z.string().url(),
  requiresLicenseAcceptance: z.boolean(),
  files: z.array(localModelCatalogFileSchema).min(1)
}).strict().superRefine((entry, context) => {
  const paths = new Set<string>();
  for (const [index, file] of entry.files.entries()) {
    if (!isSafeModelRelativePath(file.path)) {
      context.addIssue({ code: "custom", message: "Unsafe model file path.", path: ["files", index, "path"] });
    }
    if (paths.has(file.path)) {
      context.addIssue({ code: "custom", message: "Duplicate model file path.", path: ["files", index, "path"] });
    }
    paths.add(file.path);
  }
  if (entry.recommendedMemoryBytes < entry.minimumMemoryBytes) {
    context.addIssue({ code: "custom", message: "Recommended memory must be at least the minimum.", path: ["recommendedMemoryBytes"] });
  }
  validateSupportedParameters(entry.defaultParameters, entry.parameterCapabilities, context, ["defaultParameters"]);
  if (entry.recommendedParameters?.reasoning && !entry.parameterCapabilities.reasoning) {
    context.addIssue({ code: "custom", message: "A reasoning preset requires reasoning capability.", path: ["recommendedParameters", "reasoning"] });
  }
  if (entry.recommendedParameters?.reasoning) {
    if (entry.recommendedParameters.reasoning.reasoningLevel === "off") {
      context.addIssue({ code: "custom", message: "A reasoning preset cannot disable reasoning.", path: ["recommendedParameters", "reasoning", "reasoningLevel"] });
    }
    validateSupportedParameters(
      entry.recommendedParameters.reasoning,
      entry.parameterCapabilities,
      context,
      ["recommendedParameters", "reasoning"]
    );
  }
  if (entry.recommendedParameters?.nonReasoning) {
    const level = entry.recommendedParameters.nonReasoning.reasoningLevel;
    if (level !== undefined && level !== "off") {
      context.addIssue({ code: "custom", message: "A non-reasoning preset cannot enable reasoning.", path: ["recommendedParameters", "nonReasoning", "reasoningLevel"] });
    }
    validateSupportedParameters(
      entry.recommendedParameters.nonReasoning,
      entry.parameterCapabilities,
      context,
      ["recommendedParameters", "nonReasoning"]
    );
  }
});
export type LocalModelCatalogEntry = z.infer<typeof localModelCatalogEntrySchema>;

const gib = 1024 ** 3;
const textCapabilities = [
  "text-generation",
  "structured-output",
  "summarization",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "reranking",
  "cancellation",
  "offline",
  "local-files",
  "supports-progress-events"
] as const;

export const localModelCatalog = localModelCatalogEntrySchema.array().parse([
  {
    id: "gguf-qwen3-embedding-0.6b-q8-0",
    displayName: "Qwen3-Embedding-0.6B Q8_0",
    family: "Qwen3 Embedding",
    variant: "0.6B Q8_0",
    runtime: "gguf",
    repository: "Qwen/Qwen3-Embedding-0.6B-GGUF",
    revision: "370f27d7550e0def9b39c1f16d3fbaa13aa67728",
    format: "gguf",
    quantization: "Q8_0",
    capabilities: ["embedding", "offline", "local-files"],
    parameterCapabilities: {
      contextWindow: { min: 128, max: 2_000_000, step: 1 },
      dimensions: { values: [256, 768, 1_024] }
    },
    defaultParameters: { contextWindow: 8_192, dimensions: 1_024 },
    minimumMemoryBytes: 2 * gib,
    recommendedMemoryBytes: 4 * gib,
    license: "Apache-2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    requiresLicenseAcceptance: false,
    files: [
      {
        path: "Qwen3-Embedding-0.6B-Q8_0.gguf",
        sizeBytes: 639_150_592,
        sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"
      }
    ]
  },
  {
    id: "gguf-bge-m3-q8-0",
    displayName: "BGE-M3 Q8_0",
    family: "BGE-M3",
    variant: "Q8_0",
    runtime: "gguf",
    repository: "ggml-org/bge-m3-Q8_0-GGUF",
    revision: "9eba04c5d75ba5a1595e45de734d36bef4e5cb98",
    format: "gguf",
    quantization: "Q8_0",
    capabilities: ["embedding", "offline", "local-files"],
    parameterCapabilities: {
      contextWindow: { min: 128, max: 2_000_000, step: 1 },
      dimensions: { values: [256, 768, 1_024] }
    },
    defaultParameters: { contextWindow: 8_192, dimensions: 1_024 },
    minimumMemoryBytes: 2 * gib,
    recommendedMemoryBytes: 4 * gib,
    license: "MIT",
    licenseUrl: "https://opensource.org/license/mit",
    requiresLicenseAcceptance: false,
    files: [
      {
        path: "bge-m3-q8_0.gguf",
        sizeBytes: 634_553_760,
        sha256: "aa473d51f451a22f0fcf39ba3330c14bed38a385712b1113440f69df4047a173"
      }
    ]
  },
  {
    id: "mlx-gemma-4-e4b-it-4bit",
    displayName: "Gemma 4 E4B Instruct 4-bit",
    family: "Gemma 4",
    variant: "E4B Instruct",
    runtime: "mlx",
    repository: "mlx-community/gemma-4-e4b-it-4bit",
    revision: "475b9088d29754a3379866cf5aeb6b41acd313c2",
    format: "safetensors",
    quantization: "4-bit",
    capabilities: textCapabilities,
    parameterCapabilities: {
      temperature: { min: 0, max: 2, step: 0.1 },
      maxTokens: { min: 1, max: 32_768, step: 1 },
      topP: { min: 0, max: 1, step: 0.05 },
      topK: { min: 1, step: 1 },
      presencePenalty: { min: -2, max: 2, step: 0.1 },
      seed: { min: 0, step: 1 }
    },
    defaultParameters: { temperature: 1, topP: 0.95, topK: 64 },
    recommendedParameters: {
      nonReasoning: { temperature: 1, topP: 0.95, topK: 64 }
    },
    minimumMemoryBytes: 8 * gib,
    recommendedMemoryBytes: 16 * gib,
    license: "Gemma",
    licenseUrl: "https://ai.google.dev/gemma/terms",
    requiresLicenseAcceptance: true,
    files: [
      { path: "chat_template.jinja", sizeBytes: 17_336, sha256: "2f1b4d75d067bae3fe44e676721c7f077d243bc007156cb9c2f8b5836613d082" },
      { path: "config.json", sizeBytes: 6_628, sha256: "780ccb3a514a5f1ced161d383f948fc22eca9b84b752ca19494f625bd9bad7a6" },
      { path: "generation_config.json", sizeBytes: 208, sha256: "d4226bbe3117d2d253ba4609720ba82c6c4ce4627a9a6ae05387c78983ac03de" },
      { path: "model.safetensors", sizeBytes: 5_146_800_534, sha256: "932b8271fc3fe65adcc78b96c10c6268bbfb13e8f67d1358727c0d6ee97e1eff" },
      { path: "model.safetensors.index.json", sizeBytes: 240_961, sha256: "f8accac59ee7efe87e0c298c854610b262c3cadd477407503147c71209ff0093" },
      { path: "processor_config.json", sizeBytes: 1_316, sha256: "de3e580aebdc98272d4c4547daffe6525fcbae18a83a0e0bcf0d7444d4ee6f37" },
      { path: "tokenizer.json", sizeBytes: 32_169_626, sha256: "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f" },
      { path: "tokenizer_config.json", sizeBytes: 2_740, sha256: "080d9e1aff284e2f6043889cd05367966f7c7b80e025fbc0b06745e218158656" }
    ]
  },
  {
    id: "mlx-gemma-4-12b-it-4bit",
    displayName: "Gemma 4 12B Instruct 4-bit",
    family: "Gemma 4",
    variant: "12B Instruct",
    runtime: "mlx",
    repository: "mlx-community/gemma-4-12B-it-4bit",
    revision: "73bcf09092aa277861d5a191b989b666f7f32e8f",
    format: "safetensors",
    quantization: "4-bit",
    capabilities: textCapabilities,
    parameterCapabilities: {
      temperature: { min: 0, max: 2, step: 0.1 },
      maxTokens: { min: 1, max: 32_768, step: 1 },
      topP: { min: 0, max: 1, step: 0.05 },
      topK: { min: 1, step: 1 },
      presencePenalty: { min: -2, max: 2, step: 0.1 },
      seed: { min: 0, step: 1 }
    },
    defaultParameters: { temperature: 1, topP: 0.95, topK: 64 },
    recommendedParameters: {
      nonReasoning: { temperature: 1, topP: 0.95, topK: 64 }
    },
    minimumMemoryBytes: 16 * gib,
    recommendedMemoryBytes: 24 * gib,
    license: "Gemma",
    licenseUrl: "https://ai.google.dev/gemma/terms",
    requiresLicenseAcceptance: true,
    files: [
      { path: "chat_template.jinja", sizeBytes: 17_466, sha256: "36e3a42e5cf14cd0020e72d92e1fdd9970f59b82170e421f0cbe1bb42bead3f0" },
      { path: "config.json", sizeBytes: 5_415, sha256: "fbc1c1cb48ed86ec98482b2d41f5a03d3991aba74b7c29a93d430761e6518a38" },
      { path: "generation_config.json", sizeBytes: 260, sha256: "a8349d9bd64cc5841297fcb5002f0fdc4749c473c8f1b10ea337f9ce4ee7014e" },
      { path: "model-00001-of-00002.safetensors", sizeBytes: 5_351_756_584, sha256: "0d58feed0c98a69c07317b4481aeae5ab2785f12a496ea96ab24c4842808de78" },
      { path: "model-00002-of-00002.safetensors", sizeBytes: 1_389_282_927, sha256: "5b00a1bcb596ce6e827b4cdea6ecf2a0f35bb01306eb87c1ea4b3bcde36c7755" },
      { path: "model.safetensors.index.json", sizeBytes: 135_329, sha256: "9ac99e7a6cf3e4d40eb8df01644fe9c04036ace94f3389df35db9d9449758516" },
      { path: "processor_config.json", sizeBytes: 868, sha256: "016a1db9c4f41ea0c61919c46855ea5e7c45c6e4ae4bfbedfb5b6bed79a2fe92" },
      { path: "tokenizer.json", sizeBytes: 32_169_626, sha256: "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f" },
      { path: "tokenizer_config.json", sizeBytes: 2_719, sha256: "fc1384a911d2c9860ac07bc3ceafff20bff26695991744b7dbe5e1e4522bfa57" }
    ]
  },
  {
    id: "mlx-qwen3-4b-instruct-2507-4bit",
    displayName: "Qwen3 4B Instruct 2507 4-bit",
    family: "Qwen3",
    variant: "4B Instruct 2507",
    runtime: "mlx",
    repository: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
    revision: "50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b",
    format: "safetensors",
    quantization: "4-bit",
    capabilities: textCapabilities,
    parameterCapabilities: {
      temperature: { min: 0, max: 2, step: 0.1 },
      maxTokens: { min: 1, max: 32_768, step: 1 },
      topP: { min: 0, max: 1, step: 0.05 },
      topK: { min: 1, step: 1 },
      presencePenalty: { min: -2, max: 2, step: 0.1 },
      seed: { min: 0, step: 1 }
    },
    defaultParameters: { temperature: 0.7, maxTokens: 16_384, topP: 0.8, topK: 20 },
    recommendedParameters: {
      nonReasoning: { temperature: 0.7, maxTokens: 16_384, topP: 0.8, topK: 20 }
    },
    minimumMemoryBytes: 8 * gib,
    recommendedMemoryBytes: 12 * gib,
    license: "Apache-2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    requiresLicenseAcceptance: false,
    files: [
      { path: "added_tokens.json", sizeBytes: 707, sha256: "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680" },
      { path: "chat_template.jinja", sizeBytes: 4_040, sha256: "40c21f34cf67d8c760ef72f8ad3ae5afad514299d4b06e91dd9a8d705af7b541" },
      { path: "config.json", sizeBytes: 938, sha256: "574349e5a343236546fda55e4744a76e181f534182d7dc60ff1bad7e7a502849" },
      { path: "generation_config.json", sizeBytes: 238, sha256: "835fffe355c9438e7a25be099b3fccaa98350b83451f9fd2d99512e74f1ade48" },
      { path: "merges.txt", sizeBytes: 1_671_853, sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5" },
      { path: "model.safetensors", sizeBytes: 2_263_022_417, sha256: "2a73c6c248601ab904e035548abd8e6abb65ea27dcb5f342fb0a8910eb44173f" },
      { path: "model.safetensors.index.json", sizeBytes: 63_964, sha256: "388d811b8b7c2608dd04cce1bcb04a8bf715d19b42790894e6d3427ff429a777" },
      { path: "special_tokens_map.json", sizeBytes: 613, sha256: "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd" },
      { path: "tokenizer.json", sizeBytes: 11_422_654, sha256: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4" },
      { path: "tokenizer_config.json", sizeBytes: 5_440, sha256: "4397cc477eb6d79715ccd2000accd6b3531928f30029665832fa1b255f24d2b9" },
      { path: "vocab.json", sizeBytes: 2_776_833, sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910" }
    ]
  },
  {
    id: "mlx-qwen3.5-9b-4bit",
    displayName: "Qwen 3.5 9B 4-bit",
    family: "Qwen 3.5",
    variant: "9B",
    runtime: "mlx",
    repository: "mlx-community/Qwen3.5-9B-4bit",
    revision: "8b2b98c00a6b4d291155e4890773ca8f769aee53",
    format: "safetensors",
    quantization: "4-bit",
    capabilities: textCapabilities,
    parameterCapabilities: {
      temperature: { min: 0, max: 2, step: 0.1 },
      maxTokens: { min: 1, max: 32_768, step: 1 },
      topP: { min: 0, max: 1, step: 0.05 },
      topK: { min: 1, step: 1 },
      presencePenalty: { min: -2, max: 2, step: 0.1 },
      reasoning: { levels: ["off", "on"] },
      seed: { min: 0, step: 1 }
    },
    defaultParameters: {
      temperature: 0.7,
      maxTokens: 32_768,
      reasoningLevel: "off",
      topP: 0.8,
      topK: 20,
      presencePenalty: 1.5
    },
    recommendedParameters: {
      reasoning: {
        temperature: 1,
        maxTokens: 32_768,
        reasoningLevel: "on",
        topP: 0.95,
        topK: 20,
        presencePenalty: 1.5
      },
      nonReasoning: {
        temperature: 0.7,
        maxTokens: 32_768,
        reasoningLevel: "off",
        topP: 0.8,
        topK: 20,
        presencePenalty: 1.5
      }
    },
    minimumMemoryBytes: 12 * gib,
    recommendedMemoryBytes: 16 * gib,
    license: "Apache-2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    requiresLicenseAcceptance: false,
    files: [
      { path: "chat_template.jinja", sizeBytes: 7_756, sha256: "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715" },
      { path: "config.json", sizeBytes: 3_331, sha256: "a96942cb6a8a1d3f1d17514d81a1925d04362a6a3233b389d13012211baaa9f8" },
      { path: "model-00001-of-00002.safetensors", sizeBytes: 5_349_771_222, sha256: "a68b87558c6ef43f74c2bd63ce7e9092ceddc3101f3def0030774bae5f42aadd" },
      { path: "model-00002-of-00002.safetensors", sizeBytes: 600_449_850, sha256: "b0a770bf8469c7f3f18756a0e0283f1c1174344a83e059a4e483f6af4907352d" },
      { path: "model.safetensors.index.json", sizeBytes: 123_592, sha256: "dd023913fb87cfdae27fb11dcf695117c925833796ccac3c64117d6652d8ff1e" },
      { path: "preprocessor_config.json", sizeBytes: 390, sha256: "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516" },
      { path: "processor_config.json", sizeBytes: 1_300, sha256: "14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b" },
      { path: "tokenizer.json", sizeBytes: 19_989_343, sha256: "87a7830d63fcf43bf241c3c5242e96e62dd3fdc29224ca26fed8ea333db72de4" },
      { path: "tokenizer_config.json", sizeBytes: 1_139, sha256: "e98f1901ac6f0adff67b1d540bfa0c36ac1a0cf59eb72ed78146ef89aafa1182" },
      { path: "video_preprocessor_config.json", sizeBytes: 385, sha256: "7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13" },
      { path: "vocab.json", sizeBytes: 6_722_759, sha256: "ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003" }
    ]
  }
]);

export const localModelCatalogVersion = "2026-07-18.1";

export function findLocalModelCatalogEntry(id: string): LocalModelCatalogEntry | undefined {
  return localModelCatalog.find((entry) => entry.id === id);
}

export function localModelExpectedSize(entry: LocalModelCatalogEntry): number {
  return entry.files.reduce((total, file) => total + file.sizeBytes, 0);
}

export function localModelManifestHash(entry: LocalModelCatalogEntry): string {
  const canonical = entry.files.map((file) => `${file.path}:${file.sizeBytes}:${file.sha256}`).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function isSafeModelRelativePath(path: string): boolean {
  return path.length > 0
    && !path.startsWith("/")
    && !path.startsWith("\\")
    && !path.split(/[\\/]/).includes("..")
    && !/^[a-zA-Z]:/.test(path);
}

function validateSupportedParameters(
  parameters: AiModelParameters,
  capabilities: AiModelParameterCapabilities,
  context: z.RefinementCtx,
  path: PropertyKey[]
): void {
  const normalized = normalizeAiModelParameters(parameters, capabilities);
  const parameterKeys = Object.keys(parameters) as Array<keyof AiModelParameters>;
  if (parameterKeys.length !== Object.keys(normalized).length
      || parameterKeys.some((key) => normalized[key] !== parameters[key])) {
    context.addIssue({
      code: "custom",
      message: "Parameters must be supported by the model capabilities and remain within their declared ranges.",
      path
    });
  }
}
