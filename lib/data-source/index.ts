// lib/data-source/index.ts
//
// DataSource factory — picks the adapter for a given live mode and returns it
// already-connected. The route handlers branch on `bi:mode` (passed through as
// `?mode=`) before they reach this factory: the `'demo'` branch never gets here
// (it replays the committed snapshot directly), so the factory's mode universe
// is just the two LIVE modes.
//
// Lifecycle:
//   - `'live-sql'`         → constructs a fresh `OlistDataSource`, spawns the
//                            mcp-server-olist subprocess via `.connect()`, and
//                            returns it. Callers must `await dispose()` to tear
//                            the subprocess down.
//   - `'live-bloomreach'`  → defers to `connectMcp(sessionId)`. The Bloomreach
//                            adapter is session-scoped (OAuth tokens live in
//                            the per-session cookie store) so it does NOT need
//                            disposing the same way — leaving the result alive
//                            matches existing route behavior.
//
// Why a factory at all: the route handlers used to construct BloomreachDataSource
// directly via connectMcp. PR C wires Olist as the default; rather than each
// route branch on mode inside its own start() block, the factory centralizes
// the construction + the connect() handshake so the routes only see DataSource.

import { OlistDataSource } from './olist-data-source';
import { connectMcp } from '../mcp/connect';
import type { ConnectResult } from '../mcp/connect';
import { bootstrapSchema, olistWorkspaceSchema, type WorkspaceSchema } from '../mcp/schema';
import type { DataSource } from './types';

export type LiveMode = 'live-sql' | 'live-bloomreach';

/** Result envelope from `makeDataSource`. Bloomreach can fail to connect (OAuth
 *  expired / never authorized) — surfaced as `{ ok: false, authUrl }` so the
 *  route layer can redirect the browser, exactly mirroring `connectMcp`'s shape.
 *  Olist never has an auth gate; for symmetry the SQL branch always returns
 *  `{ ok: true, ... }` and never `authUrl`. */
export type MakeDataSourceResult =
  | {
      ok: true;
      mode: LiveMode;
      dataSource: DataSource;
      /** Bootstrap the WorkspaceSchema for this adapter.
       *
       *   - Bloomreach calls the live orchestrator (`list_cloud_organizations`,
       *     `get_event_schema`, …) which the Bloomreach server exposes.
       *   - Olist returns a fixed Brazilian-e-commerce-shaped schema because the
       *     mcp-server-olist server intentionally exposes only the three domain
       *     tools (no schema-discovery surface).
       *
       *  Keeping the bootstrap branch inside the factory result means the route
       *  handlers never have to switch on mode for the schema — they just call
       *  `await result.bootstrap(signal)`. */
      bootstrap: (signal?: AbortSignal) => Promise<WorkspaceSchema>;
      dispose: () => Promise<void>;
    }
  | { ok: false; mode: 'live-bloomreach'; authUrl: string };

/**
 * Constructs a DataSource for the given live mode.
 *
 * For `'live-sql'`: spawns the mcp-server-olist subprocess, returns an
 *   OlistDataSource and a `dispose` that closes the subprocess.
 *
 * For `'live-bloomreach'`: defers to `connectMcp(sessionId)`. Returns the
 *   already-connected BloomreachDataSource as a `DataSource`, with a `dispose`
 *   no-op (the Bloomreach client outlives the request via the cookie-scoped
 *   auth store — disposing here would not undo the OAuth state).
 *
 * Callers (route handlers) must pass `sessionId` so the Bloomreach branch can
 * resolve the per-user OAuth session. The SQL branch ignores it.
 */
export async function makeDataSource(
  mode: LiveMode,
  sessionId: string,
): Promise<MakeDataSourceResult> {
  if (mode === 'live-sql') {
    const ds = new OlistDataSource();
    await ds.connect();
    return {
      ok: true,
      mode,
      dataSource: ds,
      // Synthesized — Olist has no schema-discovery tools. Synchronous in
      // practice (no I/O), but typed async to match the Bloomreach branch.
      bootstrap: async () => olistWorkspaceSchema(),
      dispose: () => ds.dispose(),
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
    // tear it down. A no-op dispose keeps the call-site symmetric with the
    // SQL branch.
    dispose: async () => {},
  };
}

export { OlistDataSource } from './olist-data-source';
export { BloomreachDataSource } from './bloomreach-data-source';
export type { DataSource } from './types';
