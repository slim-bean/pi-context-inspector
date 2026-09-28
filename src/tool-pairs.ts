import type { SessionEntry } from "@earendil-works/pi-coding-agent";

type Message = Extract<SessionEntry, { type: "message" }>["message"];
export type ToolCall = Extract<Extract<Message, { role: "assistant" }>["content"][number], { type: "toolCall" }>;
export type ToolResult = Extract<Message, { role: "toolResult" }>;
export interface ToolPair {
  id: string;
  tool: string;
  callId: string;
  entryId?: string;
  resultEntryId?: string;
  call?: ToolCall;
  result?: ToolResult;
}

/** Branch-only, ordered matching by ID + name, never adjacency. Duplicate IDs use FIFO. */
export function pairToolCalls(branch: readonly SessionEntry[]): ToolPair[] {
  const pairs: ToolPair[] = [];
  const pending = new Map<string, ToolPair[]>();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const [index, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
        if (block.type !== "toolCall") continue;
        const pair: ToolPair = { id: `call:${entry.id}:${index}`, tool: block.name, callId: block.id, entryId: entry.id, call: block };
        pairs.push(pair);
        const key = JSON.stringify([block.id, block.name]);
        const queue = pending.get(key) ?? [];
        queue.push(pair); pending.set(key, queue);
      }
    } else if (message.role === "toolResult") {
      const key = JSON.stringify([message.toolCallId, message.toolName]);
      const queue = pending.get(key);
      const pair = queue?.shift() ?? { id: `result:${entry.id}`, tool: message.toolName, callId: message.toolCallId };
      if (!queue?.length) pending.delete(key);
      if (!pair.call) pairs.push(pair);
      pair.result = message;
      pair.resultEntryId = entry.id;
    }
  }
  return pairs;
}
