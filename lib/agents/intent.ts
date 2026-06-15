import Anthropic from '@anthropic-ai/sdk';

export type Intent = 'monitoring' | 'diagnostic' | 'recommendation';

/** Pure: map raw model output (or any string) to an Intent. Default 'diagnostic'. */
export function parseIntent(raw: string): Intent {
  const t = raw.trim().toLowerCase();
  if (t.includes('monitoring')) return 'monitoring';
  if (t.includes('recommendation')) return 'recommendation';
  if (t.includes('diagnostic')) return 'diagnostic';
  return 'diagnostic';
}

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

/** Live: classify a free-form query into an Intent (cheap, fast model). */
export async function classifyIntent(anthropic: Anthropic, query: string, sessionId?: string): Promise<Intent> {
  const res = await anthropic.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 16,
    system:
      'Classify the user query as exactly one word: monitoring (what changed / what is new), ' +
      'diagnostic (why did something happen), or recommendation (what should I do). Reply with ONLY the one word.',
    messages: [{ role: 'user', content: query }],
  });
  console.log(JSON.stringify({ site: 'agents/intent:classifyIntent', sessionId, usage: res.usage }));
  const text = res.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return parseIntent(text);
}
