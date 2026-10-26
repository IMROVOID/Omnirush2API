import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../types/openai.js";
import { resolveModelId } from "./model-catalog.js";
import { AccountPoolManager, parseCooldownDuration } from "../auth/pool-manager.js";
import { normalizeCompletionRequest, normalizeCompletionResponse } from "./normalizer.js";
import { aggregateResponsesSSE, createSSETransformStream } from "./stream-transformer.js";
import { DEFAULT_GATEWAY_URL } from "../auth/oauth-client.js";
import { createAntiBanHeaders, detectAccountBan } from "./wire-guard.js";

function generateRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export interface ProxyHandlerOptions {
  readonly pool: AccountPoolManager;
  readonly upstreamBaseUrl?: string | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

export interface ProxyResult {
  readonly status: number;
  readonly isStream: boolean;
  readonly jsonResponse?: ChatCompletionResponse | undefined;
  readonly streamResponse?: ReadableStream<Uint8Array> | undefined;
  readonly errorResponse?: Record<string, unknown> | undefined;
}

export class CompletionProxyHandler {
  private pool: AccountPoolManager;
  private upstreamBaseUrl: string;
  private requestTimeoutMs: number;

  constructor(options: ProxyHandlerOptions) {
    this.pool = options.pool;
    this.upstreamBaseUrl = options.upstreamBaseUrl ?? DEFAULT_GATEWAY_URL;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  public async handleCompletion(
    request: ChatCompletionRequest,
    signal?: AbortSignal | undefined
  ): Promise<ProxyResult> {
    if (signal?.aborted) {
      return {
        status: 499,
        isStream: false,
        errorResponse: {
          error: { message: "Client cancelled request.", type: "client_closed_request" },
        },
      };
    }

    const targetModel = resolveModelId(request.model);
    const normalizedPayload = normalizeCompletionRequest(request);
    const isStream = request.stream === true;
    // A 401 can mean the access token in a long-running daemon is stale. Give
    // a single-account pool a second pass so AccountPoolManager can rotate the
    // device token instead of returning a misleading 502 immediately.
    const maxAttempts = Math.max(2, this.pool.getStats().total);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) {
        return {
          status: 499,
          isStream: false,
          errorResponse: {
            error: { message: "Client cancelled request.", type: "client_closed_request" },
          },
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
                message:
                  "OmniRush account was closed or suspended by upstream (unofficial client / multi-session detection). Account quarantined.",
                type: "account_suspended_error",
                code: "account_banned_by_upstream",
              },
            },
          };
        }

        return {
          status: 429,
          isStream: false,
          errorResponse: {
            error: {
              message: "All OmniRush accounts in pool are currently in cooldown or unavailable.",
              type: "rate_limit_error",
              code: "all_accounts_cooling_down",
            },
          },
        };
      }

      const requestId = generateRequestId();
      const gatewayUrl = (account.gatewayUrl || this.upstreamBaseUrl).replace(/\/+$/, "");

      const headers = createAntiBanHeaders({
        accessToken: account.accessToken ?? "",
        requestId,
        // The OmniRush Responses gateway currently requires stream=true for
        // every model request. We aggregate it below for non-stream callers.
        isStream: true,
      });

      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      try {
        const response = await this.pool.withAccountLock(account.id, async () => {
          return await fetch(`${gatewayUrl}/responses`, {
            method: "POST",
            headers,
            body: JSON.stringify(normalizedPayload),
            signal: combinedSignal,
          });
        });

        // Handle streaming response if successful
        if (isStream && response.ok && response.body) {
          const transformedStream = response.body.pipeThrough(
            createSSETransformStream(targetModel)
          );
          return {
            status: 200,
            isStream: true,
            streamResponse: transformedStream,
          };
        }

        // Read response body for status checks and error parsing
        const responseText = await response.text();

        // 1. Check for Account Ban / Suspension (e.g. 403 / 401 with closure notice)
        const banCheck = detectAccountBan(response.status, responseText);
        if (banCheck.isBanned) {
          this.pool.markBanned(account.id, banCheck.reason);
          continue;
        }

        // 2. 401 Unauthorized: token might be revoked or expired
        if (response.status === 401) {
          this.pool.invalidateAccountToken(account.id);
          this.pool.markCooldown(account.id, 0, "HTTP 401 Unauthorized; refreshing access token");
          continue;
        }

        // 3. 429 Rate Limit / Quota Exceeded
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const cooldownMs = parseCooldownDuration(retryAfter, responseText);
          this.pool.markCooldown(account.id, cooldownMs, `HTTP 429: ${responseText.slice(0, 100)}`);
          continue;
        }

        // Handle non-streaming response
        let parsedJson: unknown = {};
        try {
          parsedJson = response.headers.get("content-type")?.includes("text/event-stream")
            ? aggregateResponsesSSE(responseText, targetModel)
            : JSON.parse(responseText);
        } catch {
          return {
            status: response.status,
            isStream: false,
            errorResponse: {
              error: {
                message: `Invalid JSON from OmniRush gateway: ${responseText.slice(0, 200)}`,
                type: "gateway_error",
              },
            },
          };
        }

        if (response.ok) {
          return {
            status: 200,
            isStream: false,
            jsonResponse: normalizeCompletionResponse(parsedJson, targetModel),
          };
        }

        // Other upstream error (e.g. 400 Bad Request, 500)
        return {
          status: response.status,
          isStream: false,
          errorResponse: (parsedJson as Record<string, unknown>) ?? {
            error: { message: `Gateway error (${response.status})`, type: "gateway_error" },
          },
        };
      } catch (err) {
        console.error(`[Omnirush2API] upstream request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (signal?.aborted) {
          return {
            status: 499,
            isStream: false,
            errorResponse: {
              error: { message: "Client cancelled request.", type: "client_closed_request" },
            },
          };
        }

        // Network failure or timeout on this account, place on short cooldown and retry next
        this.pool.markCooldown(
          account.id,
          30_000,
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
          type: "bad_gateway",
        },
      },
    };
  }
}
