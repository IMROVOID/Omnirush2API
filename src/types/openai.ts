/**
 * OpenAI-compatible API schemas and protocol types
 */

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null | readonly unknown[];
  readonly name?: string;
  readonly reasoning_content?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly unknown[];
}

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly max_tokens?: number;
  readonly stop?: string | readonly string[];
  readonly presence_penalty?: number;
  readonly frequency_penalty?: number;
  readonly user?: string;
  readonly reasoning_effort?: "none" | "low" | "medium" | "high" | "max";
  readonly input?: readonly unknown[];
  readonly store?: boolean;
  readonly max_output_tokens?: number;
}

export interface ChatCompletionChoice {
  readonly index: number;
  readonly message: ChatMessage;
  readonly finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface CompletionUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export interface ChatCompletionResponse {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ChatCompletionChoice[];
  readonly usage?: CompletionUsage | undefined;
}

export interface ChatCompletionChunkDelta {
  readonly role?: "assistant";
  readonly content?: string | null;
  readonly reasoning_content?: string | null;
}

export interface ChatCompletionChunkChoice {
  readonly index: number;
  readonly delta: ChatCompletionChunkDelta;
  readonly finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface ChatCompletionChunk {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ChatCompletionChunkChoice[];
}

export interface OpenAIModel {
  readonly id: string;
  readonly object: "model";
  readonly created: number;
  readonly owned_by: string;
  readonly root?: string;
}

export interface OpenAIModelListResponse {
  readonly object: "list";
  readonly data: readonly OpenAIModel[];
}

export interface GatewayErrorResponse {
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly param?: string | null;
    readonly code?: string | number | null;
  };
}
