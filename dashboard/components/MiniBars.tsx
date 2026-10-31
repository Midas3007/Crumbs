export interface MiniPoint { day: string; value: number | null; detail: string }

const W = 600;
const H = 150;
const PAD = { top: 8, right: 6, bottom: 22, left: 40 };

/** One series of daily percentages (0-1). Days without data are left empty, not drawn as zero. */
export function MiniBars({ points, label, color = 'var(--series-1)' }: { points: MiniPoint[]; label: string; color?: string }) {
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const band = innerW / Math.max(1, points.length);
  const barW = Math.max(3, Math.min(22, band - 6));
  const y = (v: number) => PAD.top + (1 - v) * innerH;
  const any = points.some(p => p.value !== null);
  return (
    <div>
      <div className="chart-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} style={{ display: 'block', minWidth: 0 }}>
          {[0, 0.5, 1].map(v => (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--axis)' : 'var(--grid)'} />
              <text x={PAD.left - 6} y={y(v)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--muted)">{v * 100}%</text>
            </g>
          ))}
          {points.map((p, i) => {
            const cx = PAD.left + band * i + band / 2;
            const h = p.value === null ? 0 : Math.max(p.value > 0 ? 1.5 : 0, p.value * innerH);
            return (
              <g key={p.day}>
                {p.value !== null ? <rect x={cx - barW / 2} y={y(0) - h} width={barW} height={h} rx={Math.min(3, barW / 2)} fill={color}><title>{`${p.day}: ${p.detail}`}</title></rect> : null}
                {i % Math.ceil(points.length / 5) === 0 || i === points.length - 1 ? <text x={cx} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">{p.day.slice(5)}</text> : null}
              </g>
            );
          })}
        </svg>
      </div>
      {!any ? <p className="empty">No sends in this period yet.</p> : null}
      <details className="table-view">
        <summary>Show as table</summary>
        <table><tbody>{[...points].reverse().filter(p => p.value !== null).map(p => <tr key={p.day}><td>{p.day}</td><td className="num">{p.detail}</td></tr>)}</tbody></table>
      </details>
    </div>
  );
}
