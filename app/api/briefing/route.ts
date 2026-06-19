import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { getOrCreateSessionId } from '@/lib/mcp/session';
import { makeDataSource, parseLiveMode, type LiveMode } from '@/lib/data-source';
import { redactSecrets, formatError } from '@/lib/mcp/transport';
// `bootstrapSchema` is now consumed indirectly via the DataSource factory's
// `bootstrap()` — see lib/data-source/index.ts.
import { MonitoringAgent } from '@/lib/agents/monitoring';
import { schemaCapabilities, coverageReport, runnableCategories } from '@/lib/agents/categories';
import type { McpToolDef } from '@/lib/agents/tool-schemas';
import { anomalyToInsight, putInsights, listInsights } from '@/lib/state/insights';
import type { CoverageItem, CoverageReport, Insight, ToolCall } from '@/lib/mcp/types';
import type { AgentEvent } from '@/lib/mcp/events';

// 300s = Vercel Pro's max. The monitoring agent + ~1 req/s MCP spacing can run
// well past Hobby's 60s ceiling, so the live briefing needs the higher budget.
export const maxDuration = 300;

const DEMO_FILE = join(process.cwd(), 'lib/state/demo-insights.json');

// Pause between replayed demo events, so the snapshot reveals at a readable
// pace instead of all at once (matches the agent route's investigation replay).
const REPLAY_DELAY_MS = 140;

// Shape of the captured demo snapshot we replay (a superset of BriefingResponse).
type DemoTraceItem =
  | { kind: 'step'; content?: string }
  | { kind: 'tool'; toolName?: string; result?: unknown; durationMs?: number; error?: string };
type DemoSnapshot = {
  workspace?: BriefingWorkspace;
  coverage?: CoverageReport;
  trace?: DemoTraceItem[];
  insights?: Insight[];
};

/** Narrate the schema-gate decision as a per-category checklist for the status
 *  panel — one honest line per category, derived from the real CoverageReport. */
function coverageChecklistSteps(coverage: CoverageReport): string[] {
  return coverage.map((c) => {
    if (c.coverage === 'full') return `${c.label} · monitored`;
    if (c.coverage === 'limited') {
      return `${c.label} · limited${c.missing?.length ? ` — missing ${c.missing.join(', ')}` : ''}`;
    }
    return `${c.label} · no data source${c.missing?.length ? ` — needs ${c.missing.join(', ')}` : ''}`;
  });
}

type BriefingWorkspace = { projectName: string; totalCustomers: number; totalEvents: number };
// Reuse the AgentEvent variants for live activity; add briefing-only `workspace`
// and coverage events. `coverage_item` streams one category's result at a time
// so the grid fills tile-by-tile in step with the checklist log; `coverage` is
// the bulk form kept for the plain-JSON fallback. Kept local so the shared
// AgentEvent contract (used by /api/agent + the investigation view) is untouched.
type BriefingEvent =
  | AgentEvent
  | { type: 'workspace'; workspace: BriefingWorkspace }
  | { type: 'coverage_item'; item: CoverageItem }
  | { type: 'coverage'; coverage: CoverageReport };

/** Human-readable label for a monitoring tool call — prefers the real EQL/query
 *  text the agent actually ran, falling back to the tool name. */
function describeToolCall(tc: ToolCall): string {
  const a = tc.args as Record<string, unknown> | undefined;
  const q = a && (a.eql ?? a.query ?? a.analysis ?? a.expression);
  const text = typeof q === 'string' && q.trim() ? q.trim() : tc.toolName;
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

const TRUNC = 4000;
function trunc(v: unknown): unknown {
  const s = JSON.stringify(v);
  return s && s.length > TRUNC ? s.slice(0, TRUNC) + '…' : v;
}

export async function GET(req: NextRequest) {
  const demo = req.nextUrl.searchParams.get('demo') === 'cached';

  // Demo mode: replay the pre-captured snapshot as an NDJSON stream (creds-free),
  // mirroring the live event order so the feed reveals progressively — the
  // coverage checklist narrates into the status panel, the grid resolves, then
  // the recorded EQL trace and the insight cards stream in (the agent route
  // replays investigations the same way). The client routes any non-NDJSON
  // response down a plain-JSON fallback, so a malformed file still degrades.
  if (demo && existsSync(DEMO_FILE)) {
    let snapshot: DemoSnapshot | null = null;
    try {
      snapshot = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as DemoSnapshot;
    } catch {
      snapshot = null;
    }
    if (snapshot) {
      const snap = snapshot;
      const encoder = new TextEncoder();
      const coverage = Array.isArray(snap.coverage) ? snap.coverage : [];
      const trace = Array.isArray(snap.trace) ? snap.trace : [];
      const insights = Array.isArray(snap.insights) ? snap.insights : [];
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = async (e: BriefingEvent) => {
            controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
            await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
          };
          const stepEvt = (content: string): BriefingEvent => ({
            type: 'reasoning_step',
            step: { id: crypto.randomUUID(), agent: 'monitoring', kind: 'thought', content },
          });
          try {
            if (snap.workspace) await emit({ type: 'workspace', workspace: snap.workspace });
            if (coverage.length > 0) {
              await emit(stepEvt('matching the workspace schema to the 10-category anomaly checklist…'));
              // one category per tick: log line + its tile resolve together, so
              // the grid fills in step with the checklist instead of all at once.
              const lines = coverageChecklistSteps(coverage);
              for (let i = 0; i < coverage.length; i++) {
                controller.enqueue(encoder.encode(JSON.stringify(stepEvt(lines[i])) + '\n'));
                controller.enqueue(encoder.encode(JSON.stringify({ type: 'coverage_item', item: coverage[i] }) + '\n'));
                await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
              }
            }
            // replay the recorded monitoring trace (the agent's real EQL queries)
            for (const t of trace) {
              if (t.kind === 'tool') {
                const toolName = t.toolName ?? 'execute_analytics_eql';
                await emit({ type: 'tool_call_start', toolName, agent: 'monitoring' });
                await emit({
                  type: 'tool_call_end',
                  toolName,
                  agent: 'monitoring',
                  durationMs: t.durationMs ?? 0,
                  result: t.result,
                  error: t.error,
                });
              } else if (t.content) {
                await emit(stepEvt(t.content));
              }
            }
            for (const insight of insights) await emit({ type: 'insight', insight });
            await emit({ type: 'done' });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store, no-transform',
        },
      });
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not set' }, { status: 500 });
  }

  // `live-bloomreach` uses the real Bloomreach MCP server. `live-synthetic`
  // keeps the real model/agent loop but swaps the data source to Blooming-owned
  // fake data. Legacy values fall back to Bloomreach.
  const mode: LiveMode = parseLiveMode(req.nextUrl.searchParams.get('mode'));

  // Construct the DataSource via the factory BEFORE committing to a stream so
  // a Bloomreach auth-gate can return 401 JSON the feed redirects on. Wrapped
  // so a setup throw (e.g. missing AUTH_SECRET breaking cookie encryption in
  // production) returns the real message instead of a bare 500.
  let sid: string;
  let dsResult: Awaited<ReturnType<typeof makeDataSource>>;
  try {
    sid = await getOrCreateSessionId();
    dsResult = await makeDataSource(mode, sid);
  } catch (e) {
    console.error('[briefing] setup error:', redactSecrets(formatError(e)));
    return NextResponse.json(
      { error: `/api/briefing setup · ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  if (!dsResult.ok) {
    return NextResponse.json({ needsAuth: true, authUrl: dsResult.authUrl }, { status: 401 });
  }
  // The abstract DataSource surface is what agents + bootstrapSchema consume.
  // The 4 short MCP routes still use the Bloomreach adapter directly for the
  // skipCache option (cache-bypass is Bloomreach-specific).
  const dataSource = dsResult.dataSource;
  const bootstrap = dsResult.bootstrap;
  const disposeDataSource = dsResult.dispose;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: BriefingEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
      const step = (content: string) =>
        send({
          type: 'reasoning_step',
          step: { id: crypto.randomUUID(), agent: 'monitoring', kind: 'thought', content },
        });
      // Per-phase wall-clock timings — server-side `console.log` only, emitted
      // once per request in the `finally` so the summary still fires when a
      // phase throws (the 300s-budget incident signal). Not on the NDJSON wire.
      const t0 = performance.now();
      const phases: Array<{ phase: string; durationMs: number }> = [];
      const recordPhase = (phase: string, started: number) => {
        phases.push({ phase, durationMs: Math.round(performance.now() - started) });
      };
      try {
        // Cancellation is honored at coarse phase boundaries inside the stream
        // AND threaded into every async layer below (bootstrapSchema, listTools,
        // MonitoringAgent.scan → runAgentLoop → dataSource.callTool + anthropic.messages.create).
        // Whichever fires first (`req.signal` from the client, or
        // `AbortSignal.timeout(30_000)` on a per-call basis in the MCP transport)
        // cancels in-flight work.
        req.signal.throwIfAborted();
        step('reading the workspace schema…');
        const t_schema = performance.now();
        // The factory's bootstrap runs the Bloomreach orchestrator
        // (list_cloud_organizations / get_event_schema / …).
        const schema = await bootstrap(req.signal);
        recordPhase('schema_bootstrap', t_schema);
        send({
          type: 'workspace',
          workspace: {
            projectName: schema.projectName,
            totalCustomers: schema.totalCustomers,
            totalEvents: schema.totalEvents,
          },
        });

        // Gate the 10-category checklist against the live schema; surface the
        // coverage (runnable + skipped) and run only the runnable categories so
        // monitoring never spends EQL budget on unsupported ones.
        const t_coverage = performance.now();
        const capabilities = schemaCapabilities(schema);
        const coverage = coverageReport(capabilities);
        const runnable = runnableCategories(capabilities);
        // narrate the gate as a per-category checklist, resolving each tile as
        // its line is logged (the grid fills in step with the checklist).
        step('matching the workspace schema to the 10-category anomaly checklist…');
        const coverageLines = coverageChecklistSteps(coverage);
        coverage.forEach((item, i) => {
          step(coverageLines[i]);
          send({ type: 'coverage_item', item });
        });
        recordPhase('coverage_gate', t_coverage);

        req.signal.throwIfAborted();
        const t_listTools = performance.now();
        const raw = await dataSource.listTools({ signal: req.signal });
        const allTools: McpToolDef[] = Array.isArray((raw as { tools?: unknown })?.tools)
          ? (raw as { tools: McpToolDef[] }).tools
          : [];
        recordPhase('list_tools', t_listTools);

        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const agent = new MonitoringAgent(anthropic, dataSource, schema, allTools, sid);

        req.signal.throwIfAborted();
        step(`checking ${runnable.length} of 10 anomaly categories against this workspace…`);
        const t_scan = performance.now();
        const anomalies = await agent.scan({
          onToolCall: (tc) => {
            send({ type: 'tool_call_start', toolName: tc.toolName, agent: 'monitoring' });
            step(describeToolCall(tc)); // the real query, as the live status line
          },
          onToolResult: (tc) =>
            send({
              type: 'tool_call_end',
              toolName: tc.toolName,
              agent: 'monitoring',
              durationMs: tc.durationMs ?? 0,
              result: trunc(tc.result), // surfaced in the feed's "how it was gathered" trace
              error: tc.error,
            }),
          onText: (t) => {
            if (t.trim()) step(t.trim());
          },
          signal: req.signal,
        }, runnable);
        recordPhase('monitoring_scan', t_scan);

        req.signal.throwIfAborted();
        const insights = anomalies.map(anomalyToInsight);
        putInsights(sid, insights, anomalies);
        for (const insight of listInsights(sid)) send({ type: 'insight', insight });

        send({ type: 'done' });
      } catch (e) {
        // Client cancelled (closed tab / navigated away / unmount cleanup) —
        // skip the error event (no consumer to read it) but still let the
        // finally fire so the phase log records how much budget was burned
        // before the cancel landed.
        if (e instanceof DOMException && e.name === 'AbortError') {
          return;
        }
        // full stack/cause in Vercel logs, with bearer/OAuth tokens redacted
        console.error('[briefing] error:', redactSecrets(formatError(e)));
        send({
          type: 'error',
          message: `/api/briefing · ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        // Tear the per-request DataSource down. Currently a no-op for the
        // Bloomreach adapter (the OAuth client outlives the request via the
        // cookie store). Best-effort — a teardown error must NOT swallow the
        // route-level error above.
        try {
          await disposeDataSource();
        } catch (disposeErr) {
          console.error('[briefing] dispose error:', redactSecrets(formatError(disposeErr)));
        }
        // One summary line per request — shared shape with /api/agent so a
        // single Vercel filter (e.g. phases.phase = "schema_bootstrap") reads
        // across both routes. Fires even on error so we can see how much of the
        // 300s budget was burned before the failure.
        console.log(JSON.stringify({
          route: '/api/briefing',
          sessionId: sid,
          mode,
          totalMs: Math.round(performance.now() - t0),
          phases,
          aborted: req.signal.aborted,
        }));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
    },
  });
}
