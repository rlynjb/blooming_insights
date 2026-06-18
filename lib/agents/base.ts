import type { DataSource } from '../data-source/types';

/**
 * Default model for Blooming's AptKit-backed agent adapters. Intent
 * classification may override this with a cheaper classifier model.
 */
export const AGENT_MODEL = 'claude-sonnet-4-6';

/**
 * The agent-facing subset of `DataSource` used by AptKit tool-registry
 * adapters. Full data sources can list tools, but reusable agents only need
 * the callTool execution seam.
 */
export type McpCaller = Pick<DataSource, 'callTool'>;
