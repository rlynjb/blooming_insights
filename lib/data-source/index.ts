// lib/data-source/index.ts
//
// DataSource factory — picks the adapter for a given live mode and returns it
// already-connected. The route handlers branch on `bi:mode` (passed through as
// `?mode=`) before they reach this factory: the `'demo'` branch never gets here
// (it replays the committed snapshot directly), so the factory's mode universe
// is just the live Bloomreach adapter.
//
// Lifecycle:
//   - `'live-bloomreach'`  → defers to `connectMcp(sessionId)`. The Bloomreach
//                            adapter is session-scoped (OAuth tokens live in
//                            the per-session cookie store) so it does NOT need
//                            disposing the same way — leaving the result alive
//                            matches existing route behavior.
//
// Why a factory at all: the route handlers used to construct BloomreachDataSource
// directly via connectMcp; the factory centralizes construction + the connect()
// handshake so the routes only see DataSource. (Phase 2 originally exposed
// 'live-sql' here too as the OlistDataSource branch; that adapter has been
// removed.)

import { connectMcp } from '../mcp/connect';
import type { ConnectResult } from '../mcp/connect';
import { bootstrapSchema, type WorkspaceSchema } from '../mcp/schema';
import type { DataSource } from './types';

export type LiveMode = 'live-bloomreach';

/** Result envelope from `makeDataSource`. Bloomreach can fail to connect (OAuth
 *  expired / never authorized) — surfaced as `{ ok: false, authUrl }` so the
 *  route layer can redirect the browser, exactly mirroring `connectMcp`'s shape. */
export type MakeDataSourceResult =
  | {
      ok: true;
      mode: LiveMode;
      dataSource: DataSource;
      /** Bootstrap the WorkspaceSchema by calling the live orchestrator
       *  (`list_cloud_organizations`, `get_event_schema`, …) which the
       *  Bloomreach server exposes. Keeping the bootstrap branch inside the
       *  factory result means the route handlers don't have to know about
       *  it — they just call `await result.bootstrap(signal)`. */
      bootstrap: (signal?: AbortSignal) => Promise<WorkspaceSchema>;
      dispose: () => Promise<void>;
    }
  | { ok: false; mode: 'live-bloomreach'; authUrl: string };

/**
 * Constructs a DataSource for the given live mode.
 *
 * For `'live-bloomreach'`: defers to `connectMcp(sessionId)`. Returns the
 *   already-connected BloomreachDataSource as a `DataSource`, with a `dispose`
 *   no-op (the Bloomreach client outlives the request via the cookie-scoped
 *   auth store — disposing here would not undo the OAuth state).
 *
 * Callers (route handlers) must pass `sessionId` so the Bloomreach branch can
 * resolve the per-user OAuth session.
 */
export async function makeDataSource(
  mode: LiveMode,
  sessionId: string,
): Promise<MakeDataSourceResult> {
  // live-bloomreach — defer to the existing connect path. It owns the OAuth
  // dance, including the case where the session has no valid tokens (returns
  // `{ ok: false, authUrl }` so the route can redirect).
  const conn: ConnectResult = await connectMcp(sessionId);
  if (!conn.ok) {
    return { ok: false, mode, authUrl: conn.authUrl };
  }
  const bloomreachDs = conn.mcp;
  return {
    ok: true,
    mode,
    dataSource: bloomreachDs,
    bootstrap: (signal?: AbortSignal) => bootstrapSchema(bloomreachDs, { signal }),
    // Bloomreach is session-scoped, not subprocess-scoped — the client lives
    // across requests via the cookie store, so the route's `finally` doesn't
    // tear it down.
    dispose: async () => {},
  };
}

export { BloomreachDataSource } from './bloomreach-data-source';
export type { DataSource } from './types';
