'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import ProcessStepper, { type StepState } from '@/components/shared/ProcessStepper';
import EvidencePanel from '@/components/investigation/EvidencePanel';
import InvestigationSubject from '@/components/investigation/InvestigationSubject';
import StatusLog from '@/components/shared/StatusLog';
import { useInvestigation } from '@/lib/hooks/useInvestigation';
import { investigationToMarkdown, downloadMarkdown } from '@/lib/export/investigationMarkdown';

function BackLink({ href = '/', label = '← feed' }: { href?: string; label?: string }) {
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

// STEP 2 — "investigating the issue": the diagnosis, with the agent's live
// status/log trace in the sidebar. Recommendations live on step 3
// (/investigate/[id]/recommend); the full diagnostic → recommendation run
// happens here once and is stashed, so step 3 hydrates instantly.
export default function InvestigatePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { items, diagnosis, recommendations, complete, error } = useInvestigation(id);

  const streaming = !complete && !error;
  const recsReady = complete && !error; // recs are produced during this run
  const recommendHref = `/investigate/${id}/recommend`;

  const diagState: StepState = error && !diagnosis ? 'error' : diagnosis ? 'complete' : 'active';
  const diagSub = diagState === 'error' ? 'failed' : diagState === 'complete' ? 'cause identified' : 'testing hypotheses…';
  const recState: StepState = error && diagnosis && !complete ? 'error' : complete ? 'complete' : diagnosis ? 'active' : 'pending';
  const recSub =
    recState === 'error'
      ? 'failed'
      : recState === 'complete'
        ? `${recommendations.length} action${recommendations.length === 1 ? '' : 's'} ready`
        : recState === 'active'
          ? 'preparing…'
          : 'awaiting diagnosis';

  const canExport = (complete || diagnosis !== null) && !error;

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
          <BackLink />
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

      {/* which feed item this investigation is about */}
      <InvestigationSubject id={id} />

      <ProcessStepper
        monitoring={{ state: 'complete', sub: 'change detected', href: '/' }}
        diagnostic={{ state: diagState, sub: diagSub }}
        recommendation={{ state: recState, sub: recSub, href: recsReady ? recommendHref : undefined }}
      />

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
          <BackLink />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3" style={{ gap: 24, alignItems: 'start' }}>
          {/* ── col 1 — the diagnosis (step 2) ─────────────────────────────── */}
          <div className="lg:col-span-2" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <EvidencePanel diagnosis={diagnosis} loading={streaming} />

            {recsReady ? (
              <Link
                href={recommendHref}
                className="lowercase"
                style={{
                  alignSelf: 'flex-start',
                  background: 'var(--accent-teal)',
                  color: 'var(--bg-base)',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.8rem',
                  padding: '8px 16px',
                  textDecoration: 'none',
                }}
              >
                see recommendations ({recommendations.length}) →
              </Link>
            ) : (
              <span
                className="lowercase"
                style={{
                  alignSelf: 'flex-start',
                  background: 'var(--bg-elevated)',
                  color: 'var(--text-tertiary)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.8rem',
                  padding: '8px 16px',
                }}
              >
                {diagnosis ? 'preparing recommendations…' : 'awaiting diagnosis…'}
              </span>
            )}
          </div>

          {/* ── col 2 — live statuses / logs ───────────────────────────────── */}
          <StatusLog
            items={items}
            title="how this was figured out"
            countLabel={items.length > 0 ? `${items.length} steps` : undefined}
            scanning={streaming}
            emptyMessage="connecting to the agent…"
          />
        </div>
      )}
    </main>
  );
}
