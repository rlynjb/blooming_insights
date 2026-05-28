import type Anthropic from '@anthropic-ai/sdk';

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: object;
}

export function filterToolSchemas(
  all: McpToolDef[],
  allowed: readonly string[],
): Anthropic.Messages.Tool[] {
  const set = new Set(allowed);
  return all
    .filter((t) => set.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
    }));
}
