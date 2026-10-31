# Crumbs: 3-minute demo

Open the [live dashboard](https://crumbs-midart.vercel.app) and Telegram side by side.

## 0:00 – The idea (20 s)

> Solana protocols pay strangers to do their chores: run scheduled tasks, crank queues, liquidate loans. The big bots
> chase the big jobs. Crumbs is an autonomous agent with a tiny wallet that eats the crumbs they leave behind.
> To get the bread, you need to eat the crumbs.

Point at the header: **Live**, the wallet link to Solscan, the SOL price read from Pyth on-chain.

## 0:20 – It's real money, on mainnet (30 s)

- KPIs: net earned, crumbs eaten, win rate, fees. Click a **Landed** row in Recent activity: it opens Solscan, and the
  log line says `Paying out reward 15000` to our wallet.
- Point at the one **Lost race** at −5,144 lamports: "Our first live send lost a race to Helium's own bot, and Solana
  still charged the fee. So we moved sending to **Jito bundles**: a bundle only lands if it succeeds, so a lost race now
  costs nothing."

## 0:50 – Safety first (30 s)

> Every transaction is simulated with our own wallet before it's sent, and sent only if it profits after every fee.

- Hard caps: small hot wallet, daily loss cap, per-job spend cap, kill switch (`/pause` on Telegram).
- New job types need one tap on Telegram. Show `/jobs`.
- Too good to be true is never executed: a payout above 1.5× the documented reward becomes a bug-bounty disclosure
  draft, not a trade.

## 1:20 – v2: measure, then fix (50 s)

Scroll to **Where the jobs go**:

> Instead of guessing why we lose, every job now ends with a reason code. Thousands of tries, a handful landed, and you
> can see exactly where each one dropped out: already done by another bot, not callable yet on-chain, stuck tasks.

**Speed** card:

> We started on a job 1.4 seconds after it became callable. Helium's bot lands in that same second. We even read who
> beats us from the chain.

> Batching looked like the obvious fix for fees, so we measured it: two tasks don't fit in one Solana transaction. Fees
> are already at the floor. The real lever was speed.

**Switches and circuit breakers** card:

> So v2 fires on the chain's own clock over a websocket, retries every 150 ms, frees send slots the instant a race is
> lost, and learns its Jito tip. Each of these is a switch on Telegram, and each turns itself off if it loses money.

Then **Before and after v2**: earnings per hour, fee share and race win rate, baseline vs v2.

## 2:10 – Claude finds new jobs (35 s)

Scroll to **Discovery feed**:

> Claude reads on-chain IDLs of new programs and proposes paid chores. It's never in the execution path: a
> deterministic replay with our wallet decides, and I approve on Telegram. Discovery ranks jobs by reward × frequency ÷
> competition, so we build where nobody's racing us. It already knows TukTuk is covered, and it researched Kamino
> liquidations and said no: too contested for a tiny wallet.

Mention the Claude budget: $0.25/day from real token usage, with an alert if credits run out.

## 2:45 – Close (15 s)

> Crumbs is open, verifiable on Solscan, and safe by construction. Same agent, more chains next: the adapters are
> small, and the safety core doesn't change.

Click **Share card**.

## If something goes wrong live

- Dashboard says "agent may be offline": Render restarted; it's back within a minute. The numbers are still real.
- Nothing landed recently: open the funnel. "Already done by another bot" explains it, and it costs us nothing.
