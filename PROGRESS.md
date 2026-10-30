# Progress

## Done — Milestone 1 (executor core, shadow mode)

- Executor loop: detect → build → measure CUs → final simulation → profit guard → caps/kill switch → send → realized P&L from chain.
- Profit guard (pure, tested): net = simulated agent balance change (fees already included, verified on mainnet) + token changes valued by price; verdicts for min profit, per-job spend cap, failed simulation, unknown balance effect, anomaly (> 1.5× documented reward).
- Priority fee: Helius `getPriorityFeeEstimate` when a Helius key is set, else the median of recent fees; always clamped so the fee can't eat the profit.
- Caps: wallet cap, daily loss cap (only losses count; resets at 00:00 UTC), per-job spend cap. A breach pauses and alerts.
- Kill switch: `/pause` and `/resume` on Telegram, plus the `CRUMBS_PAUSED` env flag (Telegram can't override it).
- Job-type approvals: new types register as `pending` and get Approve/Reject buttons on Telegram; unapproved types only ever run in shadow.
- SQLite ledger (`node:sqlite`, no native modules): job types, every attempt, state.
- Telegram bot (grammY): alerts, approvals, `/status`, `/jobs`, daily summary at 00:00 UTC.
- SOL → USDC sweeper (Jupiter), live mode only: keeps a SOL float for fees, converts the rest, optionally sends USDC to a cold wallet.
- **TukTuk adapter**, with hand-rolled decoding (no Anchor/Helium SDK) for compiled and remote tasks, follow-up task ids and lookup tables.
- 37 tests: profit guard maths with mainnet-derived fixtures, caps, kill switch, executor safety (shadow never sends, unapproved never sends, anomaly never sends), adapter builds against recorded mainnet accounts.

## Findings (Oct 30, mainnet)

- TukTuk has 11 queues and ~5,700 tasks. About 2,800 come due per 24h, almost all on Helium's `hpl-crons` queue, at a 15,000-lamport reward. A transaction costs ~5,000–10,150, so each crumb nets **~5,000–10,000 lamports**. The whole market is roughly **0.03 SOL/day**.
- One crank turner (`BcS9rq…YdYRM`, almost certainly Helium's) ran 24 of the 25 sampled transactions and fires at the exact due second. In two shadow runs every fresh task was gone by the time we built it. **Expect a low win rate on fresh tasks.**
- Our niche: **stuck tasks.** Tasks that fail (e.g. a fanout claim whose receiver has no token account) become *stale* after the queue's `stale_task_age` (48h on `hpl-crons`/`fanout-queue`). `run_task_v0` then pays the reward without executing the inner instructions. Crumbs retries stuck tasks every 60s and will collect when they turn stale.
- OpenBook v2 `consume_events`: no caller reward (the penalty goes to the market). Rejected.

## Next

- Pre-build TukTuk transactions ahead of the due time so only the final simulation runs at T (shave ~0.5s).
- Drift order-filler adapter (needs `@drift-labs/sdk`, a heavy dependency, so asking first; or a hand-rolled minimal client).
- Milestone 2: discovery engine (IDL fetch, Claude classification, deterministic validation, anomaly → disclosure draft).
- Milestone 3: dashboard (Vercel, fed by a JSON snapshot), share card, SOL/USD via Pyth.
- Render deployment (`render.yaml`, a background worker with a persistent disk for SQLite).

## Known issues

- Shadow-mode "would have earned" is optimistic: a profitable simulation doesn't mean we'd have won the race against Helium's crank turner.
- The Jupiter sweep is untested end to end (Jupiter is unreachable from the dev sandbox). Its decision logic is unit-tested. `lite-api.jup.ag` may need replacing with a keyed endpoint.
- Remote TukTuk tasks (40 of them, served by `hnt-rewards.oracle.helium.io`) couldn't be fetched from the dev sandbox. They should work on a normal connection.
- The executor processes candidates one at a time; fine at TukTuk's volume (~2/min), revisit for busier adapters.
