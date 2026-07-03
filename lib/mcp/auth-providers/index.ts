// lib/mcp/auth-providers/index.ts
//
// AuthProvider factory — picks a concrete `OAuthClientProvider` implementation
// for the current MCP config. Reads env vars for the defaults; a per-request
// UI-config override lives in a later phase (see synthetic-first-mcp-abstraction
// plan, Phase 5). Session B ships only the env-driven surface.
//
// Env vars:
//   MCP_AUTH_TYPE     'oauth-bloomreach' | 'bearer' | 'anonymous'
//                      Default: 'oauth-bloomreach' (backward compat with the
//                      pre-swappable state where Bloomreach was baked in.)
//   MCP_AUTH_TOKEN    Used only when MCP_AUTH_TYPE=bearer.

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { AnonymousAuthProvider } from './anonymous';
import { BearerAuthProvider } from './bearer';
import { BloomreachAuthProvider } from './bloomreach';

export type McpAuthType = 'oauth-bloomreach' | 'bearer' | 'anonymous';

/** Config for building an AuthProvider. Sourced from env in the current
 *  factory. When Phase 5's UI-config surface lands, this shape will also
 *  come from a per-request encrypted cookie so the browser can override the
 *  env defaults per user without touching the deploy. */
export interface McpAuthConfig {
  type: McpAuthType;
  /** Session id for providers that persist state per session (currently only
   *  BloomreachAuthProvider uses this). */
  sessionId?: string;
  /** OAuth redirect URI. Required only when type === 'oauth-bloomreach'. */
  redirectUri?: string;
  /** Static bearer token. Required only when type === 'bearer'. */
  bearerToken?: string;
}

export function parseAuthType(raw: string | undefined | null): McpAuthType {
  if (raw === 'bearer') return 'bearer';
  if (raw === 'anonymous') return 'anonymous';
  return 'oauth-bloomreach'; // default preserves backward compat
}

/** Read env vars into a partial config. Callers fill in what env can't
 *  provide (sessionId, redirectUri are request-scoped). */
export function readAuthEnv(): { type: McpAuthType; bearerToken?: string } {
  const type = parseAuthType(process.env.MCP_AUTH_TYPE);
  const bearerToken = type === 'bearer' ? process.env.MCP_AUTH_TOKEN : undefined;
  if (type === 'bearer' && !bearerToken) {
    throw new Error(
      'MCP_AUTH_TYPE=bearer requires MCP_AUTH_TOKEN. Set it in env, or change MCP_AUTH_TYPE.',
    );
  }
  return { type, bearerToken };
}

/** Build the concrete AuthProvider for a given config. */
export function makeAuthProvider(config: McpAuthConfig): OAuthClientProvider {
  switch (config.type) {
    case 'oauth-bloomreach': {
      if (!config.sessionId || !config.redirectUri) {
        throw new Error(
          'oauth-bloomreach AuthProvider requires sessionId + redirectUri.',
        );
      }
      return new BloomreachAuthProvider(config.sessionId, config.redirectUri);
    }
    case 'bearer': {
      if (!config.bearerToken) {
        throw new Error('bearer AuthProvider requires bearerToken.');
      }
      return new BearerAuthProvider(config.bearerToken);
    }
    case 'anonymous': {
      return new AnonymousAuthProvider();
    }
  }
}

export { AnonymousAuthProvider } from './anonymous';
export { BearerAuthProvider } from './bearer';
export { BloomreachAuthProvider } from './bloomreach';
