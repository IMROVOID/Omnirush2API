import type {
  ChatCompletionChunk,
  ChatCompletionChunkChoice,
} from "../types/openai.js";

export const SSE_DONE_MESSAGE = "data: [DONE]\n\n";

export interface ChunkDeltaOptions {
  readonly id: string;
  readonly model: string;
  readonly index?: number;
  readonly role?: "assistant";
  readonly content?: string | null;
  readonly reasoningContent?: string | null;
  readonly finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

/**
 * Parses a single line from an SSE stream
 */
export function parseSSELine(line: string): Record<string, unknown> | "[DONE]" | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }

  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") {
    return "[DONE]";
  }

  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON SSE payload
  }
  return null;
}

/**
 * Creates an OpenAI-compliant streaming chunk
 */
export function createChunkDelta(options: ChunkDeltaOptions): ChatCompletionChunk {
  const choice: ChatCompletionChunkChoice = {
    index: options.index ?? 0,
    delta: {
      ...(options.role !== undefined ? { role: options.role } : {}),
      ...(options.content !== undefined ? { content: options.content } : {}),
      ...(options.reasoningContent !== undefined
        ? { reasoning_content: options.reasoningContent }
        : {}),
    },
    finish_reason: options.finishReason ?? null,
  };

  return {
    id: options.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [choice],
  };
}

/**
 * Transforms an upstream raw JSON chunk to guarantee OpenAI compliance
 */
export function transformUpstreamChunk(
  upstream: Record<string, unknown>,
  requestedModel: string
): ChatCompletionChunk | null {
  const response = upstream["response"] && typeof upstream["response"] === "object"
    ? upstream["response"] as Record<string, unknown>
    : null;
  const id = typeof upstream["id"] === "string"
    ? upstream["id"]
    : response && typeof response["id"] === "string"
      ? response["id"]
      : `chatcmpl-${Date.now()}`;
  const eventType = typeof upstream["type"] === "string" ? upstream["type"] : "";

  if (eventType === "response.output_text.delta") {
    return createChunkDelta({
      id,
      model: requestedModel,
      content: typeof upstream["delta"] === "string" ? upstream["delta"] : "",
    });
  }

  if (/^response\.(reasoning|summary).*\.delta$/.test(eventType)) {
    return createChunkDelta({
      id,
      model: requestedModel,
      reasoningContent: typeof upstream["delta"] === "string" ? upstream["delta"] : "",
    });
  }

  if (eventType === "response.output_item.added") {
    const item = upstream["item"];
    if (item && typeof item === "object" && (item as Record<string, unknown>)["role"] === "assistant") {
      return createChunkDelta({ id, model: requestedModel, role: "assistant" });
    }
    return null;
  }

  if (eventType === "response.completed") {
    return createChunkDelta({ id, model: requestedModel, finishReason: "stop" });
  }

  const choicesRaw = Array.isArray(upstream["choices"]) ? upstream["choices"] : [];

  if (choicesRaw.length > 0) {
    const choices: ChatCompletionChunkChoice[] = [];
    for (let i = 0; i < choicesRaw.length; i++) {
      const rawChoice = choicesRaw[i];
      if (rawChoice !== null && typeof rawChoice === "object") {
        const deltaObj = (rawChoice as Record<string, unknown>)["delta"];
        const finishReason = (rawChoice as Record<string, unknown>)["finish_reason"];

        let content: string | null = null;
        let reasoningContent: string | null = null;
        let role: "assistant" | undefined = undefined;

        if (deltaObj !== null && typeof deltaObj === "object") {
          const d = deltaObj as Record<string, unknown>;
          if (typeof d["content"] === "string") content = d["content"];
          if (typeof d["reasoning_content"] === "string") reasoningContent = d["reasoning_content"];
          else if (typeof d["reasoning"] === "string") reasoningContent = d["reasoning"];
          if (d["role"] === "assistant") role = "assistant";
        }

        choices.push({
          index: i,
          delta: {
            ...(role !== undefined ? { role } : {}),
            ...(content !== null ? { content } : {}),
            ...(reasoningContent !== null ? { reasoning_content: reasoningContent } : {}),
          },
          finish_reason:
            (finishReason as "stop" | "length" | "tool_calls" | "content_filter" | null) ?? null,
        });
      }
    }

    return {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices,
    };
  }

  // Handle alternative Responses API delta format
  if (typeof upstream["delta"] === "string") {
    return createChunkDelta({
      id,
      model: requestedModel,
      content: upstream["delta"],
    });
  }

  return null;
}

/**
 * Formats a chunk as a standard SSE line
 */
export function formatSSEChunk(chunk: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Creates a TransformStream converting upstream SSE events into standard OpenAI SSE chunks
 */
export function createSSETransformStream(
  requestedModel: string
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseId = `chatcmpl-${Date.now()}`;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = parseSSELine(line);
        if (parsed === "[DONE]") {
          controller.enqueue(encoder.encode(SSE_DONE_MESSAGE));
          return;
        }

        if (parsed !== null) {
          const response = parsed.response && typeof parsed.response === "object" ? parsed.response as Record<string, unknown> : null;
          if (response && typeof response.id === "string") responseId = response.id;
          const transformed = transformUpstreamChunk({ id: responseId, ...parsed }, requestedModel);
          if (transformed !== null) {
            controller.enqueue(encoder.encode(formatSSEChunk(transformed)));
          }
        }
      }
    },
    flush(controller) {
      if (buffer.trim()) {
        const parsed = parseSSELine(buffer);
        if (parsed === "[DONE]") {
          controller.enqueue(encoder.encode(SSE_DONE_MESSAGE));
        } else if (parsed !== null) {
          const response = parsed.response && typeof parsed.response === "object" ? parsed.response as Record<string, unknown> : null;
          if (response && typeof response.id === "string") responseId = response.id;
          const transformed = transformUpstreamChunk({ id: responseId, ...parsed }, requestedModel);
          if (transformed !== null) {
            controller.enqueue(encoder.encode(formatSSEChunk(transformed)));
          }
        }
      }
      controller.enqueue(encoder.encode(SSE_DONE_MESSAGE));
    },
  });
}

export interface AggregatedResponsesResult {
  readonly id: string;
  readonly model: string;
  readonly content: string;
  readonly reasoningContent?: string;
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

function responseOutputText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const text: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const content = record.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
        const partText = (part as Record<string, unknown>).text;
        if (typeof partText === "string") text.push(partText);
      }
    }
  }
  return text.join("");
}

/** Collects the official Responses SSE stream into a non-streaming chat result. */
export function aggregateResponsesSSE(text: string, requestedModel: string): AggregatedResponsesResult {
  let id = `chatcmpl-${Date.now()}`;
  let model = requestedModel;
  let content = "";
  let reasoningContent = "";
  let usage: AggregatedResponsesResult["usage"];

  for (const line of text.split(/\r?\n/)) {
    const parsed = parseSSELine(line);
    if (!parsed || parsed === "[DONE]") continue;
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const response = parsed.response && typeof parsed.response === "object" ? parsed.response as Record<string, unknown> : null;
    const eventId = typeof parsed.response_id === "string" ? parsed.response_id : response && typeof response.id === "string" ? response.id : null;
    if (eventId) id = eventId;
    const eventModel = response && typeof response.model === "string" ? response.model : null;
    if (eventModel) model = eventModel;

    if (type === "response.output_text.delta" && typeof parsed.delta === "string") content += parsed.delta;
    if (/^response\.(reasoning|summary).*\.delta$/.test(type) && typeof parsed.delta === "string") reasoningContent += parsed.delta;
    if (type === "response.completed" && response) {
      if (!content) content = responseOutputText(response.output);
      const rawUsage = response.usage;
      if (rawUsage && typeof rawUsage === "object") {
        const value = rawUsage as Record<string, unknown>;
        const prompt = typeof value.input_tokens === "number" ? value.input_tokens : typeof value.prompt_tokens === "number" ? value.prompt_tokens : 0;
        const completion = typeof value.output_tokens === "number" ? value.output_tokens : typeof value.completion_tokens === "number" ? value.completion_tokens : 0;
        const total = typeof value.total_tokens === "number" ? value.total_tokens : prompt + completion;
        usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
      }
    }
  }

  return {
    id,
    model,
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(usage ? { usage } : {}),
  };
}
