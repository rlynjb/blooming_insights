export interface McpSession { token: string; expiresAt: number; }

const sessions = new Map<string, McpSession>();
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

export function putSession(sessionId: string, session: McpSession): void {
  sessions.set(sessionId, session);
}

export async function getSession(sessionId: string): Promise<McpSession | null> {
  const s = sessions.get(sessionId);
  if (!s || s.expiresAt < Date.now()) return null;
  return s;
}

/** test-only */
export function _clearAllSessions(): void { sessions.clear(); }

// --- OAuth flow (integration; implemented in a later task against the official
//     bloomreach ts sample: github.com/bloomreach/loomi-connect-mcp-client-examples) ---
const pendingStates = new Map<string, true>();

export async function startAuthFlow(): Promise<{ authUrl: string; state: string }> {
  const state = crypto.randomUUID();
  pendingStates.set(state, true);
  const redirectUri = `${process.env.APP_ORIGIN ?? ''}/api/mcp/callback`;
  const authUrl = buildAuthorizeUrl({ redirectUri, state });
  return { authUrl, state };
}

export async function handleCallback(code: string, state: string): Promise<McpSession> {
  if (!pendingStates.delete(state)) throw new Error('unknown oauth state');
  const token = await exchangeCodeForToken(code, `${process.env.APP_ORIGIN ?? ''}/api/mcp/callback`);
  const session: McpSession = {
    token: token.access_token,
    expiresAt: Date.now() + Math.min(token.expires_in * 1000, THIRTY_DAYS),
  };
  return session;
}

// Replaced with real implementations in a later task once the bloomreach sample's
// endpoints are confirmed. Declared (not defined) so the file typechecks now.
declare function buildAuthorizeUrl(o: { redirectUri: string; state: string }): string;
declare function exchangeCodeForToken(code: string, redirectUri: string): Promise<{ access_token: string; expires_in: number }>;
