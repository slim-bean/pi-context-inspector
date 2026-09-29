/** Local, model-independent size estimates. Never tokenize display wrappers or storage metadata. */
export interface TokenEstimate {
  tokens: number;
  images: number;
  opaque: number;
}

export const ESTIMATE_NOTE = "~tokens = visible text characters / 4 (rounded per block), not a model tokenizer. Image/audio/video and opaque reasoning costs are unknown; framing/provider conversion are excluded. Estimates are not billing totals.";
export const emptyEstimate = (): TokenEstimate => ({ tokens: 0, images: 0, opaque: 0 });
export function sumEstimates(values: readonly TokenEstimate[]): TokenEstimate {
  return values.reduce((sum, value) => ({ tokens: sum.tokens + value.tokens, images: sum.images + value.images, opaque: sum.opaque + value.opaque }), emptyEstimate());
}
export function textEstimate(text: string): TokenEstimate {
  return { tokens: Math.ceil(text.length / 4), images: 0, opaque: 0 };
}
/** Allocate slices of one text block without increasing its original rounded total. */
export function textSliceEstimate(start: number, end: number): TokenEstimate {
  return { tokens: Math.ceil(end / 4) - Math.ceil(start / 4), images: 0, opaque: 0 };
}
export function jsonEstimate(value: unknown): TokenEstimate {
  return textEstimate(JSON.stringify(value) ?? "");
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Model-facing content only; signatures/base64 are deliberately not counted as text. */
export function contentEstimate(value: unknown): TokenEstimate {
  if (typeof value === "string") return textEstimate(value);
  if (Array.isArray(value)) return sumEstimates(value.map(contentEstimate));
  const block = object(value);
  if (["image", "image_url", "input_image"].includes(String(block.type))) return { tokens: 0, images: 1, opaque: 0 };
  if (["audio", "input_audio", "video", "file", "input_file", "redacted_thinking"].includes(String(block.type))) return { tokens: 0, images: 0, opaque: 1 };
  if (block.type === "thinking") return {
    ...textEstimate(typeof block.thinking === "string" ? block.thinking : ""),
    opaque: block.thinkingSignature || block.redacted ? 1 : 0,
  };
  if (block.type === "toolCall") return {
    ...sumEstimates([textEstimate(String(block.name ?? "")), jsonEstimate(block.arguments)]),
    opaque: block.thoughtSignature ? 1 : 0,
  };
  if (typeof block.text === "string") return textEstimate(block.text);
  if (value == null) return emptyEstimate();
  return { tokens: 0, images: 0, opaque: 1 };
}
export function formatEstimate(value: TokenEstimate): string {
  return `~${value.tokens.toLocaleString()} tok${value.images || value.opaque ? " + ?" : ""}`;
}
export interface UsageCounts { input: number; output: number; cacheRead: number; cacheWrite: number }
export function inputTokens(usage: UsageCounts): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}
export function hasUsage(usage: UsageCounts | undefined): usage is UsageCounts {
  return !!usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every((n) => Number.isFinite(n) && n >= 0)
    && inputTokens(usage) + usage.output > 0;
}
export function usageText(usage: UsageCounts | undefined): string {
  if (!hasUsage(usage)) return "Provider usage: unavailable (missing or all-zero response usage).";
  return `Provider-reported request input: ${inputTokens(usage).toLocaleString()} tokens\n` +
    `  Uncached: ${usage.input.toLocaleString()} · cache read: ${usage.cacheRead.toLocaleString()} · cache write: ${usage.cacheWrite.toLocaleString()}\n` +
    `Response output: ${usage.output.toLocaleString()} tokens (not request input)\nCached tokens still occupy context. Usage is pi's normalized provider report, not a per-section measurement.`;
}
