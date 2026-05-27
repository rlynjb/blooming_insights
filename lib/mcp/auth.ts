import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthClientMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';

interface SessionAuthState {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

// In-memory, per-process store keyed by our app session id.
// NOTE (live-verification): on Vercel each request may hit a fresh function
// instance, so this Map can be empty between the connect request and the
// callback request. Persisting auth state across instances (KV/Redis) is a
// known follow-up; see connect.ts live-verification notes.
const authStore = new Map<string, SessionAuthState>();

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

  private get state_(): SessionAuthState {
    let st = authStore.get(this.sessionId);
    if (!st) {
      st = {};
      authStore.set(this.sessionId, st);
    }
    return st;
  }

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
    this.state_.state = v;
    return v;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.state_.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.state_.clientInformation = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.state_.tokens;
  }

  saveTokens(t: OAuthTokens): void {
    this.state_.tokens = t;
  }

  redirectToAuthorization(url: URL): void {
    this.lastAuthorizeUrl = url;
  }

  saveCodeVerifier(v: string): void {
    this.state_.codeVerifier = v;
  }

  codeVerifier(): string {
    const v = this.state_.codeVerifier;
    if (!v) throw new Error('no PKCE code_verifier stored for this session');
    return v;
  }
}

export function hasTokens(sessionId: string): boolean {
  return !!authStore.get(sessionId)?.tokens;
}

export function clearAuth(sessionId: string): void {
  authStore.delete(sessionId);
}

/** test-only */
export function _clearAuthStore(): void {
  authStore.clear();
}
