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

## Done — Milestone 3 (dashboard and alerts)

- Snapshot builder (`src/dashboard/snapshot.ts`): all-time totals, win rate, 30-day daily series, per-job-type earnings, recent sent and shadow attempts, discovery feed. Written to `data/snapshot.json` and pushed every minute to the dashboard (`DASHBOARD_URL`, `DASHBOARD_SECRET`).
- SOL/USD from Pyth's on-chain PriceUpdateV2 account (owner and feed id checked); also feeds the profit guard's price book so USDC rewards are valued.
- Dashboard app (`dashboard/`, Next.js 16, separate package so the phone never installs it): KPI tiles, daily live vs shadow bar chart (hand-rolled SVG, palette validated for colour blindness in light and dark, hover tooltips, table view), jobs by type, wallet with Solscan link, recent activity with tx links, discovery feed with status labels, share line with copy, a share card image (`/api/card`, also the social preview) and a public raw-data endpoint. The secret-protected POST stores the snapshot in a private Vercel Blob.
- Telegram: `/share`; the daily summary includes the share line and the dashboard link.
- Checked in light and dark mode and at phone width (no horizontal page overflow); production build passes.
- Fixed: tiny amounts (under 1e-6 SOL) were rounded to "0" in share text and the dashboard; every lamport is now kept.
- 60 tests.

## Done: going live and hosting

- `/live` (go-live checklist plus a confirm button; it re-checks at the moment of the tap) and `/shadow` on Telegram. The mode is saved in the ledger, so it survives restarts. Blockers: no wallet key, balance below 0.002 SOL or above the wallet cap, the env kill switch. The owner waived the 24h shadow run.
- `/jobs` now has Approve buttons for pending job types.
- Heartbeat log every 5 minutes.
- Hosting: `scripts/server-setup.sh` (any Debian/Ubuntu VM: Node 22, swap, build, systemd service with auto-restart) and DEPLOY.md (Google Cloud e2-micro free tier, Oracle, Render). `render.yaml` covers the paid Render route with a persistent disk.
- 65 tests.

## Done: faster, smarter job hunting

- **Prepared ahead:** the TukTuk adapter builds each transaction up to 10s before the task is due (or turns stale), so at the moment only the final simulation and the send remain. A prepared transaction is used once; retries rebuild from fresh state.
- **Fewer round trips at the due second:** compute measured once per kind of job (`cuKey`) and remembered (re-measured if a run fails); the priority fee is cached for 10s and the balance for 20s; the fee is computed locally (no getFeeForMessage); the pre-balance and the final simulation run in parallel; the schedule refreshes in the background; confirmations run in the background (at most 3 in flight), so the next job never waits 1-2s. The heartbeat reports ms per job and how late after due we sent.
- **Stuck tasks:** each task gets a fire time. Fresh tasks fire at their due time. Stuck tasks (overdue but still on-chain) are rechecked every 10 minutes instead of every minute, and are aimed at the exact second they turn stale (due + queue `stale_task_age` + 1), when `run_task_v0` pays without running them. Queue stale ages are read with each schedule refresh.
- **Claude for uncontested jobs:** recent-deploy scanning is back on, with a daily Claude budget (`DISCOVERY_DAILY_BUDGET_USD`, default $0.25) computed from real token usage and persisted per UTC day; paid-for classifications are free to reuse. Validation reports the competition (how many different wallets made the recent calls) in the Telegram evidence.
- Render: `render.yaml` now runs in Virginia with discovery on; DEPLOY.md has the step-by-step guide.
- 72 tests.

## Findings (Oct 30, Render)

- Crumbs runs on Render (Virginia) in live mode. The first deploy crashed because the wallet key was pasted without its [ ] brackets; the key parser now accepts any pasted form (JSON with or without brackets, base58) and never echoes the key in errors.
- Helius rejects `getSignaturesForAddress` on the BPF upgradeable loader ("Address is not supported"), so recent-deploy discovery found nothing. It now reads every ProgramData account's last-deploy slot in one getProgramAccounts call on the public RPC (`DISCOVERY_LISTING_RPC_URL`, ~23.5k programs, ~6 MB), takes the 40 newest and maps each back to its program with a tiny exact-match lookup. A first version listed all ~80k program accounts (18 MB, hundreds of MB once parsed) and ran Render's 512 MB instance out of memory; the listing now parses the raw response by hand (peak +25 MB, 8 s), and `npm start` caps the heap at 384 MB.
- Newer Anchor programs publish their IDL through the **Program Metadata program** (`ProgM6JC…`): 820 canonical "idl" accounts on mainnet versus few new legacy IDL accounts. Crumbs now reads both. The header layout was verified against real accounts (enums at bytes 83-86, length at 87; data inline, UTF-8, zlib, JSON), with a recorded fixture and a test. Of the 30 newest programs, 1 published an IDL (122 instructions, 25 passing the signer screen): most fresh deploys are bots or tests and are skipped at no Claude cost.

## First live transaction and Jito (Oct 30)

- First live send: a fresh TukTuk task at its due second (expected +9,856). Helium's crank turner landed first; ours landed after and failed, and the fee was still charged: **−5,144 lamports**. Racing ~2,800 fresh tasks/day like that could bleed ~0.014 SOL/day, under the 0.02 cap.
- Fix: send through **Jito bundles** (`JITO_ENABLED`, default on). A bundle only lands if its transaction succeeds, so a lost race is dropped with no fee; we pay base fee + tip (`JITO_TIP_LAMPORTS`, default 1000, Jito's minimum) only on a win, and the tip replaces the priority fee. The tip is inside the transaction, so the profit guard counts it. Unseen bundles are settled as `dropped` (net 0) once their blockhash expires. Tip accounts come from `getTipAccounts`, with the Oct 30 list as fallback.
- Market check (Jito tip floor, Oct 30): median landed tip ≈ 74k lamports, 25th percentile 10k, so a 1,000-lamport bundle will often be outbid. That's acceptable here: losing costs nothing.
- Render now sets `DAILY_LOSS_CAP_SOL=0.005` as a backstop for the small wallet. 78 tests.

## Findings (Oct 30, mainnet)

- **First real discovery pass (Claude, 4 seed programs, 43 instructions classified):** Claude picked out TukTuk `run_task_v0` (confidence 0.85) as the paid crank. Validation confirmed 3/3 recent callers earned 15,000 lamports and classed it *paid_not_replayable* (one-shot tasks), which matches what we found by hand in M1. Claude marked every hpl-crons and fanout instruction as not a job, and 2 Kamino instructions as worth validating.
- That pass hit two bugs, now fixed: (1) ~40% of recent Kamino transactions use Solana's new transaction version 1, which web3.js v1 can't decode, and that aborted the program's scan. Such transactions are now skipped. (2) A program whose scan failed would have been re-classified, paying Claude again. Classifications are now cached per IDL version.
- Telegram 403 "bots can't send messages to bots": TELEGRAM_CHAT_ID was set to the bot's own id. Startup now detects this, and `npm run telegram-setup` finds the right id.

- **Drift / Velocity:** no adapter. Drift was exploited on Apr 1, 2026 and froze; its successor Velocity uses the same program, which has had zero fills in 54 days (only ~1,000 transactions, mostly failed). Revisit if Velocity opens to the public.
- `validate-ix` on TukTuk `run_task_v0`: 3/3 recent callers earned 15,000 lamports gross, but replays fail because each task is consumed when run. This is correctly classed as *paid_not_replayable*: it needs a dedicated adapter, which is the TukTuk adapter we already have.

- TukTuk has 11 queues and ~5,700 tasks. About 2,800 come due per 24h, almost all on Helium's `hpl-crons` queue, at a 15,000-lamport reward. A transaction costs ~5,000–10,150, so each crumb nets **~5,000–10,000 lamports**. The whole market is roughly **0.03 SOL/day**.
- One crank turner (`BcS9rq…YdYRM`, almost certainly Helium's) ran 24 of the 25 sampled transactions and fires at the exact due second. In two shadow runs every fresh task was gone by the time we built it. **Expect a low win rate on fresh tasks.**
- Our niche: **stuck tasks.** Tasks that fail (e.g. a fanout claim whose receiver has no token account) become *stale* after the queue's `stale_task_age` (48h on `hpl-crons`/`fanout-queue`). `run_task_v0` then pays the reward without executing the inner instructions. Crumbs retries stuck tasks every 60s and will collect when they turn stale.
- OpenBook v2 `consume_events`: no caller reward (the penalty goes to the market). Rejected.

## Next

- First full discovery pass with Claude over the seed programs (needs ANTHROPIC_API_KEY).
- Kamino flash-loan liquidation adapter (option A).
- Deploy the dashboard on Vercel and set DASHBOARD_URL / DASHBOARD_SECRET on the agent.
- Render deployment (`render.yaml`, a background worker with a persistent disk for SQLite).

## Known issues

- Replay validation can only prove jobs that work on *shared* state (recurring cranks). One-shot jobs are flagged as proposals for a dedicated adapter.
- Third-party fund detection checks up to 40 writable accounts per transaction and only top-level instructions of the reference call.
- Token rewards other than SOL are reported as `unknown_balance_effect` until a price feed is added (M3).

- Shadow-mode "would have earned" is optimistic: a profitable simulation doesn't mean we'd have won the race against Helium's crank turner.
- The Jupiter sweep is untested end to end (Jupiter is unreachable from the dev sandbox). Its decision logic is unit-tested. `lite-api.jup.ag` may need replacing with a keyed endpoint.
- Remote TukTuk tasks (40 of them, served by `hnt-rewards.oracle.helium.io`) couldn't be fetched from the dev sandbox. They should work on a normal connection.
- The executor processes candidates one at a time; fine at TukTuk's volume (~2/min), revisit for busier adapters.
