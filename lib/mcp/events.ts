// lib/mcp/events.ts
import type { ReasoningStep, Insight, Diagnosis, Recommendation, AgentName } from './types';

export type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }
  | { type: 'tool_call_start'; toolName: string; agent: AgentName }
  | { type: 'tool_call_end'; toolName: string; agent: AgentName; durationMs: number; result?: unknown; error?: string }
  | { type: 'insight'; insight: Insight }
  | { type: 'diagnosis'; diagnosis: Diagnosis }
  | { type: 'recommendation'; recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** Encode one event as a single NDJSON line (JSON + '\n'). */
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';
}

/** Decode one NDJSON line into an AgentEvent. */
export function decodeEvent(line: string): AgentEvent {
  return JSON.parse(line) as AgentEvent;
}
