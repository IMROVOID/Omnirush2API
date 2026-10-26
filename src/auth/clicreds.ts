import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { DiscoveredCredential } from "../types/auth.js";
import { DEFAULT_GATEWAY_URL } from "./oauth-client.js";

function normalizeGatewayUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * Parses raw text contents of an OmniRush credential file
 */
export function parseCredentialFileContent(
  content: string,
  sourcePath: string
): DiscoveredCredential | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;

    // Support both snake_case and camelCase
    const refreshToken =
      (typeof json["refresh_token"] === "string" ? json["refresh_token"] : null) ??
      (typeof json["refreshToken"] === "string" ? json["refreshToken"] : null);

    if (!refreshToken || refreshToken.trim() === "") {
      return null;
    }

    const accessToken =
      (typeof json["access_token"] === "string" ? json["access_token"] : null) ??
      (typeof json["accessToken"] === "string" ? json["accessToken"] : null) ??
      undefined;

    const gatewayUrl =
      (typeof json["gateway_url"] === "string" ? json["gateway_url"] : null) ??
      (typeof json["gatewayUrl"] === "string" ? json["gatewayUrl"] : null) ??
      undefined;

    const email = typeof json["email"] === "string" ? json["email"] : undefined;

    return {
      source: `file:${sourcePath}`,
      path: sourcePath,
      refreshToken: refreshToken.trim(),
      accessToken: accessToken?.trim(),
      gatewayUrl: normalizeGatewayUrl(gatewayUrl),
      email: email?.trim(),
    };
  } catch {
    // If not valid JSON, check if it's a plain token string
    if (trimmed.startsWith("omni_ref_") || trimmed.length >= 32) {
      return {
        source: `file:${sourcePath}`,
        path: sourcePath,
        refreshToken: trimmed,
      };
    }
    return null;
  }
}

/**
 * Returns candidate system paths where OmniRush Desktop stores credentials
 */
export function getStandardCredentialPaths(): string[] {
  const home = os.homedir();
  const platform = process.platform;
  const paths: string[] = [];

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
    // Linux / other Unix
    const configHome = process.env["XDG_CONFIG_HOME"] || path.join(home, ".config");
    paths.push(
      path.join(configHome, "OmniRush", "credentials"),
      path.join(configHome, "OmniRush", "credentials.fallback")
    );
  }

  // Also check ~/.omnirush2api/tokens.json
  paths.push(path.join(home, ".omnirush2api", "tokens.json"));

  // The official OmniRush CLI stores the signed-in device pair here. Supporting
  // this file lets the router reuse an existing `omnirush login` session without
  // asking the user to copy refresh tokens into another config file.
  paths.push(path.join(home, ".omnirush", "auth.json"));

  return paths;
}

export interface FindCredentialsOptions {
  readonly extraPaths?: readonly string[] | undefined;
}

/**
 * Scans environment variables and local disk paths for OmniRush credentials
 */
export async function findLocalCredentials(
  options: FindCredentialsOptions = {}
): Promise<DiscoveredCredential[]> {
  const discovered: DiscoveredCredential[] = [];
  const seenTokens = new Set<string>();

  // 1. Check environment variables
  const envRefreshToken = process.env["OMNIRUSH_REFRESH_TOKEN"]?.trim();
  if (envRefreshToken) {
    let tokens: string[] = [];
    if (envRefreshToken.startsWith("[") && envRefreshToken.endsWith("]")) {
      try {
        const parsed = JSON.parse(envRefreshToken) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const tok =
              typeof item === "string"
                ? item.trim()
                : item && typeof item === "object"
                  ? (item as Record<string, unknown>)["refreshToken"] ||
                    (item as Record<string, unknown>)["refresh_token"]
                  : null;
            if (typeof tok === "string" && tok.trim()) {
              tokens.push(tok.trim());
            }
          }
        }
      } catch {
        // Fall back to delimiter splitting
      }
    }

    if (tokens.length === 0) {
      tokens = envRefreshToken
        .split(/[\r\n,]+/)
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }

    for (const tok of tokens) {
      if (!seenTokens.has(tok)) {
        seenTokens.add(tok);
        discovered.push({
          source: "env:OMNIRUSH_REFRESH_TOKEN",
          refreshToken: tok,
          accessToken: process.env["OMNIRUSH_ACCESS_TOKEN"]?.trim(),
          gatewayUrl: process.env["OMNIRUSH_GATEWAY_URL"]?.trim() || DEFAULT_GATEWAY_URL,
        });
      }
    }
  }

  // 2. Check disk paths
  const candidatePaths = [...getStandardCredentialPaths(), ...(options.extraPaths ?? [])];
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
      // File doesn't exist or is not readable, continue
    }
  }

  return discovered;
}
