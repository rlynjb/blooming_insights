import Anthropic from '@anthropic-ai/sdk';
import {
  classifyIntent as classifyAptKitIntent,
  parseIntent as parseAptKitIntent,
  type QueryIntent,
} from '@aptkit/core';
import { AnthropicModelProviderAdapter } from './aptkit-adapters';

export type Intent = QueryIntent;

/** Pure: map raw model output (or any string) to an Intent. Default 'diagnostic'. */
export function parseIntent(raw: string): Intent {
  return parseAptKitIntent(raw);
}

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

/** Live: classify a free-form query into an Intent (cheap, fast model).
 *  Optional `signal` lets the route layer's `req.signal` cancel this in-flight
 *  SDK call when the client navigates away mid-classify. */
export async function classifyIntent(
  anthropic: Anthropic,
  query: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<Intent> {
  return classifyAptKitIntent(
    new AnthropicModelProviderAdapter(
      anthropic,
      'coordinator',
      sessionId,
      CLASSIFIER_MODEL,
      'agents/intent:classifyIntent',
    ),
    query,
    { signal },
  );
}
