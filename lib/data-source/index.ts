// lib/data-source/index.ts
//
// DataSource factory — picks the adapter for a given live mode and returns it
// already-connected. The route handlers branch on `bi:mode` (passed through as
// `?mode=`) before they reach this factory: the `'demo'` branch never gets here
// (it replays the committed snapshot directly), so the factory's mode universe
// is the live Bloomreach adapter plus a local synthetic adapter.
//
// Default is `live-synthetic` (fully synthetic — deterministic, no OAuth
// needed, shows the product working out of the box). `demo` is preserved as
// a reliability path + regression evidence but no longer in the visible UI
// toggle; it's still reachable via `?demo=cached` URL param or by manually
// setting `bi:mode=demo` in localStorage.
//
// Lifecycle:
//   - `'live-bloomreach'`  → defers to `connectMcp(sessionId)`. The Bloomreach
//                            adapter is session-scoped (OAuth tokens live in
//                            the per-session cookie store) so it does NOT need
//                            disposing the same way — leaving the result alive
//                            matches existing route behavior.
//   - `'live-synthetic'`   → uses Blooming-owned deterministic fake data while
//                            keeping the real agent/model loop. This replaces
//                            the old Olist-style local data path without
//                            putting ecommerce fixtures into AptKit core.
//
// Why a factory at all: the route handlers used to construct BloomreachDataSource
// directly via connectMcp; the factory centralizes construction + the connect()
// handshake so the routes only see DataSource. (Phase 2 originally exposed
// 'live-sql' here too as the OlistDataSource branch; that adapter has been
// removed.)

import { connectMcp } from '../mcp/connect';
import type { ConnectResult } from '../mcp/connect';
import { bootstrapSchema, type WorkspaceSchema } from '../mcp/schema';
import { SyntheticDataSource, syntheticWorkspaceSchema } from './synthetic-data-source';
import type { DataSource } from './types';

export type LiveMode = 'live-bloomreach' | 'live-synthetic';

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

export function parseLiveMode(raw: string | null): LiveMode {
  // Default is `live-synthetic` (fully synthetic — no OAuth needed,
  // deterministic, shows the product working out of the box). Explicit
  // `live-bloomreach` still routes to Bloomreach.
  return raw === 'live-bloomreach' ? 'live-bloomreach' : 'live-synthetic';
}

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
  if (mode === 'live-synthetic') {
    const dataSource = new SyntheticDataSource();
    return {
      ok: true,
      mode,
      dataSource,
      bootstrap: async () => syntheticWorkspaceSchema,
      dispose: async () => {},
    };
  }

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
export { SyntheticDataSource, syntheticWorkspaceSchema } from './synthetic-data-source';
export type { DataSource } from './types';
