// lib/mcp/config.ts
//
// Per-request MCP config override. Session B shipped env-driven config; this
// module adds an UI-level override on top so a portfolio visitor can plug in
// their own MCP server via a settings modal without changing env or forking.
//
// Transport shape:
//   1. Modal writes JSON to localStorage[BI_MCP_CONFIG_KEY]
//   2. Client hooks read localStorage on each fetch and encode the config
//      into an HTTP header (base64-json)
//   3. Route handlers read the header, validate the shape, and pass the
//      override to makeDataSource → connectMcp
//   4. connectMcp uses the override if present; falls back to env otherwise
//
// The override is *additive*: a partial override merges into env defaults.
// E.g. setting only `url` in the UI keeps MCP_AUTH_TYPE env-controlled.
//
// Security notes:
//   · Header rides on every streaming request (HTTPS-only in production)
//   · The MCP server sees the bearer token — trust boundary is the target URL
//   · Future work: encrypt bearer token into a short-lived cookie server-side
//     so it doesn't ride the header plaintext on every subsequent request

import type { McpAuthType } from './auth-providers';

/** The client's persisted override shape. All fields optional. */
export interface McpConfigOverride {
  url?: string;
  authType?: McpAuthType;
  bearerToken?: string;
}

/** localStorage key. Also used by the modal component. */
export const BI_MCP_CONFIG_KEY = 'bi:mcp_config';

/** HTTP header name for the client-to-server config transport. */
export const BI_MCP_CONFIG_HEADER = 'x-bi-mcp-config';

// ─── validators ──────────────────────────────────────────────────────────────

const VALID_AUTH_TYPES = new Set<McpAuthType>([
  'oauth-bloomreach',
  'bearer',
  'anonymous',
]);

/** Type guard for McpConfigOverride. Rejects anything with an unknown auth
 *  type or malformed field types. Empty strings become undefined so the
 *  override doesn't accidentally clobber env defaults with a blank URL. */
export function isMcpConfigOverride(value: unknown): value is McpConfigOverride {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.url !== undefined && typeof v.url !== 'string') return false;
  if (v.authType !== undefined) {
    if (typeof v.authType !== 'string') return false;
    if (!VALID_AUTH_TYPES.has(v.authType as McpAuthType)) return false;
  }
  if (v.bearerToken !== undefined && typeof v.bearerToken !== 'string') return false;
  return true;
}

/** Strip empty strings so a blank UI field doesn't override a set env value. */
export function normalizeConfig(config: McpConfigOverride): McpConfigOverride {
  return {
    url: config.url && config.url.trim() ? config.url.trim() : undefined,
    authType: config.authType,
    bearerToken:
      config.bearerToken && config.bearerToken.trim() ? config.bearerToken.trim() : undefined,
  };
}

// ─── client-side transport ───────────────────────────────────────────────────

/** Encode a config override into an HTTP header value (base64-encoded JSON).
 *  Base64 is used so future non-ASCII values (unicode URLs, etc.) travel
 *  safely; headers are ASCII-only by protocol. */
export function encodeConfigHeader(config: McpConfigOverride): string {
  const json = JSON.stringify(normalizeConfig(config));
  // btoa is available in browsers; Node has Buffer. Runtime detection.
  if (typeof btoa === 'function') return btoa(json);
  return Buffer.from(json, 'utf8').toString('base64');
}

/** Decode + validate an HTTP header value back into a McpConfigOverride.
 *  Returns null if the header is missing or malformed (do not throw — a bad
 *  header shouldn't crash the request; fall through to env instead). */
export function decodeConfigHeader(header: string | null | undefined): McpConfigOverride | null {
  if (!header) return null;
  try {
    const json =
      typeof atob === 'function'
        ? atob(header)
        : Buffer.from(header, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!isMcpConfigOverride(parsed)) return null;
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}

// ─── client-side localStorage helpers ────────────────────────────────────────

/** Read the persisted config from localStorage. Returns null if unset,
 *  malformed, or if localStorage is unavailable (SSR, blocked, etc.). */
export function readPersistedConfig(): McpConfigOverride | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(BI_MCP_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isMcpConfigOverride(parsed)) return null;
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}

/** Persist a config to localStorage. Empty overrides are removed (equivalent
 *  to a "reset to defaults" click in the UI). */
export function writePersistedConfig(config: McpConfigOverride | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (config === null) {
      localStorage.removeItem(BI_MCP_CONFIG_KEY);
      return;
    }
    const normalized = normalizeConfig(config);
    // If everything's empty, treat as unset.
    if (!normalized.url && !normalized.authType && !normalized.bearerToken) {
      localStorage.removeItem(BI_MCP_CONFIG_KEY);
      return;
    }
    localStorage.setItem(BI_MCP_CONFIG_KEY, JSON.stringify(normalized));
  } catch {
    /* localStorage unavailable — silent no-op */
  }
}

/** Read the persisted config and return a fetch-ready header value.
 *  Returns null if no persisted config (caller omits the header). */
export function persistedConfigHeader(): string | null {
  const config = readPersistedConfig();
  if (!config) return null;
  return encodeConfigHeader(config);
}
