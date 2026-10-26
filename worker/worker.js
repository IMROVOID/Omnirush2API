// src/proxy/model-catalog.ts
var DEFAULT_MODEL = "gpt-6-astra";
var KNOWN_MODELS = [
  {
    id: "gpt-6-astra",
    displayName: "GPT 6 Astra",
    family: "astra",
    contextLimit: 2e5,
    outputLimit: 16384,
    aliases: ["astra", "gpt-6", "omnirush", "gpt-6-astra-preview"]
  },
  {
    id: "gpt-6.1-sol",
    displayName: "GPT 6.1 Sol",
    family: "sol",
    contextLimit: 2e5,
    outputLimit: 16384,
    aliases: ["sol-pro", "gpt-6.1-sol-preview"]
  },
  {
    id: "gpt-6-sol",
    displayName: "GPT 6 Sol",
    family: "sol",
    contextLimit: 128e3,
    outputLimit: 8192,
    aliases: ["sol", "gpt-6-sol-preview"]
  }
];
function resolveModelId(requestedModel) {
  if (!requestedModel || requestedModel.trim() === "") {
    return DEFAULT_MODEL;
  }
  const normalized = requestedModel.trim().toLowerCase();
  for (const def of KNOWN_MODELS) {
    if (def.id.toLowerCase() === normalized) {
      return def.id;
    }
    if (def.aliases.some((alias) => alias.toLowerCase() === normalized)) {
      return def.id;
    }
  }
  return requestedModel.trim();
}
function getModelList() {
  const now = Math.floor(Date.now() / 1e3);
  const models = KNOWN_MODELS.map((def) => ({
    id: def.id,
    object: "model",
    created: now,
    owned_by: "omnirush.ai",
    root: def.id
  }));
  return {
    object: "list",
    data: models
  };
}

// src/proxy/wire-guard.ts
var OFFICIAL_VERSION = "2.7.0";
var BAN_PATTERNS = [
  /closed\s+automatically/i,
  /unofficial\s+client/i,
  /used\s+from\s+another\s+place/i,
  /account\s+was\s+closed/i,
  /account\s+(?:has\s+been\s+)?suspended/i,
  /account\s+(?:has\s+been\s+)?banned/i,
  /terms\s+of\s+service\s+violation/i,
  /terms\s+of\s+service\s+don't\s+allow/i
];
function detectAccountBan(statusCode, bodyText) {
  if (![400, 401, 403, 451].includes(statusCode)) {
    return { isBanned: false };
  }
  for (const pattern of BAN_PATTERNS) {
    if (pattern.test(bodyText)) {
      return {
        isBanned: true,
        reason: bodyText.slice(0, 300).trim()
      };
    }
  }
  return { isBanned: false };
}
function detectPlatformSignature() {
  if (typeof process !== "undefined" && process.platform) {
    if (process.platform === "darwin") return "darwin";
    if (process.platform === "linux") return "linux";
  }
  return "win32";
}
function createAntiBanHeaders(options) {
  const generated = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID().replaceAll("-", "") : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 22)}`;
  const sessionId = options.requestId?.startsWith("ses_") ? options.requestId : `ses_${generated}`;
  const headers = {
    "Content-Type": "application/json",
    Accept: options.isStream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${options.accessToken}`,
    "User-Agent": "omnirush",
    "X-OmniRush-Client": `cli/${OFFICIAL_VERSION}`,
    "x-omnirush-session-id": sessionId
  };
  return headers;
}
function createAuthApiHeaders() {
  const platform = detectPlatformSignature();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `omnirush/${OFFICIAL_VERSION} (${platform}; x64)`,
    "X-OmniRush-Client": `cli/${OFFICIAL_VERSION}`
  };
}

// src/auth/oauth-client.ts
var DEFAULT_GATEWAY_URL = "https://omnirush.ai/omnirush/v1";
function getControlPlaneUrl(gatewayUrl = DEFAULT_GATEWAY_URL) {
  const trimmed = gatewayUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -3);
  }
  return trimmed;
}
function isTokenExpired(expiresAt, bufferSeconds = 300) {
  if (expiresAt === void 0 || expiresAt <= 0) {
    return true;
  }
  const now = Date.now();
  return expiresAt - bufferSeconds * 1e3 <= now;
}
async function refreshDeviceToken(refreshToken, options = {}) {
  const trimmed = refreshToken.trim();
  if (trimmed === "") {
    return { success: false, error: "Refresh token is empty." };
  }
  const gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const controlPlaneUrl = getControlPlaneUrl(gatewayUrl);
  const maxAttempts = 3;
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${controlPlaneUrl}/device/refresh`, {
        method: "POST",
        headers: createAuthApiHeaders(),
        body: JSON.stringify({ refresh_token: trimmed })
      });
      const responseText = await response.text();
      let data = {};
      try {
        data = JSON.parse(responseText);
      } catch {
        lastError = `Invalid JSON from refresh endpoint (${response.status}): ${responseText.slice(0, 150)}`;
        if ([500, 502, 503, 504].includes(response.status) && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1e3 * attempt));
          continue;
        }
        return { success: false, error: lastError };
      }
      if (!response.ok) {
        const errorMsg = (typeof data["error_description"] === "string" ? data["error_description"] : null) ?? (typeof data["error"] === "string" ? data["error"] : null) ?? (typeof data["detail"] === "string" ? data["detail"] : null) ?? `HTTP ${response.status}`;
        lastError = errorMsg;
        if ([500, 502, 503, 504].includes(response.status) && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1e3 * attempt));
          continue;
        }
        return { success: false, error: errorMsg };
      }
      const accessToken = typeof data["access_token"] === "string" ? data["access_token"] : void 0;
      const newRefreshToken = typeof data["refresh_token"] === "string" ? data["refresh_token"] : trimmed;
      const resolvedGatewayUrl = typeof data["gateway_url"] === "string" ? data["gateway_url"] : gatewayUrl;
      if (!accessToken) {
        return { success: false, error: "Missing access_token in refresh response." };
      }
      return {
        success: true,
        accessToken,
        refreshToken: newRefreshToken,
        gatewayUrl: resolvedGatewayUrl,
        expiresIn: 3600
      };
    } catch (err) {
      lastError = `Network error refreshing token: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1e3 * attempt));
        continue;
      }
    }
  }
  return { success: false, error: lastError || "Token refresh failed after retries." };
}

// src/auth/pool-manager.ts
var DEFAULT_COOLDOWN_MS = 36e5;
function parseCooldownDuration(retryAfterHeader, bodyText) {
  if (retryAfterHeader && retryAfterHeader.trim() !== "") {
    const seconds = parseInt(retryAfterHeader.trim(), 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1e3;
    }
  }
  if (bodyText) {
    const timeMatch = /try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(bodyText);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1] ?? "0", 10);
      const minutes = parseInt(timeMatch[2] ?? "0", 10);
      const seconds = parseInt(timeMatch[3] ?? "0", 10);
      const totalSec = hours * 3600 + minutes * 60 + seconds;
      if (totalSec > 0) {
        return totalSec * 1e3;
      }
    }
  }
  return DEFAULT_COOLDOWN_MS;
}
var AccountPoolManager = class {
  accounts = [];
  currentIndex = 0;
  defaultGatewayUrl;
  onTokenRotated;
  constructor(gatewayUrlOrOptions, onTokenRotated) {
    if (typeof gatewayUrlOrOptions === "object" && gatewayUrlOrOptions !== null) {
      this.defaultGatewayUrl = gatewayUrlOrOptions.defaultGatewayUrl || DEFAULT_GATEWAY_URL;
      this.onTokenRotated = gatewayUrlOrOptions.onTokenRotated;
    } else {
      this.defaultGatewayUrl = gatewayUrlOrOptions || DEFAULT_GATEWAY_URL;
      this.onTokenRotated = onTokenRotated;
    }
  }
  /**
   * Initializes the pool from a delimiter-separated token string (newlines, commas) or JSON array
   */
  initFromTokenList(tokenList) {
    const trimmed = tokenList.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "string" && item.trim()) {
              this.addAccount(item.trim());
            } else if (item && typeof item === "object") {
              const rec = item;
              const ref = typeof rec["refreshToken"] === "string" ? rec["refreshToken"] : typeof rec["refresh_token"] === "string" ? rec["refresh_token"] : null;
              if (ref && ref.trim()) {
                const gateway = typeof rec["gatewayUrl"] === "string" ? rec["gatewayUrl"] : typeof rec["gateway_url"] === "string" ? rec["gateway_url"] : void 0;
                const email = typeof rec["email"] === "string" ? rec["email"] : void 0;
                const acc = typeof rec["accessToken"] === "string" ? rec["accessToken"] : typeof rec["access_token"] === "string" ? rec["access_token"] : void 0;
                this.addAccount(ref.trim(), gateway, email, acc?.trim());
              }
            }
          }
          return;
        }
      } catch {
      }
    }
    const tokens = trimmed.split(/[\r\n,]+/).map((t) => t.trim().replace(/^["']|["']$/g, "")).filter((t) => t.length > 0);
    for (const token of tokens) {
      this.addAccount(token);
    }
  }
  /**
   * Adds an account to the pool
   */
  addAccount(refreshToken, gatewayUrl, email, initialAccessToken) {
    let token = refreshToken.trim();
    let initialToken = initialAccessToken;
    if (token.includes("|")) {
      const parts = token.split("|");
      token = (parts[0] ?? "").trim();
      if (!initialToken && parts[1]) {
        initialToken = parts[1].trim();
      }
    }
    if (token === "" || this.accounts.some((a) => a.refreshToken === token)) {
      return;
    }
    const id = `account-${this.accounts.length + 1}`;
    this.accounts.push({
      id,
      refreshToken: token,
      accessToken: initialToken ?? null,
      gatewayUrl: gatewayUrl || this.defaultGatewayUrl,
      expiresAt: initialToken ? Date.now() + 36e5 : 0,
      cooldownUntil: 0,
      failureCount: 0,
      lastUsedAt: 0,
      email
    });
  }
  locks = /* @__PURE__ */ new Map();
  /**
   * Executes an action under a per-account mutual exclusion lock to prevent concurrent sessions
   */
  async withAccountLock(accountId, fn) {
    while (this.locks.has(accountId)) {
      await this.locks.get(accountId);
    }
    let resolveLock;
    const lockPromise = new Promise((res) => {
      resolveLock = res;
    });
    this.locks.set(accountId, lockPromise);
    try {
      return await fn();
    } finally {
      this.locks.delete(accountId);
      resolveLock();
    }
  }
  /**
   * Marks an account as permanently banned / suspended, quarantining it from the pool
   */
  markBanned(accountId, reason) {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return;
    account.isBanned = true;
    account.bannedReason = reason ?? "Account suspended/closed by upstream";
    account.cooldownUntil = Number.MAX_SAFE_INTEGER;
    console.error(
      `[Omnirush2API Guard] \u{1F6A8} DANGER: Account ${account.id} was permanently BANNED/SUSPENDED by Omnirush: ${account.bannedReason}. Quarantined from pool.`
    );
  }
  /**
   * Marks an account as in cooldown for specified duration
   */
  markCooldown(accountId, durationMs, reason) {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account || account.isBanned) return;
    account.cooldownUntil = Date.now() + durationMs;
    account.failureCount++;
    console.warn(
      `[Omnirush2API Pool] Account ${account.id} placed in cooldown for ${Math.round(durationMs / 1e3)}s: ${reason ?? "Rate limit / Quota reached"}`
    );
  }
  /**
   * Selects the next available ready account via round-robin, refreshing tokens if needed
   */
  async getNextAvailableAccount() {
    const total = this.accounts.length;
    if (total === 0) return null;
    const now = Date.now();
    for (let i = 0; i < total; i++) {
      const idx = (this.currentIndex + i) % total;
      const candidate = this.accounts[idx];
      if (!candidate || candidate.isBanned) continue;
      if (now < candidate.cooldownUntil) {
        continue;
      }
      if (candidate.accessToken === null || isTokenExpired(candidate.expiresAt)) {
        const refreshResult = await refreshDeviceToken(candidate.refreshToken, {
          gatewayUrl: candidate.gatewayUrl
        });
        const oldRefreshToken = candidate.refreshToken;
        if (refreshResult.success && refreshResult.accessToken) {
          candidate.accessToken = refreshResult.accessToken;
          if (refreshResult.refreshToken) {
            candidate.refreshToken = refreshResult.refreshToken;
          }
          if (refreshResult.gatewayUrl) {
            candidate.gatewayUrl = refreshResult.gatewayUrl;
          }
          const expiresIn = refreshResult.expiresIn ?? 3600;
          candidate.expiresAt = now + expiresIn * 1e3;
          candidate.failureCount = 0;
          if (this.onTokenRotated && refreshResult.refreshToken && refreshResult.refreshToken !== oldRefreshToken) {
            try {
              await this.onTokenRotated(oldRefreshToken, candidate);
            } catch (err) {
              console.error("[Omnirush2API Pool] onTokenRotated callback error:", err);
            }
          }
        } else {
          const banCheck = detectAccountBan(403, refreshResult.error ?? "");
          if (banCheck.isBanned) {
            this.markBanned(candidate.id, banCheck.reason ?? refreshResult.error);
          } else {
            this.markCooldown(candidate.id, 6e4, refreshResult.error);
          }
          continue;
        }
      }
      this.currentIndex = (idx + 1) % total;
      candidate.lastUsedAt = now;
      return candidate;
    }
    return null;
  }
  /**
   * Returns current pool metrics
   */
  getStats() {
    const now = Date.now();
    let active = 0;
    let inCooldown = 0;
    let banned = 0;
    for (const account of this.accounts) {
      if (account.isBanned) {
        banned++;
      } else if (now < account.cooldownUntil) {
        inCooldown++;
      } else {
        active++;
      }
    }
    return {
      total: this.accounts.length,
      active,
      inCooldown,
      banned
    };
  }
  invalidateAccountToken(accountId) {
    const account = this.accounts.find((a) => a.id === accountId);
    if (account) {
      account.accessToken = null;
      account.expiresAt = 0;
    }
  }
  getAllAccounts() {
    return this.accounts;
  }
};

// src/proxy/normalizer.ts
function blockText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : JSON.stringify(value);
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof part.text === "string") return part.text;
    return "";
  }).join("");
}
function textParts(content, type, role) {
  if (typeof content === "string") return [{ type, text: content }];
  if (content === null) return [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (typeof part === "string") {
      blocks.push({ type, text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const value = part;
    const kind = typeof value.type === "string" ? value.type : "text";
    if (kind === "text") {
      if (typeof value.text === "string") blocks.push({ type, text: value.text });
      continue;
    }
    if (kind === "thinking" || kind === "redacted_thinking") continue;
    if (kind === "tool_result") {
      blocks.push({
        type: "function_call_output",
        call_id: typeof value.tool_use_id === "string" ? value.tool_use_id : "unknown",
        output: blockText(value.content)
      });
      continue;
    }
    if (kind === "tool_use") {
      blocks.push({
        type: "function_call",
        call_id: typeof value.id === "string" ? value.id : "unknown",
        name: typeof value.name === "string" ? value.name : "tool",
        arguments: typeof value.input === "string" ? value.input : JSON.stringify(value.input ?? {})
      });
      continue;
    }
    if (kind === "input_text" || kind === "output_text" || kind === "input_image" || kind === "image_url") {
      blocks.push(value);
      continue;
    }
    if (role === "user" && typeof value.text === "string") blocks.push({ type, text: value.text });
  }
  return blocks;
}
function normalizeInput(request) {
  if (Array.isArray(request.input)) return request.input;
  return request.messages.map((message) => {
    if (message.role === "tool") {
      return {
        type: "function_call_output",
        call_id: message.tool_call_id ?? "unknown",
        output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")
      };
    }
    return {
      role: message.role,
      ...message.name ? { name: message.name } : {},
      content: textParts(message.content, message.role === "assistant" ? "output_text" : "input_text", message.role)
    };
  });
}
function normalizeCompletionRequest(request) {
  const targetModel = resolveModelId(request.model);
  let reasoning;
  if (request.reasoning_effort) {
    reasoning = {
      effort: request.reasoning_effort,
      summary: "auto"
    };
  } else if (targetModel.includes("astra")) {
    reasoning = {
      effort: "medium",
      summary: "auto"
    };
  }
  return {
    model: targetModel,
    input: normalizeInput(request),
    // The OmniRush Responses gateway requires streaming, even when the local
    // OpenAI-compatible caller asks for a non-streaming chat completion.
    stream: true,
    store: false,
    ...typeof request.temperature === "number" ? { temperature: request.temperature } : {},
    ...typeof request.top_p === "number" ? { top_p: request.top_p } : {},
    ...typeof request.max_output_tokens === "number" ? { max_output_tokens: request.max_output_tokens } : typeof request.max_tokens === "number" ? { max_output_tokens: request.max_tokens } : {},
    ...request.stop ? { stop: request.stop } : {},
    ...reasoning ? { reasoning } : {},
    ...reasoning ? { include: ["reasoning.encrypted_content"] } : {}
  };
}
function normalizeCompletionResponse(raw, fallbackModel) {
  const now = Math.floor(Date.now() / 1e3);
  const data = raw && typeof raw === "object" ? raw : {};
  const id = typeof data["id"] === "string" ? data["id"] : `chatcmpl-${Date.now()}`;
  const model = typeof data["model"] === "string" ? data["model"] : fallbackModel;
  const created = typeof data["created"] === "number" ? data["created"] : now;
  let choices = [];
  if (Array.isArray(data["choices"])) {
    choices = data["choices"].map((c, i) => {
      const msg = c["message"] && typeof c["message"] === "object" ? c["message"] : {};
      const role = typeof msg["role"] === "string" ? msg["role"] : "assistant";
      const content = typeof msg["content"] === "string" ? msg["content"] : null;
      const reasoning = typeof msg["reasoning_content"] === "string" ? msg["reasoning_content"] : typeof msg["reasoning"] === "string" ? msg["reasoning"] : void 0;
      return {
        index: typeof c["index"] === "number" ? c["index"] : i,
        message: {
          role,
          content,
          ...reasoning ? { reasoning_content: reasoning } : {}
        },
        finish_reason: c["finish_reason"] ?? "stop"
      };
    });
  } else if (typeof data["content"] === "string" || typeof data["output"] === "string") {
    const reasoning = typeof data["reasoningContent"] === "string" ? data["reasoningContent"] : void 0;
    choices = [
      {
        index: 0,
        message: {
          role: "assistant",
          content: typeof data["content"] === "string" ? data["content"] : data["output"],
          ...reasoning ? { reasoning_content: reasoning } : {}
        },
        finish_reason: "stop"
      }
    ];
  }
  if (choices.length === 0) {
    choices = [
      {
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "stop"
      }
    ];
  }
  let usage;
  if (data["usage"] && typeof data["usage"] === "object") {
    const u = data["usage"];
    usage = {
      prompt_tokens: typeof u["prompt_tokens"] === "number" ? u["prompt_tokens"] : 0,
      completion_tokens: typeof u["completion_tokens"] === "number" ? u["completion_tokens"] : 0,
      total_tokens: typeof u["total_tokens"] === "number" ? u["total_tokens"] : 0
    };
  }
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices,
    ...usage ? { usage } : {}
  };
}

// src/proxy/stream-transformer.ts
var SSE_DONE_MESSAGE = "data: [DONE]\n\n";
function parseSSELine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") {
    return "[DONE]";
  }
  try {
    const parsed = JSON.parse(payload);
    if (parsed !== null && typeof parsed === "object") {
      return parsed;
    }
  } catch {
  }
  return null;
}
function createChunkDelta(options) {
  const choice = {
    index: options.index ?? 0,
    delta: {
      ...options.role !== void 0 ? { role: options.role } : {},
      ...options.content !== void 0 ? { content: options.content } : {},
      ...options.reasoningContent !== void 0 ? { reasoning_content: options.reasoningContent } : {}
    },
    finish_reason: options.finishReason ?? null
  };
  return {
    id: options.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model: options.model,
    choices: [choice]
  };
}
function transformUpstreamChunk(upstream, requestedModel) {
  const response = upstream["response"] && typeof upstream["response"] === "object" ? upstream["response"] : null;
  const id = typeof upstream["id"] === "string" ? upstream["id"] : response && typeof response["id"] === "string" ? response["id"] : `chatcmpl-${Date.now()}`;
  const eventType = typeof upstream["type"] === "string" ? upstream["type"] : "";
  if (eventType === "response.output_text.delta") {
    return createChunkDelta({
      id,
      model: requestedModel,
      content: typeof upstream["delta"] === "string" ? upstream["delta"] : ""
    });
  }
  if (/^response\.(reasoning|summary).*\.delta$/.test(eventType)) {
    return createChunkDelta({
      id,
      model: requestedModel,
      reasoningContent: typeof upstream["delta"] === "string" ? upstream["delta"] : ""
    });
  }
  if (eventType === "response.output_item.added") {
    const item = upstream["item"];
    if (item && typeof item === "object" && item["role"] === "assistant") {
      return createChunkDelta({ id, model: requestedModel, role: "assistant" });
    }
    return null;
  }
  if (eventType === "response.completed") {
    return createChunkDelta({ id, model: requestedModel, finishReason: "stop" });
  }
  const choicesRaw = Array.isArray(upstream["choices"]) ? upstream["choices"] : [];
  if (choicesRaw.length > 0) {
    const choices = [];
    for (let i = 0; i < choicesRaw.length; i++) {
      const rawChoice = choicesRaw[i];
      if (rawChoice !== null && typeof rawChoice === "object") {
        const deltaObj = rawChoice["delta"];
        const finishReason = rawChoice["finish_reason"];
        let content = null;
        let reasoningContent = null;
        let role = void 0;
        if (deltaObj !== null && typeof deltaObj === "object") {
          const d = deltaObj;
          if (typeof d["content"] === "string") content = d["content"];
          if (typeof d["reasoning_content"] === "string") reasoningContent = d["reasoning_content"];
          else if (typeof d["reasoning"] === "string") reasoningContent = d["reasoning"];
          if (d["role"] === "assistant") role = "assistant";
        }
        choices.push({
          index: i,
          delta: {
            ...role !== void 0 ? { role } : {},
            ...content !== null ? { content } : {},
            ...reasoningContent !== null ? { reasoning_content: reasoningContent } : {}
          },
          finish_reason: finishReason ?? null
        });
      }
    }
    return {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1e3),
      model: requestedModel,
      choices
    };
  }
  if (typeof upstream["delta"] === "string") {
    return createChunkDelta({
      id,
      model: requestedModel,
      content: upstream["delta"]
    });
  }
  return null;
}
function formatSSEChunk(chunk) {
  return `data: ${JSON.stringify(chunk)}

`;
}
function createSSETransformStream(requestedModel) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseId = `chatcmpl-${Date.now()}`;
  return new TransformStream({
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
          const response = parsed.response && typeof parsed.response === "object" ? parsed.response : null;
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
          const response = parsed.response && typeof parsed.response === "object" ? parsed.response : null;
          if (response && typeof response.id === "string") responseId = response.id;
          const transformed = transformUpstreamChunk({ id: responseId, ...parsed }, requestedModel);
          if (transformed !== null) {
            controller.enqueue(encoder.encode(formatSSEChunk(transformed)));
          }
        }
      }
      controller.enqueue(encoder.encode(SSE_DONE_MESSAGE));
    }
  });
}
function responseOutputText(value) {
  if (!Array.isArray(value)) return "";
  const text = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item;
    const content = record.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && typeof part.text === "string") {
        const partText = part.text;
        if (typeof partText === "string") text.push(partText);
      }
    }
  }
  return text.join("");
}
function aggregateResponsesSSE(text, requestedModel) {
  let id = `chatcmpl-${Date.now()}`;
  let model = requestedModel;
  let content = "";
  let reasoningContent = "";
  let usage;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseSSELine(line);
    if (!parsed || parsed === "[DONE]") continue;
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const response = parsed.response && typeof parsed.response === "object" ? parsed.response : null;
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
        const value = rawUsage;
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
    ...reasoningContent ? { reasoningContent } : {},
    ...usage ? { usage } : {}
  };
}

// src/proxy/completion-handler.ts
function generateRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
var CompletionProxyHandler = class {
  pool;
  upstreamBaseUrl;
  requestTimeoutMs;
  constructor(options) {
    this.pool = options.pool;
    this.upstreamBaseUrl = options.upstreamBaseUrl ?? DEFAULT_GATEWAY_URL;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 12e4;
  }
  async handleCompletion(request, signal) {
    if (signal?.aborted) {
      return {
        status: 499,
        isStream: false,
        errorResponse: {
          error: { message: "Client cancelled request.", type: "client_closed_request" }
        }
      };
    }
    const targetModel = resolveModelId(request.model);
    const normalizedPayload = normalizeCompletionRequest(request);
    const isStream = request.stream === true;
    const maxAttempts = Math.max(2, this.pool.getStats().total);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) {
        return {
          status: 499,
          isStream: false,
          errorResponse: {
            error: { message: "Client cancelled request.", type: "client_closed_request" }
          }
        };
      }
      const account = await this.pool.getNextAvailableAccount();
      if (!account) {
        const stats = this.pool.getStats();
        if (stats.banned > 0 && stats.active === 0) {
          return {
            status: 403,
            isStream: false,
            errorResponse: {
              error: {
                message: "OmniRush account was closed or suspended by upstream (unofficial client / multi-session detection). Account quarantined.",
                type: "account_suspended_error",
                code: "account_banned_by_upstream"
              }
            }
          };
        }
        return {
          status: 429,
          isStream: false,
          errorResponse: {
            error: {
              message: "All OmniRush accounts in pool are currently in cooldown or unavailable.",
              type: "rate_limit_error",
              code: "all_accounts_cooling_down"
            }
          }
        };
      }
      const requestId = generateRequestId();
      const gatewayUrl = (account.gatewayUrl || this.upstreamBaseUrl).replace(/\/+$/, "");
      const headers = createAntiBanHeaders({
        accessToken: account.accessToken ?? "",
        requestId,
        // The OmniRush Responses gateway currently requires stream=true for
        // every model request. We aggregate it below for non-stream callers.
        isStream: true
      });
      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        const response = await this.pool.withAccountLock(account.id, async () => {
          return await fetch(`${gatewayUrl}/responses`, {
            method: "POST",
            headers,
            body: JSON.stringify(normalizedPayload),
            signal: combinedSignal
          });
        });
        if (isStream && response.ok && response.body) {
          const transformedStream = response.body.pipeThrough(
            createSSETransformStream(targetModel)
          );
          return {
            status: 200,
            isStream: true,
            streamResponse: transformedStream
          };
        }
        const responseText = await response.text();
        const banCheck = detectAccountBan(response.status, responseText);
        if (banCheck.isBanned) {
          this.pool.markBanned(account.id, banCheck.reason);
          continue;
        }
        if (response.status === 401) {
          this.pool.invalidateAccountToken(account.id);
          this.pool.markCooldown(account.id, 0, "HTTP 401 Unauthorized; refreshing access token");
          continue;
        }
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const cooldownMs = parseCooldownDuration(retryAfter, responseText);
          this.pool.markCooldown(account.id, cooldownMs, `HTTP 429: ${responseText.slice(0, 100)}`);
          continue;
        }
        let parsedJson = {};
        try {
          parsedJson = response.headers.get("content-type")?.includes("text/event-stream") ? aggregateResponsesSSE(responseText, targetModel) : JSON.parse(responseText);
        } catch {
          return {
            status: response.status,
            isStream: false,
            errorResponse: {
              error: {
                message: `Invalid JSON from OmniRush gateway: ${responseText.slice(0, 200)}`,
                type: "gateway_error"
              }
            }
          };
        }
        if (response.ok) {
          return {
            status: 200,
            isStream: false,
            jsonResponse: normalizeCompletionResponse(parsedJson, targetModel)
          };
        }
        return {
          status: response.status,
          isStream: false,
          errorResponse: parsedJson ?? {
            error: { message: `Gateway error (${response.status})`, type: "gateway_error" }
          }
        };
      } catch (err) {
        console.error(`[Omnirush2API] upstream request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (signal?.aborted) {
          return {
            status: 499,
            isStream: false,
            errorResponse: {
              error: { message: "Client cancelled request.", type: "client_closed_request" }
            }
          };
        }
        this.pool.markCooldown(
          account.id,
          3e4,
          `Network error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return {
      status: 502,
      isStream: false,
      errorResponse: {
        error: {
          message: "All retry attempts against OmniRush gateway failed.",
          type: "bad_gateway"
        }
      }
    };
  }
};

// src/worker/index.ts
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-OmniRush-Client"
};
var globalPool = null;
var lastTokenHash = "";
async function getOrCreatePool(env) {
  const envTokens = env.OMNIRUSH_REFRESH_TOKEN ?? "";
  const accessToken = env.OMNIRUSH_ACCESS_TOKEN ?? "";
  const gatewayUrl = env.GATEWAY_URL || DEFAULT_GATEWAY_URL;
  let kvToken = null;
  if (env.TOKEN_KV) {
    try {
      kvToken = await env.TOKEN_KV.get("omnirush_token");
    } catch {
    }
  }
  const effectiveTokenString = kvToken || envTokens;
  const tokenHash = `${effectiveTokenString}::${accessToken}::${gatewayUrl}`;
  if (globalPool === null || lastTokenHash !== tokenHash) {
    globalPool = new AccountPoolManager(gatewayUrl, async (_oldToken, account) => {
      if (env.TOKEN_KV) {
        try {
          await env.TOKEN_KV.put(
            "omnirush_token",
            `${account.refreshToken}|${account.accessToken ?? ""}`
          );
        } catch (err) {
          console.error("[Omnirush2API Worker KV] Failed to store rotated token:", err);
        }
      }
    });
    if (effectiveTokenString.trim() !== "") {
      globalPool.initFromTokenList(effectiveTokenString);
      if (accessToken.trim() !== "") {
        const accounts = globalPool.getAllAccounts();
        if (accounts.length > 0 && accounts[0] && !accounts[0].accessToken) {
          accounts[0].accessToken = accessToken.trim();
          accounts[0].expiresAt = Date.now() + 36e5;
        }
      }
    }
    lastTokenHash = tokenHash;
  }
  return globalPool;
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}
var index_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (env.API_KEY && env.API_KEY.trim() !== "") {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== `Bearer ${env.API_KEY}`) {
        return jsonResponse(
          {
            error: {
              message: "Invalid API key provided.",
              type: "invalid_request_error",
              code: "invalid_api_key"
            }
          },
          401
        );
      }
    }
    const pool = await getOrCreatePool(env);
    if (request.method === "GET" && (pathname === "/v1/health" || pathname === "/health" || pathname === "/")) {
      const stats = pool.getStats();
      const isBanned = stats.total > 0 && stats.banned === stats.total;
      const isDegraded = stats.total > 0 && stats.active === 0;
      const isUnhealthy = stats.total === 0;
      return jsonResponse({
        status: isBanned ? "banned" : isUnhealthy ? "unhealthy" : isDegraded ? "degraded" : "healthy",
        version: "1.0.1",
        mode: "cloudflare-worker",
        api_key_configured: Boolean(env.API_KEY && env.API_KEY.trim() !== ""),
        kv_storage_configured: Boolean(env.TOKEN_KV),
        account_count: stats.total,
        active_accounts: stats.active,
        cooldown_accounts: stats.inCooldown,
        banned_accounts: stats.banned,
        supported_models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"]
      });
    }
    if (request.method === "GET" && pathname === "/v1/models") {
      return jsonResponse(getModelList());
    }
    if (request.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/v1/responses")) {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(
          { error: { message: "Malformed JSON payload in request body.", type: "invalid_request_error" } },
          400
        );
      }
      if (!body.model || !Array.isArray(body.messages)) {
        return jsonResponse(
          { error: { message: "Missing required 'model' or 'messages' field.", type: "invalid_request_error" } },
          400
        );
      }
      const handler = new CompletionProxyHandler({
        pool,
        upstreamBaseUrl: env.GATEWAY_URL || DEFAULT_GATEWAY_URL
      });
      const result = await handler.handleCompletion(body, request.signal);
      if (result.isStream && result.streamResponse) {
        return new Response(result.streamResponse, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...CORS_HEADERS
          }
        });
      }
      if (result.jsonResponse) {
        return jsonResponse(result.jsonResponse, result.status);
      }
      return jsonResponse(result.errorResponse ?? {}, result.status);
    }
    return jsonResponse(
      {
        error: {
          message: `Unknown path: ${pathname}`,
          type: "invalid_request_error",
          code: "resource_not_found"
        }
      },
      404
    );
  }
};
export {
  index_default as default
};
