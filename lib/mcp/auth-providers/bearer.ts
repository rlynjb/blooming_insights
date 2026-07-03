// lib/mcp/auth-providers/bearer.ts
//
// Static bearer-token AuthProvider — for MCP servers that expect a
// pre-issued token in the Authorization header (personal access tokens,
// API keys, service tokens). The MCP SDK's `OAuthClientProvider` interface
// is the auth surface; returning `{ access_token: TOKEN }` from `tokens()`
// tells the transport to send `Authorization: Bearer <token>`.
//
// The token is passed in at construction time. In production it should
// come from a server-side secret (env var or short-lived per-request
// encrypted cookie — see UI settings integration in Phase 5). Persistence
// methods are no-ops because there's no OAuth flow to persist between.
//
// Security note: bearer tokens are less protected than OAuth 2.1 flows.
// The consuming server sees them plaintext, they don't rotate on their
// own, and they can't be revoked from this side. Use for testing and
// internal tooling; avoid pasting production credentials.

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export class BearerAuthProvider implements OAuthClientProvider {
  constructor(private readonly token: string) {
    if (!token) {
      throw new Error('BearerAuthProvider requires a non-empty token.');
    }
  }

  get redirectUrl(): string {
    return '';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'blooming insights (bearer)',
      redirect_uris: [],
      grant_types: [],
      response_types: [],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    return '';
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return undefined;
  }

  saveClientInformation(): void {
    /* no-op */
  }

  tokens(): OAuthTokens | undefined {
    // Return a minimal-shape OAuthTokens with just the access_token; the
    // SDK reads this and sends `Authorization: Bearer <access_token>`.
    // token_type omitted; the SDK defaults to Bearer.
    return {
      access_token: this.token,
      token_type: 'Bearer',
    };
  }

  saveTokens(): void {
    /* no-op — the token was passed in; nothing to persist */
  }

  redirectToAuthorization(): void {
    throw new Error(
      'BearerAuthProvider: redirectToAuthorization called — a bearer-token provider is expected to have a valid token from the start. If the server returned 401, either the token is invalid or the MCP server expects a real OAuth flow (change MCP_AUTH_TYPE to oauth-bloomreach).',
    );
  }

  saveCodeVerifier(): void {
    /* no-op */
  }

  codeVerifier(): string {
    throw new Error(
      'BearerAuthProvider: codeVerifier called — no OAuth flow is expected for this provider.',
    );
  }
}
