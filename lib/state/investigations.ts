import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '../mcp/events';

// Sources (in order): in-memory (this process) → dev file (.investigation-cache.json) → committed demo seed.
// Writes go to in-memory always, and to the dev file in development only (serverless FS is read-only).
const PERSIST = process.env.NODE_ENV === 'development';
const CACHE_FILE = join(process.cwd(), '.investigation-cache.json');
const DEMO_FILE = join(process.cwd(), 'lib/state/demo-investigations.json');

const mem = new Map<string, AgentEvent[]>();

function readJson(path: string): Record<string, AgentEvent[]> {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /* ignore */
  }
  return {};
}

export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
  if (mem.has(insightId)) return mem.get(insightId)!;
  const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;
  if (fromFile) return fromFile;
  const fromDemo = readJson(DEMO_FILE)[insightId];
  return fromDemo ?? null;
}

export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
  mem.set(insightId, events);
  if (PERSIST) {
    const all = readJson(CACHE_FILE);
    all[insightId] = events;
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(all));
    } catch {
      /* best effort */
    }
  }
}

/** test-only */
export function _clearInvestigationCache(): void {
  mem.clear();
}
