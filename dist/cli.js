#!/usr/bin/env node


// src/server/http-server.ts
import http from "node:http";

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
function generateRealisticDeviceName() {
  const chars = "0123456789ABCDEF";
  let suffix = "";
  for (let i = 0; i < 7; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const platform = detectPlatformSignature();
  if (platform === "darwin") {
    return `MacBook-${suffix.slice(0, 4)}`;
  }
  return `DESKTOP-${suffix}`;
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
async function initiateDeviceFlow(options = {}) {
  const {
    gatewayUrl = DEFAULT_GATEWAY_URL,
    deviceName = generateRealisticDeviceName(),
    platform = detectPlatformSignature()
  } = options;
  const controlPlaneUrl = getControlPlaneUrl(gatewayUrl);
  const maxAttempts = 4;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${controlPlaneUrl}/device/authorize`, {
        method: "POST",
        headers: createAuthApiHeaders(),
        body: JSON.stringify({
          device_name: deviceName,
          platform
        })
      });
      if (response.ok) {
        return await response.json();
      }
      const errorText = await response.text().catch(() => "");
      const isRetryable = [500, 502, 503, 504].includes(response.status);
      lastError = new Error(
        `Device authorization failed (${response.status}): ${errorText.slice(0, 200)}`
      );
      if (!isRetryable || attempt === maxAttempts) {
        throw lastError;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxAttempts) {
        throw lastError;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1e3 * attempt));
  }
  throw lastError ?? new Error("Device authorization timed out.");
}
async function pollDeviceToken(deviceCode, options = {}) {
  const {
    gatewayUrl = DEFAULT_GATEWAY_URL,
    intervalSeconds = 5,
    maxAttempts = 180,
    // up to 15 minutes by default
    signal
  } = options;
  const controlPlaneUrl = getControlPlaneUrl(gatewayUrl);
  const delayMs = Math.max(10, Math.floor(intervalSeconds * 1e3));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      return { success: false, error: "Polling aborted by client." };
    }
    try {
      const response = await fetch(`${controlPlaneUrl}/device/token`, {
        method: "POST",
        headers: createAuthApiHeaders(),
        body: JSON.stringify({ device_code: deviceCode }),
        ...signal ? { signal } : {}
      });
      if (response.status === 428) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      if (response.ok) {
        const data = await response.json();
        return {
          success: true,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          gatewayUrl: data.gateway_url || gatewayUrl,
          expiresIn: 3600
        };
      }
      const errorText = await response.text().catch(() => "");
      return {
        success: false,
        error: `Device token request rejected (${response.status}): ${errorText.slice(0, 200)}`
      };
    } catch (err) {
      if (signal?.aborted) {
        return { success: false, error: "Polling aborted by client." };
      }
      return {
        success: false,
        error: `Network error polling device token: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }
  return { success: false, error: "Device code authorization timed out." };
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
async function fetchAccountProfile(accessToken, gatewayUrl = DEFAULT_GATEWAY_URL) {
  const controlPlaneUrl = getControlPlaneUrl(gatewayUrl);
  try {
    const response = await fetch(`${controlPlaneUrl}/device/me`, {
      method: "GET",
      headers: {
        ...createAuthApiHeaders(),
        Authorization: `Bearer ${accessToken.trim()}`
      }
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
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

// src/server/routes.ts
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-OmniRush-Client"
};
var RequestDispatcher = class {
  config;
  pool;
  handler;
  constructor(config, pool) {
    this.config = config;
    this.pool = pool;
    this.handler = new CompletionProxyHandler({
      pool,
      upstreamBaseUrl: config.gatewayUrl
    });
  }
  async dispatch(req, res) {
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
              code: "invalid_api_key"
            }
          })
        );
        return;
      }
    }
    if (req.method === "GET" && (pathname === "/v1/health" || pathname === "/health" || pathname === "/")) {
      this.handleHealth(res);
      return;
    }
    if (req.method === "GET" && pathname === "/v1/models") {
      this.handleModels(res);
      return;
    }
    if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/v1/responses")) {
      await this.handleChatCompletions(req, res, pathname === "/v1/responses");
      return;
    }
    if (req.method === "POST" && pathname === "/v1/messages") {
      await this.handleAnthropicMessages(req, res);
      return;
    }
    if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
      let rawBody = "";
      try {
        rawBody = await this.readRequestBody(req);
        const payload = JSON.parse(rawBody);
        const serialized = JSON.stringify({ system: payload.system, messages: payload.messages, tools: payload.tools });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(serialized.length / 4)) }));
      } catch {
        this.writeJsonError(res, 400, "Malformed JSON payload in request body.");
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `Unknown path: ${pathname}`,
          type: "invalid_request_error",
          code: "resource_not_found"
        }
      })
    );
  }
  handleHealth(res) {
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
          supported_models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"]
        },
        null,
        2
      )
    );
  }
  handleModels(res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getModelList(), null, 2));
  }
  async handleChatCompletions(req, res, responsesApi = false) {
    let rawBody = "";
    try {
      rawBody = await this.readRequestBody(req);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `Failed to read request body: ${err instanceof Error ? err.message : String(err)}`,
            type: "invalid_request_error"
          }
        })
      );
      return;
    }
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Malformed JSON payload in request body.",
            type: "invalid_request_error"
          }
        })
      );
      return;
    }
    if (!payload.model || !Array.isArray(payload.messages) && !responsesApi) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: responsesApi ? "Missing required 'model' or 'input' field." : "Missing required 'model' or 'messages' field.",
            type: "invalid_request_error"
          }
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
        Connection: "keep-alive"
      });
      const reader = result.streamResponse.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch {
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
  responsesToChatRequest(payload) {
    const input = payload.input;
    const messages = Array.isArray(input) ? input.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item;
      if (value.type === "message" || typeof value.role === "string") {
        const content = Array.isArray(value.content) ? value.content : typeof value.content === "string" ? value.content : "";
        return [{ role: value.role === "assistant" ? "assistant" : value.role === "system" ? "system" : "user", content }];
      }
      if (value.type === "function_call_output") {
        return [{ role: "tool", tool_call_id: typeof value.call_id === "string" ? value.call_id : "unknown", content: typeof value.output === "string" ? value.output : JSON.stringify(value.output ?? "") }];
      }
      return [];
    }) : [{ role: "user", content: typeof input === "string" ? input : JSON.stringify(input ?? "") }];
    return { ...payload, messages };
  }
  async handleAnthropicMessages(req, res) {
    let rawBody = "";
    try {
      rawBody = await this.readRequestBody(req);
    } catch (error) {
      this.writeJsonError(res, 400, `Failed to read request body: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let payload;
    try {
      const parsed = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be an object");
      payload = parsed;
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
        Connection: "keep-alive"
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
  anthropicToChatRequest(payload) {
    const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
    const messages = [];
    if (typeof payload.system === "string" || Array.isArray(payload.system)) messages.push({ role: "system", content: payload.system });
    for (const entry of rawMessages) {
      if (!entry || typeof entry !== "object") continue;
      const value = entry;
      const role = value.role === "assistant" ? "assistant" : "user";
      const content = typeof value.content === "string" ? value.content : Array.isArray(value.content) ? value.content : "";
      messages.push({ role, content });
    }
    const maxTokens = typeof payload.max_tokens === "number" ? payload.max_tokens : void 0;
    const stopSequences = Array.isArray(payload.stop_sequences) ? payload.stop_sequences.filter((value) => typeof value === "string") : void 0;
    const thinking = payload.thinking && typeof payload.thinking === "object" ? payload.thinking : null;
    const budget = typeof thinking?.budget_tokens === "number" ? thinking.budget_tokens : 0;
    const reasoning_effort = thinking?.type === "enabled" ? budget >= 16e3 ? "max" : budget >= 8e3 ? "high" : budget >= 4e3 ? "medium" : "low" : void 0;
    return {
      model: typeof payload.model === "string" ? payload.model : "",
      messages,
      stream: payload.stream === true,
      ...typeof payload.temperature === "number" ? { temperature: payload.temperature } : {},
      ...typeof payload.top_p === "number" ? { top_p: payload.top_p } : {},
      ...maxTokens !== void 0 ? { max_tokens: maxTokens } : {},
      ...stopSequences && stopSequences.length ? { stop: stopSequences } : {},
      ...reasoning_effort ? { reasoning_effort } : {}
    };
  }
  chatToAnthropicResponse(response) {
    const choice = response.choices[0];
    const content = choice?.message.content;
    const text = typeof content === "string" ? content : content == null ? "" : JSON.stringify(content);
    const reasoning = choice?.message.reasoning_content;
    const blocks = [
      ...reasoning ? [{ type: "thinking", thinking: reasoning }] : [],
      { type: "text", text }
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
        output_tokens: response.usage?.completion_tokens ?? 0
      }
    };
  }
  async writeAnthropicStream(stream, res, model) {
    const decoder = new TextDecoder();
    let buffer = "";
    let messageId = `msg_${Date.now()}`;
    let nextBlockIndex = 0;
    let thinkingBlockIndex = null;
    let textBlockIndex = null;
    let finished = false;
    const send = (event, data) => {
      res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
    };
    send("message_start", {
      type: "message_start",
      message: { id: messageId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
    });
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      try {
        const chunk = JSON.parse(trimmed.slice(5).trim());
        if (typeof chunk.id === "string") messageId = chunk.id;
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        const first = choices[0] && typeof choices[0] === "object" ? choices[0] : null;
        const delta = first?.delta && typeof first.delta === "object" ? first.delta : null;
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
  writeJsonError(res, status, message) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
  }
  readRequestBody(req, maxBytes = 25 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let accumulated = "";
      let bytesCount = 0;
      req.on("data", (chunk) => {
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
};

// src/server/http-server.ts
async function startHttpServer(config, pool) {
  const dispatcher = new RequestDispatcher(config, pool);
  const server = http.createServer(async (req, res) => {
    try {
      await dispatcher.dispatch(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `Internal server error: ${err instanceof Error ? err.message : String(err)}`,
              type: "internal_error"
            }
          })
        );
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      resolve();
    });
  });
  const url = `http://${config.host}:${config.port}`;
  const stop = async () => {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  };
  return {
    server,
    url,
    stop
  };
}

// src/auth/clicreds.ts
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
function normalizeGatewayUrl(value) {
  if (!value) return void 0;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return void 0;
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
function parseCredentialFileContent(content, sourcePath) {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const json = JSON.parse(trimmed);
    const refreshToken = (typeof json["refresh_token"] === "string" ? json["refresh_token"] : null) ?? (typeof json["refreshToken"] === "string" ? json["refreshToken"] : null);
    if (!refreshToken || refreshToken.trim() === "") {
      return null;
    }
    const accessToken = (typeof json["access_token"] === "string" ? json["access_token"] : null) ?? (typeof json["accessToken"] === "string" ? json["accessToken"] : null) ?? void 0;
    const gatewayUrl = (typeof json["gateway_url"] === "string" ? json["gateway_url"] : null) ?? (typeof json["gatewayUrl"] === "string" ? json["gatewayUrl"] : null) ?? void 0;
    const email = typeof json["email"] === "string" ? json["email"] : void 0;
    return {
      source: `file:${sourcePath}`,
      path: sourcePath,
      refreshToken: refreshToken.trim(),
      accessToken: accessToken?.trim(),
      gatewayUrl: normalizeGatewayUrl(gatewayUrl),
      email: email?.trim()
    };
  } catch {
    if (trimmed.startsWith("omni_ref_") || trimmed.length >= 32) {
      return {
        source: `file:${sourcePath}`,
        path: sourcePath,
        refreshToken: trimmed
      };
    }
    return null;
  }
}
function getStandardCredentialPaths() {
  const home = os.homedir();
  const platform = process.platform;
  const paths = [];
  if (platform === "win32") {
    const appData = process.env["APPDATA"] || path.join(home, "AppData", "Roaming");
    const localAppData = process.env["LOCALAPPDATA"] || path.join(home, "AppData", "Local");
    paths.push(
      path.join(appData, "OmniRush", "credentials"),
      path.join(appData, "OmniRush", "credentials.fallback"),
      path.join(localAppData, "OmniRush", "credentials"),
      path.join(localAppData, "OmniRush", "credentials.fallback")
    );
  } else if (platform === "darwin") {
    paths.push(
      path.join(home, "Library", "Application Support", "OmniRush", "credentials"),
      path.join(home, "Library", "Application Support", "OmniRush", "credentials.fallback")
    );
  } else {
    const configHome = process.env["XDG_CONFIG_HOME"] || path.join(home, ".config");
    paths.push(
      path.join(configHome, "OmniRush", "credentials"),
      path.join(configHome, "OmniRush", "credentials.fallback")
    );
  }
  paths.push(path.join(home, ".omnirush2api", "tokens.json"));
  paths.push(path.join(home, ".omnirush", "auth.json"));
  return paths;
}
async function findLocalCredentials(options = {}) {
  const discovered = [];
  const seenTokens = /* @__PURE__ */ new Set();
  const envRefreshToken = process.env["OMNIRUSH_REFRESH_TOKEN"]?.trim();
  if (envRefreshToken) {
    let tokens = [];
    if (envRefreshToken.startsWith("[") && envRefreshToken.endsWith("]")) {
      try {
        const parsed = JSON.parse(envRefreshToken);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const tok = typeof item === "string" ? item.trim() : item && typeof item === "object" ? item["refreshToken"] || item["refresh_token"] : null;
            if (typeof tok === "string" && tok.trim()) {
              tokens.push(tok.trim());
            }
          }
        }
      } catch {
      }
    }
    if (tokens.length === 0) {
      tokens = envRefreshToken.split(/[\r\n,]+/).map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    for (const tok of tokens) {
      if (!seenTokens.has(tok)) {
        seenTokens.add(tok);
        discovered.push({
          source: "env:OMNIRUSH_REFRESH_TOKEN",
          refreshToken: tok,
          accessToken: process.env["OMNIRUSH_ACCESS_TOKEN"]?.trim(),
          gatewayUrl: process.env["OMNIRUSH_GATEWAY_URL"]?.trim() || DEFAULT_GATEWAY_URL
        });
      }
    }
  }
  const candidatePaths = [...getStandardCredentialPaths(), ...options.extraPaths ?? []];
  for (const candidate of candidatePaths) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(candidate, "utf8");
      const cred = parseCredentialFileContent(content, candidate);
      if (cred && !seenTokens.has(cred.refreshToken)) {
        seenTokens.add(cred.refreshToken);
        discovered.push(cred);
      }
    } catch {
    }
  }
  return discovered;
}

// src/auth/token-store.ts
import fs2 from "node:fs/promises";
import path2 from "node:path";
import os2 from "node:os";
function getDefaultTokenStorePath() {
  return path2.join(os2.homedir(), ".omnirush2api", "tokens.json");
}
async function loadStoredTokens(customPath) {
  const targetPath = customPath ?? getDefaultTokenStorePath();
  try {
    const raw = await fs2.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.tokens)) {
      return [...parsed.tokens];
    }
    return [];
  } catch {
    return [];
  }
}
async function saveStoredTokens(tokens, customPath) {
  const targetPath = customPath ?? getDefaultTokenStorePath();
  const dir = path2.dirname(targetPath);
  await fs2.mkdir(dir, { recursive: true, mode: 448 });
  const tempPath = `${targetPath}.tmp.${Date.now()}`;
  const payload = { tokens };
  const content = JSON.stringify(payload, null, 2);
  await fs2.writeFile(tempPath, content, { encoding: "utf8", mode: 384 });
  await fs2.rename(tempPath, targetPath);
}
async function addOrUpdateToken(entry, oldRefreshTokenOrPath, customPath) {
  let oldRefreshToken;
  let targetPath;
  if (customPath !== void 0) {
    oldRefreshToken = oldRefreshTokenOrPath;
    targetPath = customPath;
  } else if (oldRefreshTokenOrPath !== void 0) {
    if (oldRefreshTokenOrPath.endsWith(".json") || oldRefreshTokenOrPath.includes(path2.sep) || oldRefreshTokenOrPath.includes("/") || oldRefreshTokenOrPath.includes("\\")) {
      targetPath = oldRefreshTokenOrPath;
    } else {
      oldRefreshToken = oldRefreshTokenOrPath;
    }
  }
  const tokens = await loadStoredTokens(targetPath);
  const now = Date.now();
  const updatedEntry = {
    ...entry,
    gatewayUrl: entry.gatewayUrl || DEFAULT_GATEWAY_URL,
    updatedAt: now
  };
  const existingIndex = tokens.findIndex(
    (t) => t.refreshToken === entry.refreshToken || Boolean(oldRefreshToken) && t.refreshToken === oldRefreshToken
  );
  if (existingIndex >= 0) {
    tokens[existingIndex] = updatedEntry;
  } else {
    tokens.push(updatedEntry);
  }
  await saveStoredTokens(tokens, targetPath);
}
async function removeToken(refreshToken, customPath) {
  const tokens = await loadStoredTokens(customPath);
  const filtered = tokens.filter((t) => t.refreshToken !== refreshToken);
  if (filtered.length === tokens.length) {
    return false;
  }
  await saveStoredTokens(filtered, customPath);
  return true;
}

// src/cli/commands/start.ts
async function runStartCommand(options = {}) {
  const port = options.port ?? 20129;
  const host = options.host ?? "127.0.0.1";
  const apiKey = options.key || process.env["API_KEY"];
  const gatewayUrl = options.gatewayUrl || process.env["OMNIRUSH_GATEWAY_URL"] || DEFAULT_GATEWAY_URL;
  const pool = new AccountPoolManager(gatewayUrl, async (oldToken, account) => {
    try {
      await addOrUpdateToken(
        {
          refreshToken: account.refreshToken,
          accessToken: account.accessToken ?? void 0,
          gatewayUrl: account.gatewayUrl,
          email: account.email
        },
        oldToken
      );
      console.log(`[Omnirush2API RTR] Persisted rotated refresh token to disk (${account.email ?? account.id})`);
    } catch (err) {
      console.error(`[Omnirush2API RTR] Failed to persist rotated token:`, err);
    }
  });
  if (options.token) {
    pool.initFromTokenList(options.token);
  }
  const stored = await loadStoredTokens();
  for (const s of stored) {
    pool.addAccount(s.refreshToken, s.gatewayUrl, s.email, s.accessToken);
  }
  const discovered = await findLocalCredentials();
  for (const d of discovered) {
    pool.addAccount(d.refreshToken, d.gatewayUrl, d.email, d.accessToken);
  }
  const stats = pool.getStats();
  console.log("\n========================================================");
  console.log("   Omnirush2API - OpenAI Reverse Proxy & OAuth Router   ");
  console.log("========================================================\n");
  console.log(`\u2713 Listening:           http://${host}:${port}/v1`);
  console.log(`\u2713 Health Check:        http://${host}:${port}/health`);
  console.log(`\u2713 Upstream Gateway:    ${gatewayUrl}`);
  console.log(`\u2713 Authorization:       ${apiKey ? "Enabled (Bearer key enforced)" : "Open (No API key required)"}`);
  console.log(`\u2713 Configured Accounts: ${stats.total}`);
  if (stats.total === 0) {
    console.warn("\n\u26A0\uFE0F  No accounts currently loaded in pool!");
    console.warn("Run 'omnirush2api login' or set OMNIRUSH_REFRESH_TOKEN to authenticate.\n");
  } else {
    console.log("\u2713 Ready to proxy requests for Claude Code, Cursor, Codex, OpenCode, etc.\n");
  }
  const config = {
    port,
    host,
    apiKey,
    gatewayUrl
  };
  const runningServer = await startHttpServer(config, pool);
  const shutdown = async () => {
    console.log("\n[Omnirush2API] Shutting down server gracefully...");
    await runningServer.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// src/cli/commands/login.ts
import { exec } from "node:child_process";
function launchBrowser(url) {
  const platform = process.platform;
  let command = "";
  if (platform === "win32") {
    command = `start "" "${url}"`;
  } else if (platform === "darwin") {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  exec(command, () => {
  });
}
async function runLoginCommand(options = {}) {
  const gatewayUrl = options.gatewayUrl || DEFAULT_GATEWAY_URL;
  const shouldOpenBrowser = options.openBrowser ?? true;
  console.log("\n==================================================");
  console.log("       Omnirush2API - Device OAuth Login          ");
  console.log("==================================================\n");
  console.log(`[Omnirush2API] Connecting to gateway: ${gatewayUrl}`);
  try {
    const authSession = await initiateDeviceFlow({ gatewayUrl });
    console.log("\n1. Verification URL:\n");
    console.log(`   ${authSession.verification_uri_complete}
`);
    console.log(`2. User Verification Code: [ ${authSession.user_code} ]
`);
    if (shouldOpenBrowser) {
      console.log("-> Opening verification link in your default browser...");
      launchBrowser(authSession.verification_uri_complete);
    }
    console.log("\n3. Click 'Authorize' in your browser.");
    console.log(`Waiting for approval (expires in ${Math.round(authSession.expires_in / 60)} minutes)...`);
    const tokenResult = await pollDeviceToken(authSession.device_code, {
      gatewayUrl,
      intervalSeconds: authSession.interval || 5
    });
    if (!tokenResult.success || !tokenResult.refreshToken) {
      console.error(`
\u274C Authorization failed: ${tokenResult.error ?? "Unknown error"}`);
      process.exitCode = 1;
      return;
    }
    console.log("\n\u2713 Authorization approved by browser!\n");
    let email;
    let plan = "active";
    let remainingTokens;
    if (tokenResult.accessToken) {
      const profile = await fetchAccountProfile(tokenResult.accessToken, gatewayUrl);
      if (profile) {
        email = profile.email;
        plan = profile.status;
        remainingTokens = profile.usage?.remaining_tokens;
      }
    }
    await addOrUpdateToken({
      refreshToken: tokenResult.refreshToken,
      accessToken: tokenResult.accessToken,
      gatewayUrl,
      email
    });
    console.log("================================================================================");
    console.log("\u{1F389} Omnirush OAuth Login Successful!");
    console.log("================================================================================");
    console.log("\n[Option A: Cloudflare Worker Secret (Recommended Pair)]");
    console.log("Set OMNIRUSH_REFRESH_TOKEN to this pair to avoid cold start refresh invalidation:");
    console.log("--------------------------------------------------------------------------------");
    console.log(`${tokenResult.refreshToken}|${tokenResult.accessToken ?? ""}`);
    console.log("--------------------------------------------------------------------------------\n");
    console.log("[Option B: Separate Secrets / Local Daemon]");
    console.log(`\u2022 Refresh Token:  ${tokenResult.refreshToken}`);
    if (tokenResult.accessToken) {
      console.log(`\u2022 Access Token:   ${tokenResult.accessToken}`);
    }
    console.log("");
    if (email) console.log(`\u2713 Account:          ${email} (${plan})`);
    if (remainingTokens !== void 0) console.log(`\u2713 Tokens Remaining: ${remainingTokens.toLocaleString()}`);
    console.log("\u2713 Saved to Disk:    ~/.omnirush2api/tokens.json");
    console.log("\nNext Steps:");
    console.log("  \u2022 Local Daemon:       npm start  (auto-persists rotated tokens to disk)");
    console.log("  \u2022 Cloudflare Worker:  Paste Option A into OMNIRUSH_REFRESH_TOKEN secret");
    console.log("  \u2022 Worker KV Sync:     (Optional) Bind a KV namespace as TOKEN_KV for multi-region sync\n");
  } catch (err) {
    console.error(`
\u274C Error during login: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// src/cli/commands/check.ts
async function runCheckCommand(options = {}) {
  const gatewayUrl = options.gatewayUrl || DEFAULT_GATEWAY_URL;
  console.log("\n[Omnirush2API] Checking local OmniRush credentials and status...\n");
  const [discovered, stored] = await Promise.all([
    findLocalCredentials(),
    loadStoredTokens()
  ]);
  const tokenMap = /* @__PURE__ */ new Map();
  for (const item of discovered) {
    tokenMap.set(item.refreshToken, {
      source: item.source,
      gatewayUrl: item.gatewayUrl || gatewayUrl,
      email: item.email
    });
  }
  for (const item of stored) {
    if (!tokenMap.has(item.refreshToken)) {
      tokenMap.set(item.refreshToken, {
        source: "~/.omnirush2api/tokens.json",
        gatewayUrl: item.gatewayUrl || gatewayUrl,
        email: item.email
      });
    }
  }
  if (tokenMap.size === 0) {
    console.log("\u274C No OmniRush credentials detected.");
    console.log("\nTo authenticate:");
    console.log("  1. Run: omnirush2api login");
    console.log('  2. Or set: export OMNIRUSH_REFRESH_TOKEN="your_refresh_token"');
    console.log("  3. Or log into OmniRush Desktop app.\n");
    return;
  }
  console.log(`Found ${tokenMap.size} unique OmniRush credential(s):
`);
  let index = 1;
  for (const [refreshToken, meta] of tokenMap.entries()) {
    console.log(`--- [Account #${index}] ---`);
    console.log(`  Source: ${meta.source}`);
    console.log(`  Token:  ${refreshToken.slice(0, 12)}... (${refreshToken.length} chars)`);
    const refreshRes = await refreshDeviceToken(refreshToken, {
      gatewayUrl: meta.gatewayUrl
    });
    if (refreshRes.success && refreshRes.accessToken) {
      console.log("  Status: \u2713 Active & verified");
      const profile = await fetchAccountProfile(refreshRes.accessToken, meta.gatewayUrl);
      if (profile) {
        console.log(`  Email:  ${profile.email ?? "Unknown"}`);
        console.log(`  Plan:   ${profile.status}`);
        if (profile.usage) {
          const u = profile.usage;
          if (u.remaining_tokens !== void 0) {
            console.log(`  Tokens Remaining: ${u.remaining_tokens.toLocaleString()}`);
          }
          if (u.day?.used !== void 0) {
            console.log(`  Today's Used:     ${u.day.used.toLocaleString()}`);
          }
        }
      }
    } else {
      console.log(`  Status: \u274C Refresh failed (${refreshRes.error ?? "Invalid token"})`);
    }
    console.log("");
    index++;
  }
  console.log("Local authentication check complete.\n");
}

// src/cli/commands/tokens.ts
async function runTokensCommand(subcommand, arg) {
  const op = subcommand?.toLowerCase() ?? "list";
  if (op === "list") {
    const tokens = await loadStoredTokens();
    console.log(`
Stored Tokens in ~/.omnirush2api/tokens.json (${tokens.length}):
`);
    if (tokens.length === 0) {
      console.log("  (No stored tokens found. Run 'omnirush2api login' to add one.)\n");
      return;
    }
    tokens.forEach((t, i) => {
      console.log(`  [${i + 1}] Refresh Token:`);
      console.log(`      ${t.refreshToken}`);
      if (t.email) console.log(`      Email:         ${t.email}`);
      if (t.gatewayUrl) console.log(`      Gateway:       ${t.gatewayUrl}`);
      console.log("");
    });
    return;
  }
  if (op === "add") {
    if (!arg || arg.trim() === "") {
      console.error("\u274C Error: Missing refresh token argument. Usage: omnirush2api tokens add <token>");
      process.exitCode = 1;
      return;
    }
    await addOrUpdateToken({ refreshToken: arg.trim() });
    console.log("\u2713 Refresh token added to store.");
    return;
  }
  if (op === "remove") {
    if (!arg || arg.trim() === "") {
      console.error("\u274C Error: Missing refresh token argument. Usage: omnirush2api tokens remove <token>");
      process.exitCode = 1;
      return;
    }
    const removed = await removeToken(arg.trim());
    if (removed) {
      console.log("\u2713 Refresh token removed from store.");
    } else {
      console.log("\u26A0\uFE0F  Token not found in store.");
    }
    return;
  }
  console.error(`Unknown subcommand: ${op}. Available: list, add, remove`);
  process.exitCode = 1;
}

// src/cli/index.ts
var VERSION = "1.0.1";
function printHelp() {
  console.log(`
Omnirush2API v${VERSION}
OAuth to OpenAI-compatible API router for Omnirush.ai

Usage:
  omnirush2api <command> [options]

Commands:
  start               Start the local OpenAI-compatible API daemon (default)
  login               Initiate interactive terminal OAuth device flow
  check               Inspect and verify local credentials & quota status
  tokens              Manage stored refresh tokens (list, add, remove)

Options:
  -p, --port <number> Specify port for the HTTP daemon (default: 20129)
  -h, --host <host>   Specify host address (default: 127.0.0.1)
  -k, --key <string>  Set required Bearer API key for incoming requests
  --gateway-url <url> Override upstream OmniRush gateway URL
  --token <tokens>    Specify one or more refresh tokens (comma-separated)
  -v, --version       Display version information
  --help              Display this help message

Examples:
  omnirush2api login
  omnirush2api check
  omnirush2api start --port 20129 --key sk-my-secret-key
`);
}
function parseArgs(args) {
  let command = "start";
  const options = {};
  const extraArgs = [];
  const knownCommands = /* @__PURE__ */ new Set(["start", "login", "check", "tokens"]);
  let i = 0;
  if (args.length > 0 && args[0] && knownCommands.has(args[0])) {
    command = args[0];
    i = 1;
  }
  while (i < args.length) {
    const arg = args[i];
    if (!arg) {
      i++;
      continue;
    }
    if (arg === "-p" || arg === "--port") {
      options["port"] = parseInt(args[++i] ?? "20129", 10);
    } else if (arg === "-h" || arg === "--host") {
      options["host"] = args[++i];
    } else if (arg === "-k" || arg === "--key") {
      options["key"] = args[++i];
    } else if (arg === "--gateway-url") {
      options["gatewayUrl"] = args[++i];
    } else if (arg === "--token") {
      options["token"] = args[++i];
    } else if (arg === "-v" || arg === "--version") {
      options["version"] = true;
    } else if (arg === "--help") {
      options["help"] = true;
    } else {
      extraArgs.push(arg);
    }
    i++;
  }
  return { command, options, extraArgs };
}
async function main() {
  const rawArgs = process.argv.slice(2);
  const { command, options, extraArgs } = parseArgs(rawArgs);
  if (options.version) {
    console.log(`omnirush2api v${VERSION}`);
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }
  switch (command) {
    case "login":
      await runLoginCommand({ gatewayUrl: options.gatewayUrl });
      break;
    case "check":
      await runCheckCommand({ gatewayUrl: options.gatewayUrl });
      break;
    case "tokens":
      await runTokensCommand(extraArgs[0], extraArgs[1]);
      break;
    case "start":
    default:
      await runStartCommand(options);
      break;
  }
}
main().catch((err) => {
  console.error("[Omnirush2API] Fatal error:", err);
  process.exit(1);
});
//# sourceMappingURL=cli.js.map
