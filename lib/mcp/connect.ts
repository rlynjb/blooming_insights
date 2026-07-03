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

/** ConnectResult.mcp is the concrete BloomreachDataSource (not just
 *  `DataSource`) so the 4 short MCP routes — /api/mcp/{call,tools,tools/check,capture}
 *  — keep access to Bloomreach-specific cache controls (skipCache). Agent + route
 *  layers that only need the abstract surface narrow to `DataSource` at their
 *  receive site (bootstrapSchema, agent ctors, etc.). */
export type ConnectResult =
  | { ok: true; mcp: BloomreachDataSource }
  | { ok: false; authUrl: string };

function mcpUrl(): URL {
  // Prefer generic MCP_URL; fall back to BLOOMREACH_MCP_URL for backward
  // compat with pre-swappable configs. Final default is the Bloomreach alpha
  // endpoint so an unset env still yields a working example config out of the
  // box (Bloomreach as the "default preset").
  const raw =
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
 */
export async function connectMcp(sessionId: string): Promise<ConnectResult> {
  // In production the auth store is the encrypted cookie; withAuthCookies seeds
  // it from the request once and flushes it once (see lib/mcp/auth.ts). In
  // dev/test it's a passthrough.
  return withAuthCookies(() => connectMcpInner(sessionId));
}

async function connectMcpInner(sessionId: string): Promise<ConnectResult> {
  const provider = await buildAuthProvider(sessionId);
  // Capture the raw body of any non-OK HTTP response so tool failures can report
  // the real server error (e.g. the `invalid_token` JSON behind a 401).
  const httpErrors: HttpErrorHolder = { last: null };
  const transport = new StreamableHTTPClientTransport(mcpUrl(), {
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

/** Build an AuthProvider for a session per env-configured MCP_AUTH_TYPE.
 *  Default is oauth-bloomreach for backward compat. */
async function buildAuthProvider(sessionId: string): Promise<OAuthClientProvider> {
  const env = readAuthEnv();
  return makeAuthProvider({
    type: env.type,
    sessionId,
    redirectUri: env.type === 'oauth-bloomreach' ? await redirectUri() : undefined,
    bearerToken: env.bearerToken,
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
