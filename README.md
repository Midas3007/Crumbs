# 🍞 Crumbs

**The agent that eats the crumbs the big bots leave behind.**

Solana protocols pay strangers to do their chores: run scheduled tasks, settle markets, liquidate unhealthy
positions, close expired accounts. Big MEV bots chase the big jobs. Crumbs is an autonomous agent with its own
small wallet that finds these paid, permissionless chores, **proves each one is profitable by simulating it
first**, and only executes the ones that earn money after every fee. It runs inside hard spending limits that
its owner controls from Telegram.

> Status: Milestone 1 (executor core + first adapter, shadow mode). See [PROGRESS.md](PROGRESS.md).

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

Fill in `.env`: `HELIUS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Send about 0.01 SOL to the wallet
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
| `npm run approve -- <type> [reject]` | Approve a job type without Telegram (no args lists them) |
| `npm run record-fixtures` | Re-record the test fixtures from mainnet |

## Add an adapter

Implement `Job` from [src/core/types.ts](src/core/types.ts):

- `detect()` returns candidates with a stable `id`.
- `build(candidate, agent)` returns the instructions and the protocol's **documented** reward
  (`expectedRewardLamports`, which the anomaly guard uses). Throw `JobGone` if someone else already did the work.

Simulation, the profit guard, caps and execution are shared, so every adapter is held to the same rules. Register
the adapter in [src/index.ts](src/index.ts). It runs in shadow mode until you approve it on Telegram.
