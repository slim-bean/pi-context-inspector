import { joinRich, rich, toned, type StyledText, type Tone } from "./presentation.ts";

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const label = (value: unknown, fallback: string): string => typeof value === "string" && value ? value : fallback;

/** Decode serialized arguments for display only; malformed/partial JSON remains verbatim. */
export function parameterText(value: unknown): string {
  if (typeof value !== "string") return value === undefined ? "Parameters not recorded." : jsonText(value);
  try { return jsonText(JSON.parse(value)); } catch { return value; }
}

export function toolCallView(name: string, id: string | undefined, parameters: unknown): StyledText {
  return rich`${toned(`▶ TOOL CALL · ${name}`, "accent")}\n${id ? `Call ID: ${id}\n` : ""}${toned("Parameters:", "accent")}\n${parameterText(parameters)}`;
}

export function toolResultView(name: string, id: string | undefined, body: string, isError = false, reference?: StyledText): StyledText {
  return rich`${toned(`◀ TOOL RESULT · ${name}${isError ? " (error)" : ""}`, isError ? "error" : "mdHeading")}\n${id ? `Call ID: ${id}\n` : ""}\n${reference ? rich`${reference}\n\n` : ""}${toned("Output:", isError ? "error" : "mdHeading")}\n${isError ? toned(body, "error") : body}`;
}

interface Call { name: string; id?: string; parameters: unknown }
function call(value: unknown): Call | undefined {
  const v = object(value);
  if (v.type === "toolCall") return { name: label(v.name, "unknown tool"), id: id(v.id), parameters: v.arguments };
  if (v.type === "tool_use") return { name: label(v.name, "unknown tool"), id: id(v.id), parameters: v.input };
  if (v.type === "function_call") return { name: label(v.name, "unknown function"), id: id(v.call_id ?? v.id), parameters: v.arguments };
  if (v.type === "function" && Object.hasOwn(object(v.function), "arguments")) return { name: label(object(v.function).name, "unknown function"), id: id(v.id), parameters: object(v.function).arguments };
  return undefined;
}
function messageCalls(v: Record<string, unknown>): unknown[] {
  return [
    ...(Array.isArray(v.tool_calls) ? v.tool_calls : []),
    ...(v.function_call ? [{ ...object(v.function_call), type: "function_call" }] : []),
    ...(v.role === "assistant" && Array.isArray(v.content) ? v.content.filter((block: unknown) => call(block)) : []),
  ];
}
function result(value: unknown): { name: string; id?: string; content: unknown; isError: boolean } | undefined {
  const v = object(value);
  if (v.role === "toolResult") return { name: label(v.toolName, "tool"), id: id(v.toolCallId), content: v.content, isError: v.isError === true };
  if (v.role === "tool" || v.role === "function") return { name: label(v.name, "tool"), id: id(v.tool_call_id), content: v.content, isError: false };
  if (v.type === "tool_result") return { name: "tool", id: id(v.tool_use_id), content: v.content, isError: v.is_error === true };
  if (v.type === "function_call_output") return { name: "function", id: id(v.call_id), content: v.output, isError: false };
  return undefined;
}

/** Recognize only structural tool fields, never words in arbitrary output or arguments. */
export function toolLabel(value: unknown): { title: string; tone: Tone } | undefined {
  const c = call(value);
  if (c) return { title: `Call · ${c.name}`, tone: "accent" };
  const r = result(value);
  if (r) return { title: `Result · ${r.name}`, tone: r.isError ? "error" : "mdHeading" };
  const v = object(value);
  const calls = messageCalls(v).map(call).filter((c): c is Call => !!c);
  const results = Array.isArray(v.content) ? v.content.map(result).filter(Boolean) : [];
  if (calls.length) return { title: `${results.length ? "Calls + results" : calls.length === 1 ? "Call" : `Calls (${calls.length})`} · ${calls.map((c) => c.name).join(", ")}`, tone: "accent" };
  if (results.length) return { title: results.length === 1 ? "Result · tool" : `Results (${results.length}) · tools`, tone: results.some((r) => r?.isError) ? "error" : "mdHeading" };
  return undefined;
}

/** Human-readable view; raw capture is never rewritten. Calls come first in assistant messages. */
export function contentView(value: unknown): StyledText {
  if (typeof value === "string") return rich`${value}`;
  if (Array.isArray(value)) return joinRich(value.map(contentView), "\n\n");
  if (!value || typeof value !== "object") return rich`${String(value ?? "")}`;
  const v = object(value);
  if (v.type === "image" || v.type === "image_url" || v.type === "input_image") return rich`[image: ${label(v.mimeType ?? v.mediaType, "see raw view")}]`;
  if (v.type === "thinking") return rich`[thinking]\n${label(v.thinking, "Opaque/signed reasoning; see raw view.")}`;
  const c = call(value);
  if (c) return toolCallView(c.name, c.id, c.parameters);
  const r = result(value);
  if (r) return toolResultView(r.name, r.id, contentText(r.content), r.isError);
  const calls = messageCalls(v);
  if (calls.length) {
    const rest = v.role === "assistant" && Array.isArray(v.content) ? v.content.filter((block: unknown) => !call(block)) : v.content;
    const body = contentView(rest);
    return joinRich([...calls.map(contentView), ...(body.text ? [rich`${toned("Assistant content (same message):", "dim")}\n${body}`] : [])], "\n\n");
  }
  if (typeof v.text === "string") return rich`${v.text}`;
  if (v.content !== undefined) return contentView(v.content);
  if (typeof v.summary === "string") return rich`${v.summary}`;
  return rich`${jsonText(value)}`;
}

export function contentText(value: unknown): string { return contentView(value).text; }
