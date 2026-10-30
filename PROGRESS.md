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

## Done — Milestone 2 (discovery engine)

- IDL fetch for both Anchor formats (0.30+ spec and legacy), from the on-chain IDL account.
- Program sources: manual list (`discovery/programs.json`, `DISCOVERY_PROGRAMS`) and recently deployed or upgraded programs (read from the upgradeable loader's transactions).
- Deterministic signer screen before any AI call (single unconstrained signer, chore-like names).
- Claude classifier (`claude-sonnet-5-5`, JSON-schema structured output, cached system prompt, server-side refusal fallback) producing `JobCandidate`s. Unknown instruction names are discarded. A `--no-ai` heuristic mode is available.
- Validation by replaying real recent mainnet calls with our wallet as the caller, with outcomes validated / paid_not_replayable / unprofitable / failed / no_live_trigger / anomaly.
- Third-party fund guard: system-owned wallets losing lamports, or token accounts with an on-curve (human) authority losing tokens → anomaly.
- Over-payment guard: a replay paying more than 1.5× what recent callers earned → anomaly.
- Disclosure drafts (markdown, fork reproduction steps, suggested fix) saved to `data/disclosures/` and sent as a Telegram document.
- Approved discoveries run autonomously as `ReplayJob`s through the same executor, profit guard and caps.
- Credit alerts: Claude out of credits (stops the discovery pass) and RPC quota or credit errors (watched on every RPC response), each throttled, with a recovery message.
- 53 tests in total.

## Findings (Oct 30, mainnet)

- **Drift / Velocity:** no adapter. Drift was exploited on Apr 1, 2026 and froze; its successor Velocity uses the same program, which has had zero fills in 54 days (only ~1,000 transactions, mostly failed). Revisit if Velocity opens to the public.
- `validate-ix` on TukTuk `run_task_v0`: 3/3 recent callers earned 15,000 lamports gross, but replays fail because each task is consumed when run. This is correctly classed as *paid_not_replayable*: it needs a dedicated adapter, which is the TukTuk adapter we already have.

- TukTuk has 11 queues and ~5,700 tasks. About 2,800 come due per 24h, almost all on Helium's `hpl-crons` queue, at a 15,000-lamport reward. A transaction costs ~5,000–10,150, so each crumb nets **~5,000–10,000 lamports**. The whole market is roughly **0.03 SOL/day**.
- One crank turner (`BcS9rq…YdYRM`, almost certainly Helium's) ran 24 of the 25 sampled transactions and fires at the exact due second. In two shadow runs every fresh task was gone by the time we built it. **Expect a low win rate on fresh tasks.**
- Our niche: **stuck tasks.** Tasks that fail (e.g. a fanout claim whose receiver has no token account) become *stale* after the queue's `stale_task_age` (48h on `hpl-crons`/`fanout-queue`). `run_task_v0` then pays the reward without executing the inner instructions. Crumbs retries stuck tasks every 60s and will collect when they turn stale.
- OpenBook v2 `consume_events`: no caller reward (the penalty goes to the market). Rejected.

## Next

- Pre-build TukTuk transactions ahead of the due time so only the final simulation runs at T (shave ~0.5s).
- First full discovery pass with Claude over the seed programs (needs ANTHROPIC_API_KEY).
- Kamino flash-loan liquidation adapter (option A).
- Milestone 3: dashboard (Vercel, fed by a JSON snapshot), share card, SOL/USD via Pyth.
- Render deployment (`render.yaml`, a background worker with a persistent disk for SQLite).

## Known issues

- Replay validation can only prove jobs that work on *shared* state (recurring cranks). One-shot jobs are flagged as proposals for a dedicated adapter.
- Third-party fund detection checks up to 40 writable accounts per transaction and only top-level instructions of the reference call.
- Token rewards other than SOL are reported as `unknown_balance_effect` until a price feed is added (M3).

- Shadow-mode "would have earned" is optimistic: a profitable simulation doesn't mean we'd have won the race against Helium's crank turner.
- The Jupiter sweep is untested end to end (Jupiter is unreachable from the dev sandbox). Its decision logic is unit-tested. `lite-api.jup.ag` may need replacing with a keyed endpoint.
- Remote TukTuk tasks (40 of them, served by `hnt-rewards.oracle.helium.io`) couldn't be fetched from the dev sandbox. They should work on a normal connection.
- The executor processes candidates one at a time; fine at TukTuk's volume (~2/min), revisit for busier adapters.
