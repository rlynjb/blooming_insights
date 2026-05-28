import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
  OAuthClientMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';

interface SessionAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

type Store = Record<string, SessionAuthState>;

// Storage backend, keyed by our app session id.
//
// In development we persist to a gitignored file because Next's dev server
// re-evaluates modules on hot-reload / on-demand route compilation, which would
// otherwise wipe an in-memory Map mid-OAuth-flow (the DCR client info + PKCE
// verifier saved during `connect` must survive until the `callback` exchanges
// the code). In test/production we stay in-memory: tests need isolation, and on
// serverless the filesystem is read-only — production still needs a shared store
// (KV/Redis); see connect.ts live-verification notes.
//
// SECURITY: the dev cache holds OAuth access/refresh tokens in plaintext. It is
// local-only and gitignored (.auth-cache.json). The official Python sample caches
// tokens the same way (~/.cache/loomi-mcp/tokens.json).
const PERSIST = process.env.NODE_ENV === 'development';
const CACHE_FILE = join(process.cwd(), '.auth-cache.json');
const memStore = new Map<string, SessionAuthState>();

function readAll(): Store {
  if (!PERSIST) return Object.fromEntries(memStore);
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Store;
  } catch {
    /* corrupt/unreadable cache — treat as empty */
  }
  return {};
}

function writeAll(store: Store): void {
  if (!PERSIST) {
    memStore.clear();
    for (const [k, v] of Object.entries(store)) memStore.set(k, v);
    return;
  }
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(store));
  } catch {
    /* best-effort; if the FS is read-only we simply lose persistence */
  }
}

function readState(sessionId: string): SessionAuthState {
  return readAll()[sessionId] ?? {};
}

function patchState(sessionId: string, patch: Partial<SessionAuthState>): void {
  const all = readAll();
  all[sessionId] = { ...(all[sessionId] ?? {}), ...patch };
  writeAll(all);
}

/**
 * OAuthClientProvider whose persistence is keyed by our app session id.
 *
 * redirectToAuthorization captures the URL instead of opening a browser, so the
 * server can hand it back to the client to perform a full-page redirect.
 */
export class BloomreachAuthProvider implements OAuthClientProvider {
  public lastAuthorizeUrl?: URL;

  constructor(
    private sessionId: string,
    private redirectUri: string,
  ) {}

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'blooming insights',
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid profile email',
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    const v = crypto.randomUUID();
    patchState(this.sessionId, { state: v });
    return v;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readState(this.sessionId).clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    patchState(this.sessionId, { clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    return readState(this.sessionId).tokens;
  }

  saveTokens(t: OAuthTokens): void {
    patchState(this.sessionId, { tokens: t });
  }

  redirectToAuthorization(url: URL): void {
    this.lastAuthorizeUrl = url;
  }

  saveCodeVerifier(v: string): void {
    patchState(this.sessionId, { codeVerifier: v });
  }

  codeVerifier(): string {
    const v = readState(this.sessionId).codeVerifier;
    if (!v) throw new Error('no PKCE code_verifier stored for this session');
    return v;
  }
}

export function hasTokens(sessionId: string): boolean {
  return !!readState(sessionId).tokens;
}

/**
 * Validate and consume the OAuth CSRF `state` for a session (one-time use).
 * Currently NOT wired into the callback — the MCP SDK calls state() multiple
 * times per flow, which broke naive re-validation. Kept (and tested) for a
 * future shared-store implementation that can track issued states properly.
 */
export function consumeState(sessionId: string, state: string | null): boolean {
  const stored = readState(sessionId).state;
  if (stored !== undefined) patchState(sessionId, { state: undefined });
  if (!stored) return true;
  return stored === state;
}

export function clearAuth(sessionId: string): void {
  const all = readAll();
  delete all[sessionId];
  writeAll(all);
}

/** test-only */
export function _clearAuthStore(): void {
  memStore.clear();
  if (PERSIST) {
    try {
      writeFileSync(CACHE_FILE, JSON.stringify({}));
    } catch {
      /* ignore */
    }
  }
}
