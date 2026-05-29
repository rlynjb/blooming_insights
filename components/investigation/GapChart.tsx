interface GapChartProps {
  data: { day: string; value: number }[]; // oldest → newest
}

/** Inline-SVG daily bar chart for "where the gap landed" (no chart lib). Bars at
 *  or near zero are drawn in the danger color and a "gap" label is placed over
 *  the contiguous low run, so the diagnosed window reads at a glance. Renders
 *  nothing for <2 points. */
export default function GapChart({ data }: GapChartProps) {
  if (!data || data.length < 2) return null;

  const W = 680;
  const H = 140;
  const baseY = 100;
  const top = 18;
  const left = 8;
  const right = 8;
  const max = Math.max(...data.map((d) => d.value), 1);
  const n = data.length;
  const slot = (W - left - right) / n;
  const barW = Math.max(slot * 0.7, 4);
  const lowThreshold = max * 0.05; // "gap" = essentially zero
  const isLow = (v: number) => v <= lowThreshold;

  // the contiguous low run (for the "gap" annotation)
  let gapStart = -1;
  let gapEnd = -1;
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const low = i < n && isLow(data[i].value);
    if (low && runStart === -1) runStart = i;
    if ((!low || i === n) && runStart !== -1) {
      if (i - runStart > gapEnd - gapStart) {
        gapStart = runStart;
        gapEnd = i;
      }
      runStart = -1;
    }
  }
  const hasGap = gapStart !== -1 && gapEnd - gapStart >= 2;

  const x = (i: number) => left + i * slot + (slot - barW) / 2;
  const barH = (v: number) => Math.max(((v / max) * (baseY - top)), v > 0 ? 2 : 1.5);

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="daily values for the anomalous metric over the recent window"
      style={{ display: 'block' }}
    >
      <line x1={left} y1={baseY} x2={W - right} y2={baseY} stroke="var(--border)" strokeWidth={0.5} />
      {data.map((d, i) => {
        const h = barH(d.value);
        const low = isLow(d.value);
        return (
          <rect
            key={i}
            x={x(i)}
            y={baseY - h}
            width={barW}
            height={h}
            rx={2}
            fill={low ? 'var(--accent-coral)' : 'var(--accent-teal)'}
            opacity={low ? 0.8 : 1}
          />
        );
      })}
      {/* x labels: first · today */}
      <text x={left + barW / 2} y={baseY + 18} textAnchor="middle" fontSize={10} fill="var(--text-tertiary)" fontFamily="var(--font-mono), monospace">
        {data[0].day}
      </text>
      <text x={x(n - 1) + barW / 2} y={baseY + 18} textAnchor="middle" fontSize={10} fill="var(--text-tertiary)" fontFamily="var(--font-mono), monospace">
        {data[n - 1].day}
      </text>
      {/* gap annotation */}
      {hasGap && (
        <>
          <line
            x1={left + gapEnd * slot}
            y1={top - 4}
            x2={left + gapEnd * slot}
            y2={baseY}
            stroke="var(--accent-coral)"
            strokeWidth={0.5}
            strokeDasharray="3 3"
          />
          <text
            x={left + ((gapStart + gapEnd) / 2) * slot}
            y={top - 6}
            textAnchor="middle"
            fontSize={10}
            fill="var(--accent-coral)"
            fontFamily="var(--font-mono), monospace"
          >
            gap
          </text>
        </>
      )}
    </svg>
  );
}
