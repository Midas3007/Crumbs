# Crumbs report: baseline

Snapshot 2026-10-31T06:36:49.964Z · mode live · counting since the funnel started (Milestone 0 build).
Counts are per try: a job retried three times counts three times.


## Read this first: what this window covers

- **Measuring started** with the Milestone 0 build at ~02:37 UTC, Oct 31.
- **The v2 speed features were switched on at 03:17 UTC** from Telegram `/features`, earlier than planned. So the funnel and speed numbers below are **mostly v2** (3.3 h of the 4 h). The clean before/after comes from the ledger, split at 03:17:

| | Baseline (Oct 30 22:39 → Oct 31 03:17, v1) | v2 (03:17 → 06:37) |
|---|---:|---:|
| Hours | 4.6 | 3.3 |
| Sent / landed | 16 / 7 | 140 / 1 |
| Race win rate | 44% | 0.7% |
| Net | +32,856 lamports | +2,000 lamports |
| Net per hour | 7,075 lamports | 600 lamports |
| Fees ÷ gross | 67% | 87% |

- **Before measuring** (first ~3 h live, from the dashboard on Oct 30-31): 10,915 checks → 907 simulated → 421 taken first by faster bots → 462 "not worth it or not ready" → 13 profitable → 7 sent → 6 landed, 1 lost. Net +0.000029 SOL, fees 0.000061 SOL.
- **First hour of measuring (v1 behaviour, 02:37-03:17):** Crumbs started on a job a median **1.4 s** after it became callable and sent at **1.7 s**; Helium's bot (`BcS9…YdYRM`) won 14 of 15 sampled races, landing within the same second.

### What the numbers say

1. **v2 made Crumbs fast enough to race, and it loses every race to Helium's bot.** Start-to-callable fell from 1.4 s to 368 ms and sends from 1.7 s to 528 ms. So Crumbs now reaches the send stage on fresh tasks it used to see only after they were gone (139 bundles vs 16). Helium's bot still lands in the same second (0 ms at 1 s resolution), and won 254 of 257 sampled races. Lost bundles cost nothing (Jito), so this didn't lose money.
2. **The v1 wins came from tasks Helium's bot hadn't run:** a burst of 4 remote tasks at 02:01 and a few others, not from winning fresh races. Those are rare and bursty, so 4.6 h vs 3.3 h can't show whether v2 affects them.
3. **`adaptive_tip` was harmful:** it raised the tip after every lost race, reached its cap, and cut the one v2 win to +2,000 lamports (from +4,000-9,000). Helium's bot doesn't bid in Jito, so a higher tip can't win. **Fixed:** the tip now only rises when a bundle is outbid while the task is still open, and learned tips were reset to 1,000.
4. **Batching:** nothing to rescue. No job was unprofitable after fees; every simulated-OK job cleared the minimum.
5. The chain clock over websocket works on Render (lag 349 ms behind wall time).

### Next

- Measure a clean v2 window with the tip fix.
- Racing fresh tasks is free in SOL but costs Helius credits (a simulation and status polls per bundle). If the free plan's credits get tight, stop racing tasks the incumbent always wins and keep to stuck, stale and remote tasks plus discovery.

## In two minutes

- **Funnel:** 1,115 tries → 536 simulated → 142 simulated OK → 142 profitable → 141 sent → 2 landed.
- **Biggest drop-off:** already gone when we built it (someone else did it) (565); simulation shows someone else already did it (178); the task's own instruction fails (stuck task) (157).
- **Races:** 2 won, 139 lost of 141 sent (1% win rate); 0 profitable tries held back because 3 sends were already pending.
- **Money, all time:** net 0.000034856 SOL ($0.0033), fees and tips 0.000080144 SOL ($0.0077): fees are 70% of gross.
- **Batching potential:** 0 of 0 unprofitable-alone jobs would clear the minimum if the base fee and tip were shared.
- **Speed (medians):** sent 528 ms after the job became callable; simulation 114 ms, send 95 ms. Winners of lost races landed 0 ms after it became callable.

## Funnel by reason

| Reason | Tries | Stage | Avg gross | Avg cost |
|---|---:|---|---:|---:|
| already gone when we built it (someone else did it) | 565 | before_sim |  |  |
| simulation shows someone else already did it | 178 | sim_failed |  |  |
| the task's own instruction fails (stuck task) | 157 | sim_failed |  |  |
| sent, not included: someone else was faster (no fee) | 139 | sent | 14,964 lamports | 12,690 lamports |
| not callable yet (task not due on-chain) | 59 | sim_failed |  |  |
| RPC error while simulating | 14 | before_sim |  |  |
| sent and landed: earned | 2 | sent | 12,500 lamports | 9,500 lamports |
| profitable, send failed | 1 | not_sent | 15,000 lamports | 13,000 lamports |

No unprofitable-after-fees jobs yet: everything that simulated fine cleared the minimum.

## Speed

259 timed jobs (sent, profitable and sampled races).

| Step (median) | Time |
|---|---:|
| Job callable → we start on it | 368 ms |
| Final simulation | 114 ms |
| Signing and sending | 95 ms |
| Job callable → our send | 528 ms |
| Job callable → our landing (1 s resolution) | 500 ms |
| Job callable → the winner's landing, races we lost (1 s resolution) | 0 ms |

Who beats us: `BcS9…dYRM` (254), `TUKv…pK7y` (2), `G3Zw…eKbV` (1).

## All-time dashboard numbers

- 8 landed, 1 failed on-chain, net 0.000034856 SOL.
- Agent up 3.4 h since the last restart: 11,826 checks.
