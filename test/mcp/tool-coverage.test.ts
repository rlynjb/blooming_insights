import { describe, it, expect } from 'vitest';
import {
  crossCheckToolCoverage,
  extractToolNames,
} from '../../lib/mcp/tool-coverage';
import {
  monitoringTools,
  diagnosticTools,
  recommendationTools,
  bootstrapTools,
} from '../../lib/mcp/tools';

const allConfigured = [
  ...new Set<string>([
    ...monitoringTools,
    ...diagnosticTools,
    ...recommendationTools,
    ...bootstrapTools,
  ]),
];

describe('extractToolNames', () => {
  it('pulls names from a listTools envelope', () => {
    const raw = { tools: [{ name: 'whoami' }, { name: 'list_projects' }] };
    expect(extractToolNames(raw)).toEqual(['whoami', 'list_projects']);
  });

  it('is robust to a missing/!array tools field', () => {
    expect(extractToolNames({})).toEqual([]);
    expect(extractToolNames(null)).toEqual([]);
    expect(extractToolNames({ tools: 'nope' })).toEqual([]);
  });

  it('drops entries without a string name', () => {
    expect(extractToolNames({ tools: [{ name: 'ok' }, {}, { name: 5 }] })).toEqual(['ok']);
  });
});

describe('crossCheckToolCoverage', () => {
  it('reports ok with no missing names when the server exposes everything', () => {
    const report = crossCheckToolCoverage(allConfigured);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual({
      monitoring: [],
      diagnostic: [],
      recommendation: [],
      bootstrap: [],
    });
  });

  it('flags a configured name the server does not expose', () => {
    // Server is missing exactly one bootstrap tool.
    const server = allConfigured.filter((n) => n !== 'list_catalogs');
    const report = crossCheckToolCoverage(server);
    expect(report.ok).toBe(false);
    expect(report.missing.bootstrap).toContain('list_catalogs');
  });

  it('lists server tools not referenced by any configured list as unusedOnServer', () => {
    const report = crossCheckToolCoverage([...allConfigured, 'some_new_server_tool']);
    expect(report.unusedOnServer).toEqual(['some_new_server_tool']);
    expect(report.ok).toBe(true);
  });

  it('sorts serverTools deterministically', () => {
    const report = crossCheckToolCoverage(['z_tool', 'a_tool']);
    expect(report.serverTools).toEqual(['a_tool', 'z_tool']);
  });

  it('every bootstrap tool name is one the schema bootstrap path actually calls', () => {
    // Guards task 1: bootstrapTools must match resolveProject + bootstrapSchema.
    expect([...bootstrapTools].sort()).toEqual(
      [
        'get_customer_property_schema',
        'get_event_schema',
        'get_project_overview',
        'list_catalogs',
        'list_cloud_organizations',
        'list_projects',
      ].sort(),
    );
  });
});
