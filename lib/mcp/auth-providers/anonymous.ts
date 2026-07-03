// lib/mcp/auth-providers/anonymous.ts
//
// No-auth AuthProvider — for MCP servers that do not require authentication
// (local dev tools, public MCP servers, in-cluster deployments). The MCP SDK's
// `OAuthClientProvider` interface is the auth surface; returning `undefined`
// tokens tells the transport to send no Authorization header.
//
// All persistence-related methods are no-ops. The OAuth flow methods
// (redirectToAuthorization, codeVerifier, etc.) throw if ever called — an
// anonymous provider should never enter an OAuth flow.

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export class AnonymousAuthProvider implements OAuthClientProvider {
  get redirectUrl(): string {
    return '';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'blooming insights (anonymous)',
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
    return undefined; // no Authorization header will be sent
  }

  saveTokens(): void {
    /* no-op */
  }

  redirectToAuthorization(): void {
    throw new Error(
      'AnonymousAuthProvider: redirectToAuthorization called — this provider is for MCP servers that do not require authentication. If the server returns 401, change MCP_AUTH_TYPE.',
    );
  }

  saveCodeVerifier(): void {
    /* no-op */
  }

  codeVerifier(): string {
    throw new Error(
      'AnonymousAuthProvider: codeVerifier called — no OAuth flow is ever expected for this provider.',
    );
  }
}
