import { REASON_STAGE, REASON_TEXT } from '@/lib/format';
import type { FunnelEntry } from '@/lib/types';

const STAGES = ['Tries', 'Simulated', 'Simulated OK', 'Profitable', 'Sent', 'Landed'];
const DROP_TITLE = ['Never simulated', 'Simulation said no', 'Not worth sending', 'Profitable but not sent', 'Sent but not landed'];

/**
 * Every try, from "looked at" to "landed", with the reason for each drop-off. Counts span four orders of
 * magnitude (thousands of tries, a handful of landings), so bar lengths are on a log scale.
 */
export function Funnel({ entries }: { entries: FunnelEntry[] }) {
  const atStage = (k: number) => entries.filter(e => (REASON_STAGE[e.reason] ?? 0) >= k).reduce((n, e) => n + e.n, 0);
  const counts = STAGES.map((_, k) => atStage(k));
  const max = Math.max(1, counts[0]);
  const width = (n: number) => (n <= 0 ? 0 : Math.max(1.5, (Math.log10(n + 1) / Math.log10(max + 1)) * 100));
  return (
    <div className="funnel">
      {STAGES.map((label, k) => {
        const drops = entries.filter(e => REASON_STAGE[e.reason] === k && k < 5).sort((a, b) => b.n - a.n);
        return (
          <div key={label} className="funnel-stage">
            <div className="funnel-row">
              <span className="funnel-label">{label}</span>
              <span className="funnel-bar-track"><span className="funnel-bar" style={{ width: `${width(counts[k])}%`, background: k === 5 ? 'var(--good)' : 'var(--series-1)' }} /></span>
              <b className="funnel-n">{counts[k].toLocaleString('en-US')}</b>
            </div>
            {drops.length ? (
              <div className="funnel-drops">
                <span className="funnel-drop-title">{DROP_TITLE[k]}:</span>{' '}
                {drops.map((d, i) => <span key={d.reason}>{i ? ' · ' : ''}{REASON_TEXT[d.reason] ?? d.reason} <b>{d.n.toLocaleString('en-US')}</b></span>)}
              </div>
            ) : null}
          </div>
        );
      })}
      <p className="sub" style={{ marginTop: 8 }}>Counted per try (a job retried three times counts three times). Bar lengths on a log scale.</p>
    </div>
  );
}
