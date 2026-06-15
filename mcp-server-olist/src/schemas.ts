// mcp-server-olist/src/schemas.ts
//
// JSON schemas for each tool's input — same dialect (Draft 2020-12) the MCP SDK
// expects in ListToolsResult.inputSchema. Kept in one file so the
// CallToolRequest handler can validate against the same shape it advertised.
//
// We deliberately validate by hand (small validators below) rather than pull in
// Ajv: only three tools, a flat schema set, and one new dep ceiling per PR B.

export const METRICS = [
  'revenue',
  'order_count',
  'avg_order_value',
  'payment_value',
] as const;
export type Metric = (typeof METRICS)[number];

export const DIMENSIONS = ['state', 'category', 'payment_type'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const GRANULARITIES = ['day', 'week'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

const timeRangeSchema = {
  type: 'object',
  required: ['from', 'to'],
  additionalProperties: false,
  properties: {
    from: { type: 'string', description: 'ISO date YYYY-MM-DD (inclusive).' },
    to: { type: 'string', description: 'ISO date YYYY-MM-DD (exclusive).' },
  },
} as const;

export const getMetricTimeseriesSchema = {
  type: 'object',
  required: ['metric', 'time_range'],
  additionalProperties: false,
  properties: {
    metric: { type: 'string', enum: [...METRICS] },
    dimension: {
      type: 'string',
      enum: [...DIMENSIONS],
      description:
        'Optional grouping dimension. When present, output points carry a `segment` field.',
    },
    time_range: timeRangeSchema,
    filter: {
      type: 'object',
      required: ['dimension', 'value'],
      additionalProperties: false,
      properties: {
        dimension: { type: 'string', enum: [...DIMENSIONS] },
        value: { type: 'string' },
      },
    },
    granularity: { type: 'string', enum: [...GRANULARITIES] },
  },
} as const;

export const getSegmentsSchema = {
  type: 'object',
  required: ['dimension'],
  additionalProperties: false,
  properties: {
    dimension: { type: 'string', enum: [...DIMENSIONS] },
    time_range: timeRangeSchema,
  },
} as const;

const ANOMALY_METRICS = ['revenue', 'order_count', 'payment_value'] as const;

export const getAnomalyContextSchema = {
  type: 'object',
  required: ['metric', 'dimension', 'segment', 'anomaly_window', 'baseline_window'],
  additionalProperties: false,
  properties: {
    metric: { type: 'string', enum: [...ANOMALY_METRICS] },
    dimension: { type: 'string', enum: [...DIMENSIONS] },
    segment: { type: 'string' },
    anomaly_window: timeRangeSchema,
    baseline_window: timeRangeSchema,
  },
} as const;

/** Hand-rolled schema validation. We only need:
 *  - required keys present
 *  - each present key has correct primitive type
 *  - enum values match
 *  - nested object / additionalProperties: false
 *  Returns null on success, a string error on failure.
 *  Kept tiny on purpose — three tools, no recursion needed past time_range. */
export function validateAgainstSchema(
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
  path = '$',
): string | null {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return `${path}: expected object`;
    }
    const obj = value as Record<string, unknown>;
    const required = (schema.required ?? []) as readonly string[];
    for (const key of required) {
      if (!(key in obj)) return `${path}.${key}: required`;
    }
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) return `${path}.${key}: not allowed`;
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) {
        const err = validateAgainstSchema(sub, obj[key], `${path}.${key}`);
        if (err) return err;
      }
    }
    return null;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path}: expected string`;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return `${path}: must be one of ${(schema.enum as unknown[]).join(', ')}`;
    }
    return null;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number') return `${path}: expected number`;
    return null;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') return `${path}: expected boolean`;
    return null;
  }
  // Unknown / open schema — accept.
  return null;
}
