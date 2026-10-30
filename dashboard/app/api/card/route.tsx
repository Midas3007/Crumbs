import { ImageResponse } from 'next/og';
import { fmtSol, fmtUsd } from '@/lib/format';
import { loadSnapshot } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** Share card: "Crumbs ate 412 crumbs today: +1.84 SOL, 0 losses." 1200×630 for social previews. */
export async function GET() {
  const s = await loadSnapshot();
  const shadow = !s || s.mode === 'shadow' || (s.today.crumbs === 0 && s.today.shadowWins > 0);
  const count = s ? (shadow ? s.today.shadowWins : s.today.crumbs) : 0;
  const lamports = s ? (shadow ? s.today.shadowNetLamports : s.today.realizedNetLamports) : '0';
  const usd = s ? fmtUsd(lamports, s.solUsd, true) : null;
  const headline = shadow ? `Crumbs found ${count} profitable crumbs today` : `Crumbs ate ${count} crumbs today`;
  const sub = shadow ? 'shadow mode: would have earned' : `${s?.today.losses ?? 0} losses`;

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, background: '#14130f', color: '#f0efec', fontFamily: 'sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 40, color: '#c3c2b7' }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: '#e8b04a', color: '#14130f', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 34, fontWeight: 800 }}>C</div>
          Crumbs · autonomous Solana keeper
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.1 }}>{headline}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 24 }}>
            <span style={{ fontSize: 96, fontWeight: 800, color: '#e8b04a' }}>{fmtSol(lamports, true)}</span>
            {usd ? <span style={{ fontSize: 48, color: '#c3c2b7' }}>{usd}</span> : null}
          </div>
          <div style={{ fontSize: 36, color: '#c3c2b7' }}>{sub}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 32, fontSize: 26, color: '#898781' }}>
          <span>Every transaction simulated first · profit-guarded · on-chain verifiable</span>
          <span>{s ? s.today.day : ''}</span>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
