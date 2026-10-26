import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerConfig } from "../types/config.js";
import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from "../types/openai.js";
import { getModelList } from "../proxy/model-catalog.js";
import { CompletionProxyHandler } from "../proxy/completion-handler.js";
import type { AccountPoolManager } from "../auth/pool-manager.js";

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-OmniRush-Client",
};

export class RequestDispatcher {
  private config: ServerConfig;
  private pool: AccountPoolManager;
  private handler: CompletionProxyHandler;

  constructor(config: ServerConfig, pool: AccountPoolManager) {
    this.config = config;
    this.pool = pool;
    this.handler = new CompletionProxyHandler({
      pool,
      upstreamBaseUrl: config.gatewayUrl,
    });
  }

  public async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      res.setHeader(key, value);
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Check optional Bearer authentication
    if (this.config.apiKey && this.config.apiKey.trim() !== "") {
      const authHeader = req.headers.authorization;
      const expected = `Bearer ${this.config.apiKey}`;
      const apiKeyHeader = req.headers["x-api-key"];
      if (authHeader !== expected && apiKeyHeader !== this.config.apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Invalid API key provided.",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          })
        );
        return;
      }
    }

    // Route: GET / or GET /v1/health or /health
    if (req.method === "GET" && (pathname === "/v1/health" || pathname === "/health" || pathname === "/")) {
      this.handleHealth(res);
      return;
    }

    // Route: GET /v1/models
    if (req.method === "GET" && pathname === "/v1/models") {
      this.handleModels(res);
      return;
    }

    // Route: POST /v1/chat/completions or POST /v1/responses
    if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/v1/responses")) {
      await this.handleChatCompletions(req, res, pathname === "/v1/responses");
      return;
    }

    // Route: POST /v1/messages (Anthropic Messages-compatible text path)
    if (req.method === "POST" && pathname === "/v1/messages") {
      await this.handleAnthropicMessages(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
      let rawBody = "";
      try {
        rawBody = await this.readRequestBody(req);
        const payload = JSON.parse(rawBody) as Record<string, unknown>;
        const serialized = JSON.stringify({ system: payload.system, messages: payload.messages, tools: payload.tools });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(serialized.length / 4)) }));
      } catch {
        this.writeJsonError(res, 400, "Malformed JSON payload in request body.");
      }
      return;
    }

    // Fallback: 404 Not Found
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `Unknown path: ${pathname}`,
          type: "invalid_request_error",
          code: "resource_not_found",
        },
      })
    );
  }

  private handleHealth(res: ServerResponse): void {
    const stats = this.pool.getStats();
    const isBanned = stats.total > 0 && stats.banned === stats.total;
    const isDegraded = stats.total > 0 && stats.active === 0;
    const isUnhealthy = stats.total === 0;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          status: isBanned ? "banned" : isUnhealthy ? "unhealthy" : isDegraded ? "degraded" : "healthy",
          version: "1.0.1",
          mode: "local-daemon",
          api_key_configured: Boolean(this.config.apiKey),
          account_count: stats.total,
          active_accounts: stats.active,
          cooldown_accounts: stats.inCooldown,
          banned_accounts: stats.banned,
          supported_models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"],
        },
        null,
        2
      )
    );
  }

  private handleModels(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getModelList(), null, 2));
  }

  private async handleChatCompletions(req: IncomingMessage, res: ServerResponse, responsesApi = false): Promise<void> {
    let rawBody = "";
    try {
      rawBody = await this.readRequestBody(req);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `Failed to read request body: ${err instanceof Error ? err.message : String(err)}`,
            type: "invalid_request_error",
          },
        })
      );
      return;
    }

    let payload: ChatCompletionRequest;
    try {
      payload = JSON.parse(rawBody) as ChatCompletionRequest;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Malformed JSON payload in request body.",
            type: "invalid_request_error",
          },
        })
      );
      return;
    }

    if (!payload.model || (!Array.isArray(payload.messages) && !responsesApi)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: responsesApi ? "Missing required 'model' or 'input' field." : "Missing required 'model' or 'messages' field.",
            type: "invalid_request_error",
          },
        })
      );
      return;
    }

    const abortController = new AbortController();
    req.on("close", () => {
      abortController.abort();
    });

    const result = await this.handler.handleCompletion(
      responsesApi ? this.responsesToChatRequest(payload) : payload,
      abortController.signal
    );

    if (result.isStream && result.streamResponse) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const reader = result.streamResponse.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch {
        // Stream aborted or connection broken
      } finally {
        res.end();
      }
      return;
    }

    if (result.jsonResponse) {
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.jsonResponse, null, 2));
      return;
    }

    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.errorResponse ?? {}, null, 2));
  }

  private responsesToChatRequest(payload: ChatCompletionRequest & { readonly input?: unknown }): ChatCompletionRequest {
    const input = payload.input;
    const messages: ChatMessage[] = Array.isArray(input)
      ? (input as unknown[]).flatMap<ChatMessage>((item) => {
          if (!item || typeof item !== "object") return [];
          const value = item as Record<string, unknown>;
          if (value.type === "message" || typeof value.role === "string") {
            const content = Array.isArray(value.content)
              ? value.content
              : typeof value.content === "string"
                ? value.content
                : "";
            return [{ role: (value.role === "assistant" ? "assistant" : value.role === "system" ? "system" : "user") as "system" | "user" | "assistant", content }];
          }
          if (value.type === "function_call_output") {
            return [{ role: "tool" as const, tool_call_id: typeof value.call_id === "string" ? value.call_id : "unknown", content: typeof value.output === "string" ? value.output : JSON.stringify(value.output ?? "") }];
          }
          return [];
        })
      : [{ role: "user" as const, content: typeof input === "string" ? input : JSON.stringify(input ?? "") }];

    return { ...payload, messages };
  }

  private async handleAnthropicMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let rawBody = "";
    try {
      rawBody = await this.readRequestBody(req);
    } catch (error) {
      this.writeJsonError(res, 400, `Failed to read request body: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be an object");
      payload = parsed as Record<string, unknown>;
    } catch {
      this.writeJsonError(res, 400, "Malformed JSON payload in request body.");
      return;
    }

    const request = this.anthropicToChatRequest(payload);
    if (!request.model || !request.messages.length) {
      this.writeJsonError(res, 400, "Missing required 'model' or 'messages' field.");
      return;
    }

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());
    const result = await this.handler.handleCompletion(request, abortController.signal);

    if (result.errorResponse) {
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.errorResponse));
      return;
    }

    if (request.stream && result.streamResponse) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      await this.writeAnthropicStream(result.streamResponse, res, request.model);
      return;
    }

    if (result.jsonResponse) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.chatToAnthropicResponse(result.jsonResponse)));
      return;
    }

    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "api_error", message: "No response from upstream" } }));
  }

  private anthropicToChatRequest(payload: Record<string, unknown>): ChatCompletionRequest {
    const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
    const messages: ChatMessage[] = [];
    if (typeof payload.system === "string" || Array.isArray(payload.system)) messages.push({ role: "system", content: payload.system as string | readonly unknown[] });
    for (const entry of rawMessages) {
      if (!entry || typeof entry !== "object") continue;
      const value = entry as Record<string, unknown>;
      const role = value.role === "assistant" ? "assistant" : "user";
      const content = typeof value.content === "string" ? value.content : Array.isArray(value.content) ? value.content : "";
      messages.push({ role, content });
    }
    const maxTokens = typeof payload.max_tokens === "number" ? payload.max_tokens : undefined;
    const stopSequences = Array.isArray(payload.stop_sequences)
      ? payload.stop_sequences.filter((value): value is string => typeof value === "string")
      : undefined;
    const thinking = payload.thinking && typeof payload.thinking === "object" ? payload.thinking as Record<string, unknown> : null;
    const budget = typeof thinking?.budget_tokens === "number" ? thinking.budget_tokens : 0;
    const reasoning_effort = thinking?.type === "enabled"
      ? budget >= 16000 ? "max" : budget >= 8000 ? "high" : budget >= 4000 ? "medium" : "low"
      : undefined;
    return {
      model: typeof payload.model === "string" ? payload.model : "",
      messages,
      stream: payload.stream === true,
      ...(typeof payload.temperature === "number" ? { temperature: payload.temperature } : {}),
      ...(typeof payload.top_p === "number" ? { top_p: payload.top_p } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(stopSequences && stopSequences.length ? { stop: stopSequences } : {}),
      ...(reasoning_effort ? { reasoning_effort } : {}),
    };
  }

  private chatToAnthropicResponse(response: ChatCompletionResponse): Record<string, unknown> {
    const choice = response.choices[0];
    const content = choice?.message.content;
    const text = typeof content === "string" ? content : content == null ? "" : JSON.stringify(content);
    const reasoning = choice?.message.reasoning_content;
    const blocks = [
      ...(reasoning ? [{ type: "thinking", thinking: reasoning }] : []),
      { type: "text", text },
    ];
    return {
      id: response.id.startsWith("msg_") ? response.id : `msg_${response.id}`,
      type: "message",
      role: "assistant",
      model: response.model,
      content: blocks,
      stop_reason: choice?.finish_reason === "length" ? "max_tokens" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  private async writeAnthropicStream(stream: ReadableStream<Uint8Array>, res: ServerResponse, model: string): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    let messageId = `msg_${Date.now()}`;
    let nextBlockIndex = 0;
    let thinkingBlockIndex: number | null = null;
    let textBlockIndex: number | null = null;
    let finished = false;
    const send = (event: string, data: Record<string, unknown>): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("message_start", {
      type: "message_start",
      message: { id: messageId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      try {
        const chunk = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>;
        if (typeof chunk.id === "string") messageId = chunk.id;
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        const first = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : null;
        const delta = first?.delta && typeof first.delta === "object" ? first.delta as Record<string, unknown> : null;
        if (typeof delta?.reasoning_content === "string") {
          if (thinkingBlockIndex === null) {
            thinkingBlockIndex = nextBlockIndex++;
            send("content_block_start", { type: "content_block_start", index: thinkingBlockIndex, content_block: { type: "thinking", thinking: "" } });
          }
          send("content_block_delta", { type: "content_block_delta", index: thinkingBlockIndex, delta: { type: "thinking_delta", thinking: delta.reasoning_content } });
        }
        if (typeof delta?.content === "string") {
          if (textBlockIndex === null) {
            textBlockIndex = nextBlockIndex++;
            send("content_block_start", { type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } });
          }
          send("content_block_delta", { type: "content_block_delta", index: textBlockIndex, delta: { type: "text_delta", text: delta.content } });
        }
        const finish = typeof first?.finish_reason === "string" ? first.finish_reason : null;
        if (finish && !finished) {
          finished = true;
          if (thinkingBlockIndex !== null) send("content_block_stop", { type: "content_block_stop", index: thinkingBlockIndex });
          if (textBlockIndex !== null) send("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
          send("message_delta", { type: "message_delta", delta: { stop_reason: finish === "length" ? "max_tokens" : "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
          send("message_stop", { type: "message_stop" });
        }
      } catch {
        // Ignore non-JSON comments and the OpenAI [DONE] marker.
      }
    };

    try {
      const reader = stream.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      }
      if (buffer) handleLine(buffer);
    } finally {
      res.end();
    }
  }

  private writeJsonError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
  }

  private readRequestBody(req: IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      let accumulated = "";
      let bytesCount = 0;

      req.on("data", (chunk: Buffer) => {
        bytesCount += chunk.length;
        if (bytesCount > maxBytes) {
          reject(new Error("Request payload exceeds 25MB limit."));
          req.destroy();
          return;
        }
        accumulated += chunk.toString("utf8");
      });

      req.on("end", () => resolve(accumulated));
      req.on("error", (err) => reject(err));
    });
  }
}
