import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
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

// Storage backend, keyed by our app session id. Three backends, selected by env:
//
//   • development → a gitignored file (.auth-cache.json). Next's dev server
//     re-evaluates modules on hot-reload, which would wipe an in-memory Map
//     mid-OAuth-flow (the DCR client info + PKCE verifier saved during `connect`
//     must survive until the `callback` exchanges the code), so dev persists.
//   • test → in-memory Map (isolated per run; `_clearAuthStore` resets it).
//   • production (Vercel) → an encrypted httpOnly cookie, via `withAuthCookies`
//     below. The `connect` and `callback` requests run on different ephemeral
//     instances, so the browser cookie is the only state both can see.
//
// SECURITY: the dev cache holds OAuth tokens in plaintext; it is local-only and
// gitignored. The production cookie is AES-256-GCM encrypted under AUTH_SECRET.
const PERSIST = process.env.NODE_ENV === 'development';
const CACHE_FILE = join(process.cwd(), '.auth-cache.json');
const memStore = new Map<string, SessionAuthState>();

// --- production cookie backend -------------------------------------------------
// To avoid Next's request-vs-response cookie split (a read *after* a set in the
// same request returns the OLD value), we never touch the cookie per
// provider-method call. `withAuthCookies` seeds an AsyncLocalStorage-scoped store
// from the cookie ONCE at the start of the request and flushes it back ONCE at
// the end; the provider's many synchronous read/write calls hit that store in
// between. Each request gets its own ALS context, so concurrent requests on one
// instance never share state.
interface RequestStore { store: Store; dirty: boolean }
const requestStore = new AsyncLocalStorage<RequestStore>();
const AUTH_COOKIE = 'bi_auth';
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 10; // 10 days, matches token lifetime

function aesKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'AUTH_SECRET is required in production to encrypt the auth cookie. ' +
        'Set it in your Vercel project environment variables.',
    );
  }
  return createHash('sha256').update(secret).digest(); // 32 bytes → AES-256
}

function encryptStore(store: Store): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

function decryptStore(token: string): Store {
  try {
    const buf = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', aesKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as Store;
  } catch {
    return {}; // tampered, rotated-secret, or corrupt cookie → treat as no auth
  }
}

/**
 * Run `fn` with the auth store backed by the request's encrypted cookie
 * (production only). In dev/test there is no cookie context, so the file/memory
 * store is used and `connectMcp`/`completeAuth` behave exactly as before.
 */
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);
  if (ctx.dirty) {
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}

/** Delete the production auth cookie (used by the reset route). No-op in dev/test. */
export async function deleteAuthCookie(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;
  const { cookies } = await import('next/headers');
  (await cookies()).delete(AUTH_COOKIE);
}

function readAll(): Store {
  const ctx = requestStore.getStore();
  if (ctx) return ctx.store; // production: ALS-scoped, cookie-backed
  if (!PERSIST) return Object.fromEntries(memStore); // test: isolated in-memory
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Store;
  } catch {
    /* corrupt/unreadable cache — treat as empty */
  }
  return {};
}

function writeAll(store: Store): void {
  const ctx = requestStore.getStore();
  if (ctx) {
    ctx.store = store;
    ctx.dirty = true;
    return;
  }
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

/** test-only — exercise the production cookie crypto without a request context. */
export const _authCookieCrypto = {
  encrypt: (store: Store): string => encryptStore(store),
  decrypt: (token: string): Store => decryptStore(token),
};

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
