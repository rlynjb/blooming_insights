// lib/mcp/auth-providers/bloomreach.ts
//
// Bloomreach OAuth 2.1 + PKCE + DCR AuthProvider — the session-persisted
// OAuth flow that has always driven the Bloomreach connection. Re-exports
// the existing implementation from `lib/mcp/auth.ts` — the class was
// designed to live here from the start; this module just gives it its
// proper home now that we have sibling providers (bearer, anonymous) for
// the swappable-MCP surface.
//
// The class is generic OAuth 2.1 with DCR — it will work against any
// MCP server that supports the same flow, not just Bloomreach. The name
// is preserved because it's what the plan calls the default preset and
// what existing tests import; a future rename to
// `SessionPersistedOAuthProvider` would be honest but disruptive.

export { BloomreachAuthProvider } from '../auth';
