import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChoice,
  CompletionUsage,
  ChatMessage,
} from "../types/openai.js";
import { resolveModelId } from "./model-catalog.js";

export interface OmnirushWirePayload {
  readonly model: string;
  readonly input: readonly unknown[];
  readonly stream: true;
  readonly store: false;
  readonly temperature?: number | undefined;
  readonly top_p?: number | undefined;
  readonly max_output_tokens?: number | undefined;
  readonly stop?: string | readonly string[] | undefined;
  readonly reasoning?: {
    readonly effort: string;
    readonly summary?: string;
  } | undefined;
  readonly include?: readonly string[] | undefined;
}

function blockText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : JSON.stringify(value);
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") return (part as Record<string, string>).text;
    return "";
  }).join("");
}

function textParts(content: ChatMessage["content"], type: "input_text" | "output_text", role: ChatMessage["role"]): readonly unknown[] {
  if (typeof content === "string") return [{ type, text: content }];
  if (content === null) return [];
  if (!Array.isArray(content)) return [];
  const blocks: unknown[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      blocks.push({ type, text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const value = part as Record<string, unknown>;
    const kind = typeof value.type === "string" ? value.type : "text";
    if (kind === "text") {
      if (typeof value.text === "string") blocks.push({ type, text: value.text });
      continue;
    }
    // Anthropic thinking blocks are model-internal history, not input blocks
    // accepted by the Responses endpoint. Dropping them prevents a Claude
    // continuation from becoming an invalid upstream request; the next turn
    // still performs fresh reasoning.
    if (kind === "thinking" || kind === "redacted_thinking") continue;
    if (kind === "tool_result") {
      blocks.push({
        type: "function_call_output",
        call_id: typeof value.tool_use_id === "string" ? value.tool_use_id : "unknown",
        output: blockText(value.content),
      });
      continue;
    }
    if (kind === "tool_use") {
      blocks.push({
        type: "function_call",
        call_id: typeof value.id === "string" ? value.id : "unknown",
        name: typeof value.name === "string" ? value.name : "tool",
        arguments: typeof value.input === "string" ? value.input : JSON.stringify(value.input ?? {}),
      });
      continue;
    }
    // Preserve supported Responses-style blocks, but never send an Anthropic
    // provider-only block verbatim to the upstream API.
    if (kind === "input_text" || kind === "output_text" || kind === "input_image" || kind === "image_url") {
      blocks.push(value);
      continue;
    }
    if (role === "user" && typeof value.text === "string") blocks.push({ type, text: value.text });
  }
  return blocks;
}

function normalizeInput(request: ChatCompletionRequest): readonly unknown[] {
  if (Array.isArray(request.input)) return request.input;
  return request.messages.map((message) => {
    if (message.role === "tool") {
      return {
        type: "function_call_output",
        call_id: message.tool_call_id ?? "unknown",
        output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
      };
    }
    return {
      role: message.role,
      ...(message.name ? { name: message.name } : {}),
      content: textParts(message.content, message.role === "assistant" ? "output_text" : "input_text", message.role),
    };
  });
}

/**
 * Normalizes client OpenAI ChatCompletionRequest for the Omnirush backend
 */
export function normalizeCompletionRequest(
  request: ChatCompletionRequest
): OmnirushWirePayload {
  const targetModel = resolveModelId(request.model);
  // Determine reasoning configuration
  let reasoning: { effort: string; summary: string } | undefined;
  if (request.reasoning_effort) {
    reasoning = {
      effort: request.reasoning_effort,
      summary: "auto",
    };
  } else if (targetModel.includes("astra")) {
    reasoning = {
      effort: "medium",
      summary: "auto",
    };
  }

  return {
    model: targetModel,
    input: normalizeInput(request),
    // The OmniRush Responses gateway requires streaming, even when the local
    // OpenAI-compatible caller asks for a non-streaming chat completion.
    stream: true,
    store: false,
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(typeof request.top_p === "number" ? { top_p: request.top_p } : {}),
    ...(typeof request.max_output_tokens === "number"
      ? { max_output_tokens: request.max_output_tokens }
      : typeof request.max_tokens === "number"
        ? { max_output_tokens: request.max_tokens }
        : {}),
    ...(request.stop ? { stop: request.stop } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(reasoning ? { include: ["reasoning.encrypted_content"] } : {}),
  };
}

/**
 * Normalizes upstream payload into standard OpenAI ChatCompletionResponse
 */
export function normalizeCompletionResponse(
  raw: unknown,
  fallbackModel: string
): ChatCompletionResponse {
  const now = Math.floor(Date.now() / 1000);
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const id = typeof data["id"] === "string" ? data["id"] : `chatcmpl-${Date.now()}`;
  const model = typeof data["model"] === "string" ? data["model"] : fallbackModel;
  const created = typeof data["created"] === "number" ? data["created"] : now;

  let choices: ChatCompletionChoice[] = [];

  if (Array.isArray(data["choices"])) {
    choices = (data["choices"] as Array<Record<string, unknown>>).map((c, i) => {
      const msg = (c["message"] && typeof c["message"] === "object" ? c["message"] : {}) as Record<string, unknown>;
      const role = typeof msg["role"] === "string" ? (msg["role"] as "assistant") : "assistant";
      const content = typeof msg["content"] === "string" ? msg["content"] : null;
      const reasoning =
        typeof msg["reasoning_content"] === "string"
          ? msg["reasoning_content"]
          : typeof msg["reasoning"] === "string"
            ? msg["reasoning"]
            : undefined;

      return {
        index: typeof c["index"] === "number" ? c["index"] : i,
        message: {
          role,
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason:
          (c["finish_reason"] as "stop" | "length" | "tool_calls" | "content_filter" | null) ?? "stop",
      };
    });
  } else if (typeof data["content"] === "string" || typeof data["output"] === "string") {
    const reasoning = typeof data["reasoningContent"] === "string" ? data["reasoningContent"] : undefined;
    choices = [
      {
        index: 0,
        message: {
          role: "assistant",
          content: typeof data["content"] === "string" ? data["content"] : data["output"] as string,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: "stop",
      },
    ];
  }

  if (choices.length === 0) {
    choices = [
      {
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
      },
    ];
  }

  let usage: CompletionUsage | undefined;
  if (data["usage"] && typeof data["usage"] === "object") {
    const u = data["usage"] as Record<string, unknown>;
    usage = {
      prompt_tokens: typeof u["prompt_tokens"] === "number" ? u["prompt_tokens"] : 0,
      completion_tokens: typeof u["completion_tokens"] === "number" ? u["completion_tokens"] : 0,
      total_tokens: typeof u["total_tokens"] === "number" ? u["total_tokens"] : 0,
    };
  }

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices,
    ...(usage ? { usage } : {}),
  };
}
