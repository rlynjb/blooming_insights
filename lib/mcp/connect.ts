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
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { SdkTransport, makeCapturingFetch, type HttpErrorHolder } from './transport';
import { BloomreachDataSource } from '../data-source/bloomreach-data-source';
import { withAuthCookies } from './auth';
import {
  makeAuthProvider,
  readAuthEnv,
  BloomreachAuthProvider,
  type McpAuthType,
} from './auth-providers';
import type { McpConfigOverride } from './config';

/** ConnectResult.mcp is the concrete BloomreachDataSource (not just
 *  `DataSource`) so the 4 short MCP routes — /api/mcp/{call,tools,tools/check,capture}
 *  — keep access to Bloomreach-specific cache controls (skipCache). Agent + route
 *  layers that only need the abstract surface narrow to `DataSource` at their
 *  receive site (bootstrapSchema, agent ctors, etc.). */
export type ConnectResult =
  | { ok: true; mcp: BloomreachDataSource }
  | { ok: false; authUrl: string };

function mcpUrl(override?: McpConfigOverride): URL {
  // Precedence: override.url (from UI settings modal, per-request header) →
  // MCP_URL env → BLOOMREACH_MCP_URL env (legacy) → Bloomreach alpha default.
  // Unset env still yields a working example config out of the box.
  const raw =
    override?.url ??
    process.env.MCP_URL ??
    process.env.BLOOMREACH_MCP_URL ??
    'https://loomi-mcp-alpha.bloomreach.com/mcp/';
  return new URL(raw.replace(/\/+$/, '')); // strip trailing slash(es) — avoids a 307
}

async function redirectUri(): Promise<string> {
  // In production, derive the redirect from the ACTUAL request host so the OAuth
  // callback returns to the same origin that set the session cookie — preview
  // deployments and the production alias both work (DCR registers each host's
  // redirect URI on the fly). Without this, opening a per-deploy URL while the
  // callback goes to APP_ORIGIN drops the cookie → "no session". Locally we use
  // APP_ORIGIN (http://localhost), since there's no forwarded host.
  if (process.env.NODE_ENV === 'production') {
    try {
      const { headers } = await import('next/headers');
      const h = await headers();
      const host = h.get('x-forwarded-host') ?? h.get('host');
      if (host) {
        const proto = h.get('x-forwarded-proto') ?? 'https';
        return `${proto}://${host}/api/mcp/callback`;
      }
    } catch {
      /* not in a request scope — fall through to APP_ORIGIN */
    }
  }
  return `${process.env.APP_ORIGIN ?? 'http://localhost:3000'}/api/mcp/callback`;
}

/**
 * Connect for a session. If the session has valid tokens, returns a ready
 * BloomreachDataSource. If not, the SDK's auth flow captures an authorize URL
 * via the provider, which we return so the caller can redirect the browser.
 *
 * `override` is an optional per-request MCP config from the UI settings modal
 * (see lib/mcp/config.ts). When set, it takes precedence over env vars; when
 * null/undefined, env-driven behavior is preserved exactly.
 */
export async function connectMcp(
  sessionId: string,
  override?: McpConfigOverride | null,
): Promise<ConnectResult> {
  // In production the auth store is the encrypted cookie; withAuthCookies seeds
  // it from the request once and flushes it once (see lib/mcp/auth.ts). In
  // dev/test it's a passthrough.
  return withAuthCookies(() => connectMcpInner(sessionId, override ?? undefined));
}

async function connectMcpInner(
  sessionId: string,
  override?: McpConfigOverride,
): Promise<ConnectResult> {
  const provider = await buildAuthProvider(sessionId, override);
  // Capture the raw body of any non-OK HTTP response so tool failures can report
  // the real server error (e.g. the `invalid_token` JSON behind a 401).
  const httpErrors: HttpErrorHolder = { last: null };
  const transport = new StreamableHTTPClientTransport(mcpUrl(override), {
    authProvider: provider,
    fetch: makeCapturingFetch(httpErrors),
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
    // 60s budget (app/api/agent). Instead, BloomreachDataSource parses the stated
    // window from each 429 and waits it out on retry (see retryDelayMs/retryCeilingMs),
    // and the 60s response cache absorbs repeats. retryDelayMs falls back to the
    // observed 10s window when no hint is parseable.
    return {
      ok: true,
      mcp: new BloomreachDataSource(new SdkTransport(client, httpErrors), {
        minIntervalMs: 1100,
        retryDelayMs: 10_000,
        retryCeilingMs: 20_000,
        maxRetries: 3,
      }),
    };
  } catch (err) {
    // The SDK throws (UnauthorizedError) after calling redirectToAuthorization when
    // no valid token exists. Only OAuth providers capture an authorize URL;
    // bearer/anonymous providers throw on OAuth entry (correctly — they should
    // never end up here).
    if (
      provider instanceof BloomreachAuthProvider &&
      provider.lastAuthorizeUrl
    ) {
      return { ok: false, authUrl: provider.lastAuthorizeUrl.toString() };
    }
    throw err;
  }
}

/** Build an AuthProvider for a session. Per-request override (from the UI
 *  settings modal) wins over env config. Default is oauth-bloomreach.
 *
 *  When a bearer override is set but the token is missing, we throw a clear
 *  error — the modal validation should have caught this, but the server-side
 *  guard keeps a malformed request from reaching the SDK's OAuth machinery. */
async function buildAuthProvider(
  sessionId: string,
  override?: McpConfigOverride,
): Promise<OAuthClientProvider> {
  const env = readAuthEnv();
  const type: McpAuthType = override?.authType ?? env.type;
  const bearerToken =
    type === 'bearer' ? (override?.bearerToken ?? env.bearerToken) : undefined;
  if (type === 'bearer' && !bearerToken) {
    throw new Error(
      'bearer auth type selected but no token provided — set one in Settings or via MCP_AUTH_TOKEN env.',
    );
  }
  return makeAuthProvider({
    type,
    sessionId,
    redirectUri: type === 'oauth-bloomreach' ? await redirectUri() : undefined,
    bearerToken,
  });
}

/**
 * Complete the OAuth code exchange in the callback. Reconstructs the provider for the
 * same session (so it reads the PKCE verifier + client info persisted during connect),
 * then finishes auth, which persists tokens via the provider's saveTokens.
 *
 * The OAuth callback only makes sense for the oauth-bloomreach provider —
 * bearer and anonymous providers don't have an OAuth flow, so if the callback
 * fires against those, something is wrong upstream. Guarded here.
 */
export async function completeAuth(sessionId: string, code: string): Promise<void> {
  const env = readAuthEnv();
  if (env.type !== 'oauth-bloomreach') {
    throw new Error(
      `OAuth callback fired but MCP_AUTH_TYPE=${env.type} — the callback route is only reachable for oauth-bloomreach.`,
    );
  }
  await withAuthCookies(async () => {
    const provider = new BloomreachAuthProvider(sessionId, await redirectUri());
    const transport = new StreamableHTTPClientTransport(mcpUrl(), {
      authProvider: provider,
    });
    await transport.finishAuth(code);
  });
}
