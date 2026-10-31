# 🍞 Crumbs

**The agent that eats the crumbs the big bots leave behind.**

*To get the bread, you need to eat the crumbs.*

Solana protocols pay strangers to do their chores: run scheduled tasks, settle markets, liquidate unhealthy
positions, close expired accounts. Big MEV bots chase the big jobs. Crumbs is an autonomous agent with its own
small wallet that finds these paid, permissionless chores, **proves each one is profitable by simulating it
first**, and only executes the ones that earn money after every fee. It runs inside hard spending limits that
its owner controls from Telegram.

> **Live dashboard: [crumbs-midart.vercel.app](https://crumbs-midart.vercel.app)** · wallet [G3ZwBYGo…FRxeKbV](https://solscan.io/account/G3ZwBYGoMXGgt4wunRjWSNkyB3J9sgUPxNq8CFRxeKbV)
>
> Status: **live on mainnet** since Oct 30, 2026, earning from Helium TukTuk tasks. v2 (measure → win more races) is in.
> See [PROGRESS.md](PROGRESS.md), the 3-minute [DEMO.md](DEMO.md), and [reports/](reports/).

## Hard rules

- Only call instructions a protocol **designed** to be called by anyone for a reward. No exploits, no
  front-running or sandwiching users, never touching other users' funds outside the documented keeper flow.
- **Every transaction is simulated first.** It's sent only if the agent wallet's balance change, after the base
  fee, priority fee and any tip, is at least `MIN_PROFIT_LAMPORTS`.
- **Small hot wallet** (`WALLET_CAP_SOL`), a **daily loss cap** and a **per-job spend cap**. Breaching one pauses
  the agent and alerts the owner.
- **New job types need one-tap approval** on Telegram before they go live. Until then they run in shadow mode.
- **Shadow mode first**: everything except sending, with a log of what it would have earned.
- **Bugs become bounties, not exploits**: a simulation that pays far more than documented is never executed.

## v2: measure first, then win more races

The first live hours told a clear story: Crumbs found profitable jobs, but most were taken first by Helium's own
crank bot, and fees looked like two-thirds of income. v2 started by **measuring**, then fixed what the numbers showed.

1. **Measure** ([reports/baseline.md](reports/baseline.md)): every job ends with one reason code (not ready yet,
   taken by another bot, stuck task, unprofitable by how much, lost race, outbid, landed...). Each job is timed from the
   moment it becomes callable to landing, and for lost races the winner's signer and slot are read from the chain.
   Finding: Crumbs started a median **1.4 s** after a task became callable; Helium's bot lands **in that same second**.
2. **Batching was researched and rejected** with numbers: two TukTuk tasks overflow Solana's 1,232-byte transaction
   limit, and our own lookup table costs more per batch than batching saves (97% of accounts are unique per task).
   Per-task cost is already at the floor: 5,000 base fee + Jito's 1,000 minimum tip, and a lost race costs 0.
3. **Faster, for free** (each behind its own switch and circuit breaker): fire on the **chain's own clock** over the
   websocket (it runs 0.4-1.1 s behind wall time, and that's what TukTuk checks), retry "not ready" every 150 ms,
   **free a send slot the moment a race is lost** (it used to block one of 3 slots for ~90 s), work on 4 jobs at once,
   **learn the Jito tip** per job type from wins and losses, and get new tasks over the websocket instead of re-reading
   5,700 tasks a minute (also saves ~390k Helium credits a month).
4. **Discovery ranks** paid instructions by reward × calls per hour ÷ competitors, so adapters get built where Crumbs
   can win. Kamino liquidations were researched and not built: [reports/kamino-liquidations.md](reports/kamino-liquidations.md).

Every change can be switched off from Telegram (`/features`) and **switches itself off if it loses money**: more than
20,000 lamports over its first 50 sends or any rolling hour. The dashboard shows the funnel, fee share, race win rate,
speed and a before/after table against the baseline.

## Threat model

| Risk | What could happen | Mitigation |
|---|---|---|
| Stolen hot-wallet key | Funds in the wallet are lost | Small wallet (`WALLET_CAP_SOL`; ~0.025 SOL in practice); key only in `keys/` or a Render Secret File, never logged or committed (`.gitignore`, the parser never echoes it); earnings swept to USDC |
| Losing races | Fees paid for transactions that fail | Jito bundles only land if they succeed, so a lost race costs nothing; daily loss cap pauses the agent (`DAILY_LOSS_CAP_SOL`) |
| A new feature misbehaves | Slow bleed of fees | Per-feature circuit breaker (first 50 sends, rolling hour) switches only that feature off and alerts |
| Malicious or buggy protocol | A "reward" that drains us, or pays from someone else | Every send is simulated with our real wallet; only the simulated balance change counts; spend cap per job; payouts above 1.5× the documented reward are never executed (anomaly → disclosure draft); discovery's replay flags any third-party wallet or user token account losing funds |
| AI mistakes | Claude calls a harmful instruction a "job" | Claude only proposes. Deterministic signer screen before it and on-chain replay after it; a human approves every new job type on Telegram; Claude is never in the execution path |
| Remote task servers (TukTuk) | A server hands us accounts that escalate privileges | Only HTTPS; signer flags from the server are dropped; the result is still simulated and profit-checked |
| RPC or price feed lies | Wrong simulation or USD value | Profit is measured in lamports from the simulation; USD is display only; Pyth account owner and feed id are checked |
| Telegram account hijack | Someone approves jobs or goes live | Only the configured chat id is obeyed; `CRUMBS_PAUSED=true` on the server overrides Telegram; caps can't be raised from Telegram |
| Ethics | Front-running or sandwiching users | Only keeper instructions protocols designed for anyone to call; no mempool watching of user transactions; no liquidations of users' funds outside the protocol's documented flow |

## How a job runs

```
detect()  ──►  build()  ──►  simulate (twice)  ──►  profit guard  ──►  caps + kill switch  ──►  send  ──►  book real P&L
  adapter        adapter       measure CUs, then       net ≥ min?          paused? over cap?        live mode    read back from chain
                               the exact final tx      ≤ spend cap?        daily loss hit?          + approved
                                                       not an anomaly?
```

The profit guard ([src/core/profitGuard.ts](src/core/profitGuard.ts)) is a pure function. It reads the agent's
balance before and after the simulated transaction (the simulated balance already includes fees; we checked this on
mainnet), values any token changes, and returns one verdict: `profitable`, `below_min_profit`,
`over_job_spend_cap`, `simulation_failed`, `unknown_balance_effect` or `anomaly`. No AI is involved in this path.

## Discovery: finding new paid chores

```
on-chain IDLs  ──►  signer screen  ──►  Claude classifies  ──►  replay real calls  ──►  Telegram
(manual list +      (one signer, not     (permissionless?       with OUR wallet as      approve /
 recent deploys)     an admin/owner)      pays caller? harms     caller, simulate        proposal /
                                          users? trigger?)       (deterministic)         disclosure
```

1. **Programs:** [discovery/programs.json](discovery/programs.json) (add any program id) plus programs deployed or upgraded recently.
2. **Signer screen** (no AI): keep instructions with exactly one signer that isn't constrained to be a specific account.
3. **Claude** (`claude-sonnet-5-5`, structured output) reads each remaining instruction and returns a `JobCandidate`:
   permissionless?, pays the caller?, could it harm users?, trigger, reward source, account hints, confidence, evidence.
   Claude is never in the execution path; it only proposes.
4. **Deterministic validation:** find recent successful mainnet calls of the instruction, swap in our wallet (and our token
   accounts) as the caller, and simulate:
   - **validated**: the replay is profitable now and nobody else's funds move → one-tap approval on Telegram, then it runs
     autonomously as a replay job (still behind the profit guard and caps)
   - **paid_not_replayable**: real callers get paid but each call uses up its work (one-shot tasks, liquidations) →
     sent as an *adapter proposal*
   - **anomaly**: the replay moves a third-party wallet's funds, or pays far more than recent callers earned → **never
     executed**; a responsible-disclosure draft (what, how to reproduce on a fork, suggested fix) is saved to
     `data/disclosures/` and sent to you
5. An unchanged IDL is never re-classified, to save API credits.

If the Claude API or Helius runs out of credits, you get one Telegram alert (repeated at most every 6 hours) and an
"it's working again" message when it recovers.

## Dashboard and alerts

- **Public dashboard** ([dashboard/](dashboard/README.md), Next.js on Vercel): net P&L in SOL and USD, crumbs eaten, win
  rate of sent transactions, fees paid, daily live vs shadow earnings chart, jobs by type, recent transactions linked to
  Solscan, the wallet address, the discovery feed and a share card. The agent pushes a JSON snapshot every minute.
- **USD prices** come from Pyth's SOL/USD account on-chain, read over the same RPC, so they're verifiable and need no extra service.
  The same price lets the profit guard value USDC rewards.
- **Telegram:** daily summary with the share line and the dashboard link, `/share`, approvals, cap and pause alerts,
  anomaly disclosures, and credit alerts.

## Adapters

| Adapter | What it does | Reward | Status |
|---|---|---|---|
| `tuktuk.run_task` | Runs due and stuck tasks on [Helium TukTuk](https://github.com/helium/tuktuk) crank queues | The task's `crank_reward` (10,000–15,000 lamports), paid by `run_task_v0` to the caller | ✅ live on mainnet |
| Drift order filler | Fills Drift auction orders | Filler reward, in USDC | ❌ Drift was exploited and frozen in April 2026; its successor has had no fills |
| Kamino liquidation | Liquidates with a same-tx flash loan | Liquidation bonus | ❌ researched, not a fit at our size ([report](reports/kamino-liquidations.md)) |

OpenBook v2 `consume_events` was rejected: its event-heap penalty goes to the market, not to whoever runs the crank.

## Run it

Needs Node ≥ 22.13 (it uses the built-in `node:sqlite`, so there are no native modules to compile).

**Android phone (Termux):**

```bash
pkg install nodejs-lts git
```

```bash
git clone https://github.com/Midas3007/Crumbs && cd Crumbs && npm install
```

**Any machine:**

```bash
cp .env.example .env
```

```bash
npm run new-wallet
```

Fill in `.env`: `HELIUS_API_KEY`, `TELEGRAM_BOT_TOKEN`, then message your bot and run `npm run telegram-setup` to get `TELEGRAM_CHAT_ID`. Send about 0.01 SOL to the wallet
address so simulations have a fee payer. Then:

```bash
npm run dev
```

Crumbs starts in **shadow mode** and messages you on Telegram. Telegram commands: `/live` (go-live checklist and a
confirm button), `/shadow`, `/status`, `/pause`, `/resume`, `/jobs` (with Approve buttons), `/share`.

To run it 24/7 on a free server (or Render), see [DEPLOY.md](DEPLOY.md).

Useful scripts:

| Command | What it does |
|---|---|
| `npm test` | Unit tests: profit guard, caps, kill switch, executor safety, adapter builds against recorded mainnet accounts |
| `npm run survey` | Snapshot of the TukTuk market: queues, rewards, how much work is due |
| `npm run simulate-task -- <task>` | Build and simulate one TukTuk task, print the program logs |
| `npm run discover` | Run one discovery pass now (`-- <programId>` for specific programs, `--recent` for new deploys, `--no-ai` to skip Claude) |
| `npm run validate-ix -- <program> <instruction>` | Replay recent real calls of one instruction with your wallet and report what it would earn |
| `npm run telegram-setup` | Find your Telegram chat id and send a test message (stop Crumbs first, message your bot, then run it) |
| `npm run export-key` | Print the agent's private key for an offline backup |
| `npm run approve -- <type> [reject]` | Approve a job type without Telegram (no args lists them) |
| `npm run record-fixtures` | Re-record the test fixtures from mainnet |

## Add an adapter

Implement `Job` from [src/core/types.ts](src/core/types.ts):

- `detect()` returns candidates with a stable `id`.
- `build(candidate, agent)` returns the instructions and the protocol's **documented** reward
  (`expectedRewardLamports`, which the anomaly guard uses). Throw `JobGone` if someone else already did the work.

Simulation, the profit guard, caps and execution are shared, so every adapter is held to the same rules. Register
the adapter in [src/index.ts](src/index.ts). It runs in shadow mode until you approve it on Telegram.
