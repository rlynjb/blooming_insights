import { describe, it, expect } from 'vitest';
import { filterToolSchemas, type McpToolDef } from '../../lib/agents/tool-schemas';

const all: McpToolDef[] = [
  { name: 'get_trend', description: 'd1', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] } },
  { name: 'secret_tool', description: 'd2', inputSchema: { type: 'object', properties: {} } },
  { name: 'execute_analytics_eql', description: 'd3', inputSchema: { type: 'object', properties: {} } },
];

describe('filterToolSchemas', () => {
  it('keeps only allowed tools, in Anthropic shape', () => {
    const out = filterToolSchemas(all, ['get_trend', 'execute_analytics_eql']);
    expect(out.map((t) => t.name)).toEqual(['get_trend', 'execute_analytics_eql']);
    expect(out[0].input_schema).toEqual(all[0].inputSchema);
    expect(out[0].description).toBe('d1');
  });
  it('ignores allowed names the server does not expose', () => {
    expect(filterToolSchemas(all, ['nonexistent'])).toEqual([]);
  });
  it('defaults missing description to empty string', () => {
    const out = filterToolSchemas([{ name: 'x', inputSchema: { type: 'object' } }], ['x']);
    expect(out[0].description).toBe('');
  });
});
