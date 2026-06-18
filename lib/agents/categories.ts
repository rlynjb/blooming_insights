import {
  ECOMMERCE_ANOMALY_CATEGORIES,
  coverageReport as aptKitCoverageReport,
  runnableCategories as aptKitRunnableCategories,
  schemaCapabilities,
  type MonitoringAnomalyCategory,
} from '@aptkit/core';
import type { CategoryId, CategoryCoverage, CoverageReport } from '../mcp/types';

export { schemaCapabilities };

// Blooming compatibility shape. AptKit stores the same runnable query as a
// string; older Blooming callers expect an `eql(projectId)` function.
export interface AnomalyCategory {
  id: CategoryId;
  label: string;
  requires: string[];
  enriches?: string[];
  whyItMatters: string;
  eql: (projectId: string) => string;
  thresholds: { critical: number; warning: number };
}

export const CATEGORIES: AnomalyCategory[] = ECOMMERCE_ANOMALY_CATEGORIES.map(toBloomingCategory);

export function coverageFor(category: AnomalyCategory, available: Set<string>): CategoryCoverage {
  const [coverage] = aptKitCoverageReport([toAptKitCategory(category)], available);
  return coverage?.coverage ?? 'unavailable';
}

export function missingFor(category: AnomalyCategory, available: Set<string>): string[] {
  return [...category.requires, ...(category.enriches ?? [])].filter((dep) => !available.has(dep));
}

export function coverageReport(available: Set<string>): CoverageReport {
  return aptKitCoverageReport(CATEGORIES.map(toAptKitCategory), available).map((item) => ({
    category: item.category as CategoryId,
    label: item.label,
    coverage: item.coverage,
    ...(item.missing && item.missing.length ? { missing: item.missing } : {}),
  }));
}

export function runnableCategories(available: Set<string>): AnomalyCategory[] {
  return aptKitRunnableCategories(CATEGORIES.map(toAptKitCategory), available).map(toBloomingCategory);
}

function toBloomingCategory(category: MonitoringAnomalyCategory): AnomalyCategory {
  return {
    id: category.id as CategoryId,
    label: category.label,
    requires: [...category.requires],
    ...(category.enriches ? { enriches: [...category.enriches] } : {}),
    whyItMatters: category.whyItMatters,
    eql: () => category.queryRecipe,
    thresholds: category.thresholds,
  };
}

function toAptKitCategory(category: AnomalyCategory): MonitoringAnomalyCategory {
  return {
    id: category.id,
    label: category.label,
    requires: category.requires,
    enriches: category.enriches,
    whyItMatters: category.whyItMatters,
    queryRecipe: category.eql(''),
    thresholds: category.thresholds,
  };
}
