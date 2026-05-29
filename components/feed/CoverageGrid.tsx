'use client';

import Link from 'next/link';
import Skeleton from '@/components/shared/Skeleton';
import {
  TrendingDown,
  ShoppingCart,
  Flame,
  DollarSign,
  UserMinus,
  PackageX,
  Megaphone,
  Search,
  RotateCcw,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import type { CategoryId, CoverageReport, Insight, Severity } from '@/lib/mcp/types';
import { CATEGORIES } from '@/lib/agents/categories';

const ICONS: Record<CategoryId, LucideIcon> = {
  conversion_drop: TrendingDown,
  cart_abandonment: ShoppingCart,
  product_demand: Flame,
  revenue_drop: DollarSign,
  customer_churn: UserMinus,
  inventory: PackageX,
  campaign_perf: Megaphone,
  search_failure: Search,
  return_spike: RotateCcw,
  fraud: ShieldAlert,
};

function sevColor(s: Severity): string {
  return s === 'critical'
    ? 'var(--accent-coral)'
    : s === 'warning'
      ? 'var(--accent-amber)'
      : s === 'positive'
        ? 'var(--accent-teal)'
        : 'var(--text-tertiary)';
}

interface CoverageGridProps {
  coverage: CoverageReport;
  insights: Insight[];
  loading?: boolean; // briefing still streaming — render not-yet-reported tiles as pending
}

const labelMono: React.CSSProperties = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.7rem',
  color: 'var(--text-primary)',
};
const microMono: React.CSSProperties = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.6rem',
  letterSpacing: '0.04em',
};

export default function CoverageGrid({ coverage, insights, loading = false }: CoverageGridProps) {
  // nothing to show yet and not loading → render nothing (idle/empty/error states).
  if ((!coverage || coverage.length === 0) && !loading) return null;

  const byCat = new Map(coverage.map((c) => [c.category, c]));
  const insightByCat = new Map<CategoryId, Insight>();
  for (const i of insights) if (i.category && !insightByCat.has(i.category)) insightByCat.set(i.category, i);

  // counts reflect what's been reported so far — they tick up as tiles stream in.
  const checked = coverage.length;
  const monitored = coverage.filter((c) => c.coverage !== 'unavailable').length;
  const firing = CATEGORIES.filter((c) => insightByCat.has(c.id)).length;
  const skipped = coverage.filter((c) => c.coverage === 'unavailable');
  const settling = loading && checked < CATEGORIES.length;

  return (
    <div className="bi-fade-up">
      {/* header: title + counts + legend */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontFamily: 'var(--font-mono), monospace', fontSize: '0.95rem', color: 'var(--text-primary)' }}>
            anomaly coverage
          </div>
          <div style={{ ...labelMono, fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: 5 }}>
            10 categories · <span style={{ color: 'var(--accent-teal)' }}>{monitored} monitored</span> ·{' '}
            <span style={{ color: 'var(--accent-coral)' }}>{firing} firing</span> ·{' '}
            <span style={{ color: 'var(--text-tertiary)' }}>{skipped.length} no data</span>
            {settling && (
              <span className="animate-pulse" style={{ color: 'var(--text-tertiary)' }}>
                {' '}· checking {checked}/10…
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, ...microMono, color: 'var(--text-tertiary)' }}>
          <LegendDot color="var(--accent-coral)" label="anomaly" />
          <LegendDot color="var(--accent-teal)" label="clear" />
          <LegendDot color="var(--accent-amber)" label="limited" />
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, border: '1px dashed var(--text-tertiary)' }} />
            planned
          </span>
        </div>
      </div>

      {/* tile grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
        {CATEGORIES.map((cat) => {
          const report = byCat.get(cat.id);
          const Icon = ICONS[cat.id];
          const coverageState = report?.coverage ?? 'unavailable';
          const insight = insightByCat.get(cat.id);

          // ── pending tile — gate hasn't reported this category yet ──
          if (!report && loading) {
            return (
              <div
                key={cat.id}
                className="animate-pulse"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: 13,
                  borderRadius: 8,
                  minHeight: 96,
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  opacity: 0.5,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ display: 'grid', placeItems: 'center', width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)' }}>
                    <Icon size={13} color="var(--text-tertiary)" />
                  </span>
                  <span style={{ ...microMono, color: 'var(--text-tertiary)' }}>checking…</span>
                </div>
                <div style={{ ...labelMono, color: 'var(--text-tertiary)' }}>{cat.label}</div>
                <div style={{ marginTop: 'auto' }}>
                  <Skeleton height={9} width="80%" />
                </div>
              </div>
            );
          }

          // ── ghost / planned tile ──
          if (coverageState === 'unavailable') {
            const needs = report?.missing?.join(', ') ?? cat.requires.join(', ');
            return (
              <div
                key={cat.id}
                title={`needs ${needs} — not emitted in this workspace`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: 13,
                  borderRadius: 8,
                  minHeight: 96,
                  background: 'var(--bg-base)',
                  border: '1px dashed var(--border)',
                  opacity: 0.55,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span
                    style={{
                      display: 'grid',
                      placeItems: 'center',
                      width: 26,
                      height: 26,
                      borderRadius: 6,
                      border: '1px dashed var(--border)',
                    }}
                  >
                    <Icon size={13} color="var(--text-tertiary)" />
                  </span>
                  <span style={{ ...microMono, color: 'var(--text-tertiary)', fontSize: '0.55rem' }}>no data source</span>
                </div>
                <div style={{ ...labelMono, color: 'var(--text-tertiary)' }}>{cat.label}</div>
                <div style={{ marginTop: 'auto', ...microMono, color: 'var(--text-tertiary)' }}>
                  planned · needs {needs}
                </div>
              </div>
            );
          }

          // ── live tile (full / limited; firing if a matching insight exists) ──
          const firingTile = !!insight;
          const accent = coverageState === 'limited' && !firingTile
            ? 'var(--accent-amber)'
            : firingTile
              ? sevColor(insight!.severity)
              : 'var(--accent-teal)';
          const statusLabel = firingTile
            ? insight!.severity === 'positive'
              ? 'spike'
              : 'anomaly'
            : coverageState === 'limited'
              ? 'limited'
              : 'clear';
          const finding = firingTile
            ? insight!.summary.toLowerCase()
            : coverageState === 'limited'
              ? `monitored · missing ${report?.missing?.join(', ') ?? cat.enriches?.join(', ') ?? ''}`
              : 'clear · no anomaly this window';

          const tile = (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: 13,
                borderRadius: 8,
                minHeight: 96,
                background: 'var(--bg-elevated)',
                border: `1px solid ${firingTile ? `color-mix(in srgb, ${accent} 40%, var(--border))` : 'var(--border)'}`,
                position: 'relative',
                overflow: 'hidden',
                cursor: firingTile ? 'pointer' : 'default',
                height: '100%',
              }}
            >
              {firingTile && (
                <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: accent, opacity: 0.6 }} />
              )}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span
                  style={{
                    display: 'grid',
                    placeItems: 'center',
                    width: 26,
                    height: 26,
                    borderRadius: 6,
                    background: `color-mix(in srgb, ${accent} 12%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${accent} 33%, transparent)`,
                  }}
                >
                  <Icon size={13} color={accent} />
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span
                    aria-hidden
                    className={insight?.severity === 'critical' ? 'animate-pulse' : undefined}
                    style={{ width: 6, height: 6, borderRadius: 99, background: accent }}
                  />
                  <span style={{ ...microMono, color: accent }}>{statusLabel}</span>
                </span>
              </div>
              <div style={labelMono}>{cat.label}</div>
              <div
                style={{
                  marginTop: 'auto',
                  fontFamily: 'var(--font-body), system-ui, sans-serif',
                  fontSize: '0.66rem',
                  color: 'var(--text-secondary)',
                  lineHeight: 1.35,
                }}
              >
                {finding}
              </div>
            </div>
          );

          // firing tiles route into the investigation, reusing the same path an
          // InsightCard click takes (the insight is already stashed on load).
          return firingTile ? (
            <Link key={cat.id} href={`/investigate/${insight!.id}`} style={{ textDecoration: 'none', display: 'block' }}>
              {tile}
            </Link>
          ) : (
            <div key={cat.id}>{tile}</div>
          );
        })}
      </div>

      {/* coverage note — once the gate has finished, when categories were skipped */}
      {!settling && skipped.length > 0 && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 13px',
            borderRadius: 8,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            ...microMono,
            fontSize: '0.66rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.55,
          }}
        >
          <span style={{ color: 'var(--text-tertiary)' }}>coverage note ·</span> checked {monitored} of 10
          categories against this workspace&apos;s event schema. skipped{' '}
          <span style={{ color: 'var(--text-tertiary)' }}>{skipped.map((c) => c.label).join(', ')}</span> — the
          required events aren&apos;t emitted here.
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: color }} />
      {label}
    </span>
  );
}
