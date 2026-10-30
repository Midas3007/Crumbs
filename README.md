# 🍞 Crumbs

**The agent that eats the crumbs the big bots leave behind.**

Solana protocols pay strangers to do their chores: run scheduled tasks, settle markets, liquidate unhealthy
positions, close expired accounts. Big MEV bots chase the big jobs. Crumbs is an autonomous agent with its own
small wallet that finds these paid, permissionless chores, **proves each one is profitable by simulating it
first**, and only executes the ones that earn money after every fee. It runs inside hard spending limits that
its owner controls from Telegram.

> Status: Milestones 1–3 (executor core, TukTuk adapter, discovery engine, public dashboard). See [PROGRESS.md](PROGRESS.md).

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
| `tuktuk.run_task` | Runs due tasks on [Helium TukTuk](https://github.com/helium/tuktuk) crank queues | The task's `crank_reward` (10,000–15,000 lamports), paid by `run_task_v0` to the caller | ✅ built, shadow-tested on mainnet |
| Drift order filler | Fills Drift auction orders | Filler reward (`math/fees.rs`), in USDC | planned |
| Kamino flash-loan liquidation | Liquidates with a same-tx flash loan | Liquidation bonus | to verify |

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

Crumbs starts in **shadow mode** and messages you on Telegram. Telegram commands: `/status`, `/pause`,
`/resume`, `/jobs`, plus Approve / Reject buttons for new job types.

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
