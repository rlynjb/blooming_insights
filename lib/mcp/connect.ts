// LIVE-VERIFICATION REQUIRED — this OAuth flow is written against the documented
// SDK behavior (StreamableHTTPClientTransport + OAuthClientProvider, v1.29.0) but
// has NOT been run against live Bloomreach auth. Points to verify:
//   (a) connect() throws (UnauthorizedError) after redirectToAuthorization rather
//       than hanging, so we can surface the captured authorize URL.
//   (b) Dynamic Client Registration (RFC 7591) succeeds from a server context
//       (no pre-registered client_id / client_secret; public client, auth method
//       "none").
//   (c) finishAuth reads the per-session PKCE verifier saved during connect and
//       exchanges the code for tokens successfully.
//   (d) In-memory persistence (auth.ts authStore) works ONLY within a single Node
//       process. Vercel's ephemeral functions may lose the PKCE verifier / client
//       info between the connect request and the callback request; a shared store
//       (KV/Redis) is the likely production fix.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SdkTransport } from './transport';
import { McpClient } from './client';
import { BloomreachAuthProvider } from './auth';

export type ConnectResult =
  | { ok: true; mcp: McpClient }
  | { ok: false; authUrl: string };

function mcpUrl(): URL {
  const raw =
    process.env.BLOOMREACH_MCP_URL ?? 'https://loomi-mcp-alpha.bloomreach.com/mcp/';
  return new URL(raw.replace(/\/+$/, '')); // strip trailing slash(es) — avoids a 307
}

function redirectUri(): string {
  return `${process.env.APP_ORIGIN ?? 'http://localhost:3000'}/api/mcp/callback`;
}

/**
 * Connect for a session. If the session has valid tokens, returns a ready McpClient.
 * If not, the SDK's auth flow captures an authorize URL via the provider, which we
 * return so the caller can redirect the browser.
 */
export async function connectMcp(sessionId: string): Promise<ConnectResult> {
  const provider = new BloomreachAuthProvider(sessionId, redirectUri());
  const transport = new StreamableHTTPClientTransport(mcpUrl(), {
    authProvider: provider,
  });
  const client = new Client(
    { name: 'blooming-insights', version: '0.1.0' },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    // Bloomreach rate-limits per user GLOBALLY and states the window in the
    // error text — observed as both "(1 per 1 second)" and "(1 per 10 second)".
    // Proactive spacing stays at ~1.1s on purpose: spacing at the full 10s
    // window would cost ~60s for a 6-call investigation and blow the route's
    // 60s budget (app/api/agent). Instead, McpClient parses the stated window
    // from each 429 and waits it out on retry (see retryDelayMs/retryCeilingMs),
    // and the 60s response cache absorbs repeats. retryDelayMs falls back to the
    // observed 10s window when no hint is parseable.
    return {
      ok: true,
      mcp: new McpClient(new SdkTransport(client), {
        minIntervalMs: 1100,
        retryDelayMs: 10_000,
        retryCeilingMs: 20_000,
        maxRetries: 3,
      }),
    };
  } catch (err) {
    // The SDK throws (UnauthorizedError) after calling redirectToAuthorization when
    // no valid token exists. If we captured an authorize URL, surface it for the
    // browser instead of bubbling the error.
    if (provider.lastAuthorizeUrl) {
      return { ok: false, authUrl: provider.lastAuthorizeUrl.toString() };
    }
    throw err;
  }
}

/**
 * Complete the OAuth code exchange in the callback. Reconstructs the provider for the
 * same session (so it reads the PKCE verifier + client info persisted during connect),
 * then finishes auth, which persists tokens via the provider's saveTokens.
 */
export async function completeAuth(sessionId: string, code: string): Promise<void> {
  const provider = new BloomreachAuthProvider(sessionId, redirectUri());
  const transport = new StreamableHTTPClientTransport(mcpUrl(), {
    authProvider: provider,
  });
  await transport.finishAuth(code);
}
