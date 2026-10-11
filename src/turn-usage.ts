export const TOKEN_FIELDS = ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
export type TokenCounts = Record<typeof TOKEN_FIELDS[number], number | null>;

export function tokenCounts(value: unknown): TokenCounts | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const result = Object.fromEntries(TOKEN_FIELDS.map(key => {
    const number = source[key];
    return [key, typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null];
  })) as TokenCounts;
  return TOKEN_FIELDS.some(key => result[key] !== null) ? result : null;
}

export const zeroTokens = (): TokenCounts => Object.fromEntries(TOKEN_FIELDS.map(key => [key, 0])) as TokenCounts;

export function turnUsage(baseline: TokenCounts | null, total: TokenCounts | null, last: TokenCounts | null) {
  const reset = baseline && total && TOKEN_FIELDS.some(key => baseline[key] !== null && total[key] !== null && total[key]! < baseline[key]!);
  const counts = baseline && total && !reset ? Object.fromEntries(TOKEN_FIELDS.map(key =>
    [key, baseline[key] === null || total[key] === null ? null : total[key]! - baseline[key]!])) as TokenCounts : null;
  return {
    source: "codex-thread-token-usage", method: "cumulative-difference",
    availability: reset ? "counter-reset" : !total ? "not-reported" : !baseline ? "baseline-unavailable" : "reported",
    counts, threadTotal: total, lastModelResponse: last,
  };
}
