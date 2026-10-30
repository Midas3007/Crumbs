'use client';

import { useState } from 'react';
import { fmtSol, fmtUsd } from '@/lib/format';

export interface DayPoint {
  day: string;
  realized: number; // lamports
  shadow: number; // lamports
  crumbs: number;
  losses: number;
}

const W = 1000;
const H = 300;
const PAD = { top: 10, right: 8, bottom: 26, left: 70 };

/** Nice tick step for a max value. */
function niceStep(span: number, ticks = 4): number {
  const raw = span / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** A bar with 4px rounded data-end, square at the zero baseline. */
function barPath(x: number, w: number, y0: number, y1: number): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return '';
  const r = Math.min(4, w / 2, h);
  if (y1 < y0) {
    return `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z`;
  }
  return `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 - r} V${y0} Z`;
}

/** Daily earnings: what Crumbs earned live vs what shadow mode says it would have earned. One axis (SOL). */
export function DailyChart({ points, solUsd }: { points: DayPoint[]; solUsd: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = points.flatMap(p => [p.realized, p.shadow]);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const step = niceStep(Math.max(max - min, 1));
  const top = Math.max(step, Math.ceil(max / step) * step);
  const bottom = Math.floor(min / step) * step;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + ((top - v) / (top - bottom)) * innerH;
  const band = innerW / points.length;
  const barW = Math.max(2, Math.min(14, (band - 6) / 2));
  const ticks: number[] = [];
  for (let v = bottom; v <= top + step / 2; v += step) ticks.push(v);
  const labelEvery = Math.ceil(points.length / 6);
  const hasShadow = points.some(p => p.shadow !== 0);
  const hasLive = points.some(p => p.realized !== 0 || p.crumbs || p.losses);
  const h = hover === null ? null : points[hover];

  return (
    <div className="chart-wrap">
      <div className="legend" aria-hidden="true">
        <span><span className="sw" style={{ background: 'var(--series-1)' }} />Earned (live, on-chain)</span>
        <span><span className="sw" style={{ background: 'var(--series-2)' }} />Would have earned (shadow)</span>
        <span style={{ marginLeft: 'auto' }}>SOL per day</span>
      </div>
      <div className="chart-scroll">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Daily earnings in SOL: live versus shadow mode" onMouseLeave={() => setHover(null)} style={{ display: 'block', overflow: 'visible' }}>
        {ticks.map(v => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} />
            <text x={PAD.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {(v / 1e9).toFixed(Math.max(0, -Math.floor(Math.log10(step / 1e9))))}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = PAD.left + band * i + band / 2;
          return (
            <g key={p.day}>
              <path d={barPath(cx - barW - 1, barW, y(0), y(p.realized))} fill="var(--series-1)" opacity={hover === null || hover === i ? 1 : 0.45} />
              <path d={barPath(cx + 1, barW, y(0), y(p.shadow))} fill="var(--series-2)" opacity={hover === null || hover === i ? 1 : 0.45} />
              {i % labelEvery === 0 || i === points.length - 1 ? (
                <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">{p.day.slice(5)}</text>
              ) : null}
              <rect x={PAD.left + band * i} y={PAD.top} width={band} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      </div>
      {h && hover !== null ? (
        <div className="tooltip" style={{ left: `clamp(0px, calc(${((PAD.left + band * hover + band / 2) / W) * 100}% - 85px), calc(100% - 180px))`, top: 28 }}>
          <div className="t">{h.day}</div>
          <div className="r"><span>Earned (live)</span><b>{fmtSol(h.realized, true)}</b></div>
          {solUsd ? <div className="r"><span /><span>{fmtUsd(h.realized, solUsd, true)}</span></div> : null}
          <div className="r"><span>Would have (shadow)</span><b>{fmtSol(h.shadow, true)}</b></div>
          <div className="r"><span>Crumbs / losses</span><b>{h.crumbs} / {h.losses}</b></div>
        </div>
      ) : null}
      {!hasShadow && !hasLive ? <p className="empty">No profitable crumbs in the last {points.length} days yet.</p> : null}
      <details className="table-view">
        <summary>Show as table</summary>
        <div className="scroll">
          <table>
            <thead><tr><th>Day</th><th className="num">Earned (live)</th><th className="num">Would have (shadow)</th><th className="num">Crumbs</th><th className="num">Losses</th></tr></thead>
            <tbody>
              {[...points].reverse().map(p => (
                <tr key={p.day}><td>{p.day}</td><td className="num">{fmtSol(p.realized, true)}</td><td className="num">{fmtSol(p.shadow, true)}</td><td className="num">{p.crumbs}</td><td className="num">{p.losses}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
