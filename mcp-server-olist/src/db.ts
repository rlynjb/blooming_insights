// mcp-server-olist/src/db.ts
//
// Thin wrapper over better-sqlite3 (sync driver — perfect for an in-process MCP
// server: no event-loop juggling, prepared statements cache transparently).
// The DB file lives at mcp-server-olist/data/olist.db relative to repo root,
// resolved off this file's location so the path works whether invoked from
// `npm run start`, a subprocess spawn, or a vitest test.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

/** Resolve the canonical olist.db path relative to this source file. Walks up
 *  from src/ (or dist/, when running compiled output) until we hit the
 *  directory containing the mcp-server-olist package.json, then into data/.
 *  Avoids `process.cwd()` which the subprocess parent controls. */
export function resolveDbPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'package.json'))) {
      return resolve(dir, 'data', 'olist.db');
    }
    dir = resolve(dir, '..');
  }
  throw new Error('olist db: could not locate package root from ' + import.meta.url);
}

/** Open the SQLite DB read-only (the MCP server never writes; the seed script
 *  is the only writer, run separately). Read-only + WAL gives concurrent reads
 *  if we ever spawn multiple worker subprocesses. */
export function openDb(path: string = resolveDbPath()): Database.Database {
  if (!existsSync(path)) {
    throw new Error(
      `olist.db not found at ${path} — run 'npm run seed' from mcp-server-olist/ first.`,
    );
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  // PRAGMA tweaks for read-only analytics workloads.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Format unix-epoch seconds back to the ISO YYYY-MM-DD shape the tool outputs
 *  use everywhere. SQLite stores raw integers — no implicit conversion. */
export function epochToIsoDate(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

/** Parse an ISO YYYY-MM-DD string into unix-epoch seconds, anchored at UTC
 *  midnight. Throws on unparseable input so the tool handler can turn it into
 *  an `isError: true` envelope. */
export function isoDateToEpoch(iso: string): number {
  // Trust the validator upstream — but defend against malformed input that
  // slipped through.
  const ms = Date.parse(iso + (iso.includes('T') ? '' : 'T00:00:00Z'));
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }
  return Math.floor(ms / 1000);
}

/** Round a unix-epoch second down to the start of its `day` or `week` bucket.
 *  Weeks are Mon-anchored (ISO week start), which is the convention the agent's
 *  prompts already use for period-over-period analysis. */
export function truncateEpoch(epochSec: number, granularity: 'day' | 'week'): number {
  const d = new Date(epochSec * 1000);
  d.setUTCHours(0, 0, 0, 0);
  if (granularity === 'week') {
    // getUTCDay: 0=Sun..6=Sat; shift so Monday is the week start.
    const day = d.getUTCDay();
    const mondayOffset = (day + 6) % 7;
    d.setUTCDate(d.getUTCDate() - mondayOffset);
  }
  return Math.floor(d.getTime() / 1000);
}
