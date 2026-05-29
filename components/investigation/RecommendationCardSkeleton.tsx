import Skeleton from '@/components/shared/Skeleton';

// Placeholder shaped like RecommendationCard — feature chip + title + rationale,
// the highlighted impact box, and the effort/time/read-result tile row — so the
// step-3 layout holds steady while the recommendation agent streams its actions.
const tile: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  borderRadius: 4,
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

export default function RecommendationCardSkeleton() {
  return (
    <div
      aria-hidden
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '16px 20px' }}
    >
      {/* top row: feature chip · position · confidence */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Skeleton height={18} width={72} />
        <Skeleton height={14} width={96} />
        <span style={{ marginLeft: 'auto' }}>
          <Skeleton height={14} width={104} />
        </span>
      </div>

      {/* title + rationale */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        <Skeleton height={16} width="70%" />
        <Skeleton height={12} />
        <Skeleton height={12} width="85%" />
      </div>

      {/* expected-impact box */}
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: '10px 12px',
          marginBottom: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <Skeleton height={10} width={88} />
        <Skeleton height={16} width="55%" />
      </div>

      {/* effort · time to set up · read result in */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        <div style={tile}>
          <Skeleton height={10} width={44} />
          <Skeleton height={14} width="60%" />
        </div>
        <div style={tile}>
          <Skeleton height={10} width={64} />
          <Skeleton height={14} width="50%" />
        </div>
        <div style={tile}>
          <Skeleton height={10} width={68} />
          <Skeleton height={14} width="50%" />
        </div>
      </div>
    </div>
  );
}
