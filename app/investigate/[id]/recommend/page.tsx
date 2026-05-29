'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import ProcessStepper, { type StepState } from '@/components/shared/ProcessStepper';
import RecommendationCard from '@/components/investigation/RecommendationCard';
import InvestigationSubject from '@/components/investigation/InvestigationSubject';
import StatusLog from '@/components/shared/StatusLog';
import { useInvestigation } from '@/lib/hooks/useInvestigation';
import { investigationToMarkdown, downloadMarkdown } from '@/lib/export/investigationMarkdown';

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="lowercase"
      style={{
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono), monospace',
        fontSize: '0.8rem',
        textDecoration: 'none',
      }}
    >
      {label}
    </Link>
  );
}

// STEP 3 — "decision & recommendation": the proposed actions, with the agent's
// status/log trace in the sidebar. Hydrates from the stash written on step 2
// (instant); falls back to a fetch (demo replay / live) if opened directly.
export default function RecommendPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { items, diagnosis, recommendations, complete, error } = useInvestigation(id);

  const streaming = !complete && !error;
  const diagnosisHref = `/investigate/${id}`;
  // the user is ON the recommendation step — keep it the current (active) step,
  // never ✓, while they're still here.
  const recState: StepState = error ? 'error' : 'active';
  const recSub =
    recState === 'error'
      ? 'failed'
      : recommendations.length > 0
        ? `${recommendations.length} action${recommendations.length === 1 ? '' : 's'}`
        : diagnosis
          ? 'proposing actions…'
          : 'awaiting diagnosis…';

  const canExport = (complete || recommendations.length > 0) && !error;

  return (
    <main
      className="min-h-screen px-6 py-10 pb-28 mx-auto w-full max-w-5xl"
      style={{ fontFamily: 'var(--font-body), system-ui, sans-serif' }}
    >
      {/* header — branding + the shared stepper, consistent with the feed */}
      <div style={{ marginBottom: 32 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <BackLink href={diagnosisHref} label="← diagnosis" />
          {canExport && (
            <button
              type="button"
              onClick={() =>
                downloadMarkdown(
                  `investigation-${id ?? 'unknown'}.md`,
                  investigationToMarkdown(id ?? 'unknown', { items, diagnosis, recommendations }),
                )
              }
              className="lowercase"
              style={{
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 4,
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono), monospace',
                fontSize: '0.75rem',
                padding: '3px 10px',
              }}
            >
              export ↓
            </button>
          )}
        </div>
        <h1
          className="text-3xl lowercase"
          style={{
            fontFamily: 'var(--font-display), system-ui, sans-serif',
            color: 'var(--text-primary)',
            marginBottom: 6,
          }}
        >
          blooming insights
        </h1>
        <p className="text-sm lowercase" style={{ color: 'var(--text-secondary)' }}>
          your workspace, in bloom
        </p>
      </div>

      <ProcessStepper
        monitoring={{ state: 'complete', sub: 'change detected', href: '/' }}
        diagnostic={{ state: 'complete', sub: 'cause identified', href: diagnosisHref }}
        recommendation={{ state: recState, sub: recSub }}
      />

      {/* which feed item this investigation is about — directly above the recommendations */}
      <InvestigationSubject id={id} />

      {error ? (
        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--accent-coral)',
            borderRadius: 4,
            padding: '16px 20px',
          }}
        >
          <p
            style={{
              color: 'var(--accent-coral)',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.8rem',
              margin: '0 0 12px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error}
          </p>
          <BackLink href={diagnosisHref} label="← diagnosis" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3" style={{ gap: 24, alignItems: 'start' }}>
          {/* ── col 1 — the recommendations (step 3) ───────────────────────── */}
          <div className="lg:col-span-2" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h2
              className="lowercase"
              style={{
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono), monospace',
                fontSize: '0.7rem',
                letterSpacing: '0.06em',
                margin: 0,
              }}
            >
              recommendations
            </h2>

            {recommendations.length > 0 ? (
              recommendations.map((r) => <RecommendationCard key={r.id} recommendation={r} />)
            ) : streaming ? (
              <p
                className="text-sm lowercase"
                style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono), monospace', margin: 0 }}
              >
                {diagnosis ? 'proposing actions…' : 'awaiting diagnosis…'}
              </p>
            ) : (
              <p
                className="text-sm lowercase"
                style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono), monospace', margin: 0 }}
              >
                no recommendations
              </p>
            )}
          </div>

          {/* ── col 2 — live statuses / logs ───────────────────────────────── */}
          <StatusLog
            items={items}
            title="how these were chosen"
            countLabel={items.length > 0 ? `${items.length} steps` : undefined}
            scanning={streaming}
            emptyMessage="connecting to the agent…"
          />
        </div>
      )}
    </main>
  );
}
