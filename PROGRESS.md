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

## v2 upgrade — Milestone 0: measure first (Oct 31)

- Every candidate now ends with exactly one **reason code** (`ReasonCode` in `src/core/types.ts`), counted per day and job type in a new `funnel` table with gross, cost and (for unprofitable jobs) shortfall sums. Stages: tries → simulated → simulated OK → profitable → sent → landed.
- Failed simulations are split: `gone_before_sim`, `taken_by_others`, `not_ready` (TukTuk TaskNotReady, 6005), `task_failing` (a stuck task's inner program fails), `sim_failed_other`. Checked against real mainnet simulations: TukTuk passes an inner program's error code on unchanged (a stuck fanout task fails with 3012, the same number as a task someone already ran), so the reason is read from *which program* failed first.
- Profitable but not sent: `shadow`, `unapproved`, `in_flight_limit`, `cap_blocked`, `send_error`. Sent: `landed`, `failed_onchain`, `lost_race` (bundle dropped and the task is gone), `not_included` (bundle dropped while the task is still open: outbid or late).
- Per-job timestamps: callable (due time) → picked up → simulated → sent → landed (slot and block time). For lost races the winner's transaction, signer and slot are read from the chain (verified to be a `run_task_v0` on that task, since task addresses are reused), at most once a minute for pre-send losses to save Helius credits. Our Oct 30 lost race: Helium's `BcS9…YdYRM` ran the task in the same slot, earlier in the block.
- Batching potential: how many unprofitable-alone jobs would clear the minimum if the base fee and tip were shared.
- The snapshot carries `funnel`, `latency` and `batchingPotential`; `npm run report -- <name>` turns the public snapshot into `reports/<name>.md`.
- Likely cause of "13 profitable vs 7 sent" to confirm in the baseline: dropped Jito bundles wait up to ~60-90s for their blockhash to expire while holding one of the 3 in-flight slots, so profitable jobs meanwhile were held back (now `in_flight_limit`).
- Existing databases are migrated in place (new columns added; history kept). 86 tests.

## v2 upgrade — feature switches and circuit breakers (Oct 31)

- `src/core/features.ts`: every way of making money is a feature with an on/off switch (`/features` on Telegram, saved in the ledger) and a circuit breaker. If its sends lose more than `BREAKER_THRESHOLD_LAMPORTS` (default 20,000) over the first 50 sends after it's switched on, or over any rolling hour, it switches itself off, alerts on Telegram with the numbers, and everything else keeps running. Dropped Jito bundles count as 0. The TukTuk adapter is the first feature (`adapter:tuktuk.run_task`). 92 tests.

## v2 upgrade — Milestone 1 research: batching TukTuk tasks (Oct 31)

Measured on mainnet (40 tasks sampled across the next 24h, plus 12 of Helium's own crank transactions):
- **The program allows it:** nothing in `run_task_v0` limits one run per transaction, and queues can mix. Remote tasks need their own ed25519 instruction immediately before each run (exactly one signature each), so they keep their extra 5,000-lamport signature fee in a batch.
- **It doesn't fit:** one task's transaction is already 805-931 bytes with the queue's lookup tables (Helium's own: 817-1,191 bytes). Two tasks overflow Solana's 1,232-byte limit. Helium's bot sends one task per transaction too.
- **Our own lookup table doesn't pay:** with every account in a table, 5 tasks would fit (625 bytes; compute ~250k per task caps it at 5 anyway). But 514 of the 529 accounts in the sample appear in only one task, so a table can't be reused: each batch needs new addresses. Creating, extending (~25 addresses per transaction), deactivating and closing a table costs about 7 transactions (35,000 lamports) per batch of 5, against 24,000 saved. Rent also has to be locked meanwhile: 0.0148 SOL for 85 addresses, 0.0426 SOL for a full table (the wallet holds ~0.025).
- **Contested tasks can't share a transaction:** a transaction succeeds or fails as a whole, so if Helium's bot takes one task, the whole batch drops.
- Conclusion: batching TukTuk in one transaction isn't worth building. Per-task cost is already at the floor (5,000 base fee + 1,000 minimum Jito tip, no priority fee). The levers left are winning more races and finding more job types.

## v2 upgrade — Milestones 1 and 2: faster and cheaper per task (Oct 31)

Batching doesn't work for TukTuk (see the research above), so with the owner's go-ahead Milestone 1 became "win more races for free". All of these are features with their own switch and circuit breaker, and ship **off** until `reports/baseline.md` is written, so the before/after is clean.

- **chain_clock:** TukTuk checks the chain's `Clock.unix_timestamp`, which runs 0.4-1.1 s behind wall time (measured on mainnet). Crumbs used to simulate at the wall-clock due second, often get "not ready", and wait a full second. Now it subscribes to the Clock sysvar over the Helius websocket (standard websockets are on the free plan, 2 credits per 0.1 MB: about 45k credits/month) and fires on the first slot whose clock reaches the due time. Falls back to the wall clock if the websocket is down.
- **fast_retry:** if a simulation still says "not ready" at the due second, retry every 150 ms (up to 8 times) instead of after 1 s.
- **jito_slots:** a dropped bundle used to hold one of only 3 send slots for up to ~90 s, until its blockhash expired. Now the slot is freed as soon as the task is seen gone twice, and up to 10 Jito sends may be pending (a lost bundle costs nothing). An early "lost" verdict is re-checked 90 s later and booked as landed if it did land.
- **parallel_jobs:** up to 4 jobs at once, each waiting for its own due time, so several tasks due in the same second don't queue behind each other.
- **adaptive_tip:** the Jito tip per job type is learned: ×1.5 after a bundle that wasn't included while the task was still open (outbid), ×1.25 after a lost race, ×0.9 after a win, never below 1,000 and never more than leaves `MIN_PROFIT_LAMPORTS` after fees (8,000 max on a 15,000 compiled task, 3,000 on a remote one).
- **live_tasks:** new TukTuk tasks arrive over the websocket; the full ~5,700-task re-read drops from every minute to every 10 minutes (saves ~390k Helius credits/month).
- Always on (fixes, not strategies): the blockhash is refreshed in the background so a due job never waits for it; a remembered compute measurement is only re-measured on a real compute error (a "not ready" no longer costs a second simulation).
- **Sending:** Helius Sender is credit-free on every plan, but its cheapest tier needs a 5,000-lamport tip and is a normal transaction (a lost race still pays the fee). Jito at 1,000 lamports with free losses is better for us, so no change. Staked connections via `mainnet.helius-rpc.com` are for paid plans.
- **Hosting:** Render Virginia ($7/month starter worker) is already close to Helius' east-coast nodes and Jito's New York block engine; the global Jito URL routes there. Moving would gain little; LaserStream/gRPC needs a $499/month plan. Recommendation: stay.
- The snapshot now carries feature switches with their P&L, the chain-clock lag and the learned tips. 99 tests.

## v2 upgrade — Milestone 3: job types and discovery ranking (Oct 31)

- **"tuktuk::run_task_v0 — Needs adapter" fixed:** that was discovery not recognising the instruction Crumbs already runs. `src/discovery/covered.ts` lists instructions with a dedicated adapter; discovery marks them `covered` (and skips validating them, saving RPC calls), and the feed relabels old rows. No new income there; it never was a separate job.
- **Ranking:** validation now measures how often an instruction is called (from the slots of recent calls) and scores it: average reward × calls per hour ÷ distinct callers. Lamports per hour we might win taking an equal share against each competitor. The discovery feed lists paid jobs by score, then the rest, then covered ones.
- **Kamino liquidations:** researched, not built. See `reports/kamino-liquidations.md`. $408M borrowed in the main market, but no liquidation in a 2 h sample, heavy professional competition, flash-loan + swap transactions, and a ~300 MB SDK. Recommendation: not at our size.
- 101 tests.

## v2 upgrade — Milestone 4: dashboard and pitch (Oct 31)

- Dashboard: **Where the jobs go** funnel (tries → simulated → simulated OK → profitable → sent → landed) with every drop-off reason; fees as a share of what protocols paid, per day; race win rate per day; **Speed** medians (callable → start, simulate, send, land; when lost-race winners landed; chain-clock lag; who beats us); **Before and after v2** (earnings per hour, fee share, race win rate, net) with the batching finding; **Switches and circuit breakers** with each feature's sends and P&L and the learned Jito tip. Crumb-sized amounts show in lamports with USD alongside. Discovery shows opportunity scores and "Already running".
- The snapshot carries daily fees and dropped bundles, and a before/after split at `v2_since` (saved the first time a v2 feature is on).
- First live measurements (Oct 31, ~1 h): Crumbs started on a job a median 1.4 s after it became callable and sent at 1.7 s; Helium's crank bot (`BcS9…YdYRM`) won 14 of 15 sampled races, landing within the same second.
- `DEMO.md` (3-minute script) and README (v2 story, threat model) updated. Checked at desktop and phone widths, light and dark, no horizontal overflow; production build passes. 101 tests.

## Next

- ~06:40 UTC Oct 31: write `reports/baseline.md` from the live snapshot, then switch the v2 features on and compare.
- Submission text for Encode (Nov 8) and UBC (Nov 20).
- Optional: a watch-only Kamino liquidation counter (no sends) if the owner wants to see missed opportunities in volatile markets.

## Known issues

- Replay validation can only prove jobs that work on *shared* state (recurring cranks). One-shot jobs are flagged as proposals for a dedicated adapter.
- Third-party fund detection checks up to 40 writable accounts per transaction and only top-level instructions of the reference call.
- Token rewards other than SOL are reported as `unknown_balance_effect` until a price feed is added (M3).

- Shadow-mode "would have earned" is optimistic: a profitable simulation doesn't mean we'd have won the race against Helium's crank turner.
- The Jupiter sweep is untested end to end (Jupiter is unreachable from the dev sandbox). Its decision logic is unit-tested. `lite-api.jup.ag` may need replacing with a keyed endpoint.
- Remote TukTuk tasks (40 of them, served by `hnt-rewards.oracle.helium.io`) couldn't be fetched from the dev sandbox. They should work on a normal connection.
- The executor processes candidates one at a time; fine at TukTuk's volume (~2/min), revisit for busier adapters.
