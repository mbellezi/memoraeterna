/** Preserve reported numeric usage without retaining arbitrary provider response data. */
export function normalizeTokenUsage(value: unknown, format: "openai" | "google" = "openai"): Record<string, number> {
  const usage: Record<string, number> = {};
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const read = (path: string): number | undefined => {
    let current: unknown = raw;
    for (const key of path.split(".")) current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
    return typeof current === "number" && Number.isSafeInteger(current) && current >= 0 ? current : undefined;
  };
  const put = (key: string, ...paths: string[]) => {
    const count = paths.map(read).find((item) => item !== undefined);
    if (count !== undefined) usage[key] = count;
  };
  if (format === "google") {
    put("inputTokens", "promptTokenCount");
    put("outputTokens", "candidatesTokenCount");
    put("reasoningTokens", "thoughtsTokenCount");
    put("cachedInputTokens", "cachedContentTokenCount");
    put("totalTokens", "totalTokenCount");
    // Gemini reports thoughts separately; normalize output to include reasoning.
    if (usage.outputTokens !== undefined && usage.reasoningTokens !== undefined) usage.outputTokens += usage.reasoningTokens;
  } else {
    put("inputTokens", "prompt_tokens", "input_tokens");
    put("outputTokens", "completion_tokens", "output_tokens");
    put("reasoningTokens", "completion_tokens_details.reasoning_tokens", "output_tokens_details.reasoning_tokens", "reasoning_tokens");
    put("cachedInputTokens", "prompt_tokens_details.cached_tokens", "input_tokens_details.cached_tokens", "prompt_cache_hit_tokens", "cache_read_input_tokens");
    put("cacheWriteTokens", "cache_creation_input_tokens", "input_tokens_details.cache_write_tokens");
    put("totalTokens", "total_tokens");
  }
  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) usage.totalTokens = usage.inputTokens + usage.outputTokens;
  function visit(item: unknown, path: string, depth: number) {
    if (depth > 5) return;
    if (typeof item === "number" && Number.isFinite(item) && item >= 0) usage[`provider.${path}`] = item;
    else if (item && typeof item === "object") for (const [key, child] of Object.entries(item).slice(0, 100)) visit(child, path ? `${path}.${key}` : key, depth + 1);
  }
  visit(raw, "", 0);
  return usage;
}
