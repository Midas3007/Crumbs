# Crumbs: hackathon submission text

Copy-paste blocks for the forms. Numbers marked *(live)* should be refreshed from the dashboard on the day you submit.
Fill in the bits in [brackets].

---

## Short fields

**Project name:** Crumbs

**Tagline (≤ 80 chars):** An autonomous Solana agent that earns the keeper rewards protocols pay strangers.

**One-liner:** Crumbs finds paid, permissionless chores on Solana, proves each is profitable by simulating it with its own wallet, and only executes the ones that earn after every fee, inside hard spending limits its owner controls from Telegram.

**Motto:** To get the bread, you need to eat the crumbs.

**Links**
- Live dashboard: https://crumbs-midart.vercel.app
- Agent wallet (every transaction verifiable): https://solscan.io/account/G3ZwBYGoMXGgt4wunRjWSNkyB3J9sgUPxNq8CFRxeKbV
- Raw data: https://crumbs-midart.vercel.app/api/snapshot
- Code: https://github.com/Midas3007/Crumbs [make public before submitting]
- Demo video: [link]

---

## Description (long)

**The problem.** Solana protocols run on chores: scheduled tasks, queue cranks, liquidations, account cleanup. Many pay
*anyone* a small reward for doing them. The big bots chase the big jobs; the small, long-tail ones are either done by a
single incumbent or left undone. Nobody runs a safe, autonomous agent that hunts for these crumbs, and doing it by hand
loses money on fees.

**What Crumbs does.** Crumbs is an autonomous agent with its own small wallet. It:
1. **Finds work**: adapters watch protocols (live today: Helium TukTuk crank queues, ~2,800 paid tasks a day), and a
   discovery engine uses Claude to read on-chain program IDLs and propose new paid, permissionless instructions.
2. **Proves profit before acting**: every transaction is simulated with the agent's real wallet. It is sent only if the
   wallet's balance change, after base fee, priority fee and tip, clears a minimum profit. No AI in this path: a pure,
   tested function decides.
3. **Pays to land, never to lose**: transactions go out as Jito bundles, which only land if they succeed, so a lost race
   costs nothing.
4. **Converts earnings**: ¾ of every lamport earned is swapped to USDC so earnings don't swing with SOL's price.
5. **Reports honestly**: a public dashboard shows every job's fate (a funnel with a reason code for every drop-off),
   fees as a share of rewards, race win rate, speed, and a before/after view of each improvement.

**Safety by construction.** Small hot wallet with a cap, daily loss cap, per-job spend cap, a kill switch on Telegram
and on the server. Every money-making feature has an on/off switch and a circuit breaker that turns it off by itself if
it loses money. A payout far above the documented reward is **never executed**: it becomes a responsible-disclosure
draft. Discovery's replay flags any transaction that would move a third party's funds. Crumbs only calls instructions
protocols designed for anyone to call; it never front-runs or sandwiches users.

**Measured, then improved.** v1 went live on Oct 30 and earned on its first day. v2 started by measuring every job:
Crumbs started on a task a median 1.4 s after it became callable, while the incumbent bot landed in that same second.
We researched batching (two TukTuk tasks overflow Solana's 1,232-byte transaction limit, so it's not viable) and fixed
speed instead: firing on the chain's own clock over a websocket (it runs ~0.4–1.1 s behind wall time), 150 ms retries,
freeing send slots the instant a race is lost, parallel jobs and a learned Jito tip. Each change was measured against a
recorded baseline.

**Traction** *(live, refresh on the day)*: [N] tasks landed on mainnet, net [+X SOL] after every fee, [Y]% fees as a
share of rewards, [Z] tries analysed. Every figure links to Solscan.

**Tech.** TypeScript on Node 22, `@solana/web3.js`, SQLite (`node:sqlite`, no native modules, so it also runs on a phone
in Termux), grammY for Telegram, Jito block engine, Pyth on-chain price, Helius RPC and websockets (free plan), Next.js
dashboard on Vercel, Claude (`claude-sonnet-5-5`, structured output) for discovery only. Hand-rolled TukTuk decoding:
no heavy SDKs. 100+ tests, including fixtures recorded from mainnet.

---

## Track-specific angle

### Encode Solana Hackathon (closes Nov 8)

> Crumbs is Solana infrastructure that pays for itself: it keeps permissionless keeper networks like Helium TukTuk
> running and earns their rewards, with safety and transparency built in. It uses Solana-native pieces end to end:
> Jito bundles so lost races are free, the Clock sysvar over websocket to fire in the first slot a task is callable,
> Pyth's on-chain price, address lookup tables, ed25519-verified remote tasks, and the Program Metadata program to read
> new programs' IDLs for discovery.

### UBC Hackathon: Agentic Payments & AI track (Nov 20)

> Crumbs is an AI agent that earns and holds money on its own, within limits its owner sets. It gets paid by
> protocols for work, pays for its own transaction fees and Jito tips, budgets its own AI spend ($0.25/day of Claude,
> computed from real token usage), and converts ¾ of its income to USDC. Claude is used where judgement helps (reading
> unfamiliar programs to find paid chores) and kept out of where it would be risky: every payment decision is a
> deterministic simulation, every new job is announced to the owner with a one-tap Reject, and every money-making
> feature has a circuit breaker.

---

## What's next (roadmap)

- More adapters, chosen by discovery's ranking (reward × frequency ÷ competition), where Crumbs can win.
- Same agent, more chains: the safety core (simulate → profit guard → caps → circuit breakers) is chain-agnostic; EVM
  keepers (e.g. Chainlink Automation-style upkeeps, liquidations) are the next adapters.
- A watch-only mode for liquidations, counting missed opportunities in volatile markets before risking a lamport.

## Team

[Your name, role, contact]
