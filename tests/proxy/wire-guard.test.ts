import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectAccountBan,
  createAntiBanHeaders,
  createAuthApiHeaders,
  generateRealisticDeviceName,
  detectPlatformSignature,
} from "../../src/proxy/wire-guard.js";
import { AccountPoolManager } from "../../src/auth/pool-manager.js";
import { CompletionProxyHandler } from "../../src/proxy/completion-handler.js";

describe("anti-ban wire guard & ban protection", () => {
  it("detects account ban and suspension from upstream responses", () => {
    const banNotice =
      "Your OmniRush account was closed automatically because its sign-in was used from another place at the same time or through an unofficial client, which our Terms of Service don't allow. If you think this is a mistake, email info@omnirush.ai and a person will review it.";

    const res1 = detectAccountBan(403, banNotice);
    assert.equal(res1.isBanned, true);
    assert.ok(res1.reason?.includes("closed automatically") || res1.reason?.includes("unofficial client"));

    const res2 = detectAccountBan(401, '{"error":"Your account has been suspended for terms of service violation"}');
    assert.equal(res2.isBanned, true);

    const res3 = detectAccountBan(429, '{"error":"Rate limit reached. Try again in 60s."}');
    assert.equal(res3.isBanned, false);

    const res4 = detectAccountBan(200, '{"id":"chatcmpl-123"}');
    assert.equal(res4.isBanned, false);
  });

  it("generates anti-ban official client headers with zero unofficial client leaks", () => {
    const headers = createAntiBanHeaders({
      accessToken: "mock_acc_token",
      requestId: "sess-123",
      isStream: true,
    });

    // Zero unofficial leaks
    for (const [key, val] of Object.entries(headers)) {
      assert.ok(!key.toLowerCase().includes("omnirush2api"), `Header key leaked unofficial name: ${key}`);
      assert.ok(!val.toLowerCase().includes("omnirush2api"), `Header value leaked unofficial name: ${val}`);
    }

    // Required official client signatures (matching omnirush@2.4.3 token-proxy.js)
    assert.equal(headers["User-Agent"], "omnirush");
    assert.equal(headers["X-OmniRush-Client"], "cli/2.7.0");
    assert.match(headers["x-omnirush-session-id"] ?? "", /^ses_/);
    assert.equal(headers["Authorization"], "Bearer mock_acc_token");
    assert.equal(headers["Accept"], "text/event-stream");

    // Test official auth API headers
    const authHeaders = createAuthApiHeaders();
    assert.ok(authHeaders["User-Agent"]?.startsWith("omnirush/2.7.0 ("));
    assert.equal(authHeaders["X-OmniRush-Client"], "cli/2.7.0");
  });

  it("generates realistic device names and platform signatures", () => {
    const deviceName = generateRealisticDeviceName();
    assert.ok(deviceName.startsWith("DESKTOP-") || deviceName.startsWith("MacBook-"));
    assert.ok(!deviceName.toLowerCase().includes("tunnel"));
    assert.ok(!deviceName.toLowerCase().includes("omnirush2api"));

    const platform = detectPlatformSignature();
    assert.ok(["win32", "darwin", "linux"].includes(platform));
  });

  it("quarantines banned account permanently in AccountPoolManager", async () => {
    const pool = new AccountPoolManager();
    pool.addAccount("tok_ban_1");
    pool.addAccount("tok_safe_2");

    // Put tok_ban_1 in ban quarantine
    pool.markBanned("account-1", "Account closed automatically");

    const stats = pool.getStats();
    assert.equal(stats.total, 2);
    assert.equal(stats.banned, 1);
    assert.equal(stats.active, 1);

    // Mock fetch for token refresh
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({ access_token: `acc_${body.refresh_token}` }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      // Next account must NEVER be tok_ban_1
      const a1 = await pool.getNextAvailableAccount();
      assert.equal(a1?.refreshToken, "tok_safe_2");

      const a2 = await pool.getNextAvailableAccount();
      assert.equal(a2?.refreshToken, "tok_safe_2");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("proxy handler captures ban response, quarantines account, and fails over safely", async () => {
    const pool = new AccountPoolManager();
    pool.addAccount("banned_tok", "https://omnirush.ai/omnirush/v1", "banned@test.com", "banned_acc");
    pool.addAccount("good_tok", "https://omnirush.ai/omnirush/v1", "good@test.com", "good_acc");

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (_url, init) => {
        const auth = (init?.headers as Record<string, string>)?.["Authorization"];
        if (auth === "Bearer banned_acc") {
          return new Response(
            "Your OmniRush account was closed automatically because its sign-in was used from another place at the same time or through an unofficial client, which our Terms of Service don't allow.",
            { status: 403, headers: { "Content-Type": "text/plain" } }
          );
        }
        return new Response(
          JSON.stringify({
            id: "resp_ok",
            choices: [{ message: { role: "assistant", content: "Safe response" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const handler = new CompletionProxyHandler({ pool });
      const result = await handler.handleCompletion({
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "Hello" }],
      });

      assert.equal(result.status, 200);
      assert.equal(result.jsonResponse?.choices[0]?.message.content, "Safe response");

      // Verify that banned account was permanently marked
      const stats = pool.getStats();
      assert.equal(stats.banned, 1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
