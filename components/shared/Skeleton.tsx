interface SkeletonProps {
  height?: number | string;
  width?: number | string;
}

export default function Skeleton({ height = 80, width = '100%' }: SkeletonProps) {
  return (
    <div
      className="animate-pulse"
      style={{
        background: 'var(--bg-surface)',
        borderRadius: 4,
        height,
        width,
      }}
    />
  );
}
