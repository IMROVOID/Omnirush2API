import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { findLocalCredentials, parseCredentialFileContent } from "../../src/auth/clicreds.js";

describe("clicreds", () => {
  it("parses valid JSON credential content with snake_case keys", () => {
    const raw = JSON.stringify({
      refresh_token: "tok_refresh_123",
      access_token: "tok_access_123",
      gateway_url: "https://omnirush.ai/omnirush/v1",
      email: "user@example.com",
    });

    const parsed = parseCredentialFileContent(raw, "mock-path");
    assert.ok(parsed);
    assert.equal(parsed.refreshToken, "tok_refresh_123");
    assert.equal(parsed.accessToken, "tok_access_123");
    assert.equal(parsed.gatewayUrl, "https://omnirush.ai/omnirush/v1");
    assert.equal(parsed.email, "user@example.com");
  });

  it("parses valid JSON credential content with camelCase keys", () => {
    const raw = JSON.stringify({
      refreshToken: "tok_refresh_camel",
      accessToken: "tok_access_camel",
    });

    const parsed = parseCredentialFileContent(raw, "mock-path");
    assert.ok(parsed);
    assert.equal(parsed.refreshToken, "tok_refresh_camel");
    assert.equal(parsed.accessToken, "tok_access_camel");
  });

  it("extracts credentials from environment variables", async () => {
    const originalEnv = process.env["OMNIRUSH_REFRESH_TOKEN"];
    try {
      process.env["OMNIRUSH_REFRESH_TOKEN"] = "env_refresh_xyz";
      const creds = await findLocalCredentials();
      const envCred = creds.find((c) => c.source === "env:OMNIRUSH_REFRESH_TOKEN");
      assert.ok(envCred);
      assert.equal(envCred.refreshToken, "env_refresh_xyz");
    } finally {
      if (originalEnv !== undefined) {
        process.env["OMNIRUSH_REFRESH_TOKEN"] = originalEnv;
      } else {
        delete process.env["OMNIRUSH_REFRESH_TOKEN"];
      }
    }
  });

  it("reads credential file from custom path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omnirush-test-"));
    const filePath = path.join(tmpDir, "test-creds.json");
    try {
      await fs.writeFile(
        filePath,
        JSON.stringify({
          refresh_token: "file_refresh_456",
          email: "test@omnirush.ai",
        }),
        "utf8"
      );

      const creds = await findLocalCredentials({ extraPaths: [filePath] });
      const found = creds.find((c) => c.refreshToken === "file_refresh_456");
      assert.ok(found);
      assert.equal(found.email, "test@omnirush.ai");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses the official OmniRush CLI auth.json shape", () => {
    const parsed = parseCredentialFileContent(
      JSON.stringify({
        accessToken: "omnirush-access",
        refreshToken: "omnirush-refresh",
        gatewayUrl: "https://omnirush.ai/omnirush",
      }),
      "/home/test/.omnirush/auth.json"
    );

    assert.ok(parsed);
    assert.equal(parsed.refreshToken, "omnirush-refresh");
    assert.equal(parsed.accessToken, "omnirush-access");
    assert.equal(parsed.gatewayUrl, "https://omnirush.ai/omnirush/v1");
  });
});
