# New job types: what pays strangers on Solana (Oct 31, 2026)

## How we looked

Instead of guessing from memory, we sampled **100 recent mainnet blocks** (~4.5 h, 16,563 successful non-vote
transactions) and kept every transaction whose signer ended up with more SOL than it paid in fees, with none of its
tokens going down (so not a sale or swap). Grouped by program, that's a map of who gets paid to call what.

| Program | What the "gain" was | Chore? |
|---|---|---|
| PumpSwap AMM (`pAMMBay6…`) | creators collecting their own fees | no |
| Meteora DLMM (`LBUZKhRx…`) | LPs withdrawing their own liquidity | no |
| GODL mining (`mineWsRs…`) | a player's bot claiming its own winnings | no |
| PumpSwap + `EmTX93xY…` | a trade paying a referral fee | no |
| `Bx3mktmp…` `PrepareAutomatedPrivateBid` | caller only gets its fee back (net 0) | no |
| ORE automation (`8jaLKWLJ…` → `oreV3…`) | +295,000 to the executor a miner chose | permissioned (miner picks the executor) |
| **ORE checkpoint** (`oreV3…`, instruction 2) | **10,000 per unsettled miner, to anyone, in the last 12 h** | **yes** |

## ORE checkpoint bounties

- Source: [regolith-labs/ore `program/src/checkpoint.rs`](https://github.com/regolith-labs/ore): *"If the round expires
  in less than 12h, anyone may checkpoint this account and collect the bot fee."* `CHECKPOINT_FEE = 10_000`.
- Every miner pre-pays the fee when deploying. A miner who doesn't settle a round leaves it for whoever does in the last
  12 h before the round's results expire (24 h after the round). The same call pays the miner their own winnings.
- **Mainnet now:** 35,077 miners; ~100 unsettled at any time; 3 claimable, 70 becoming claimable over 12 h, and 3 had
  **expired with nobody claiming them** (little or no competition).
- **Simulated with our wallet:** 3 checkpoints in one transaction → **+25,000 lamports after the fee**, 67k compute
  units, 692 bytes. Up to 5 fit with the Jito tip.
- **Expected:** ~140 bounties a day × 10,000 = ~1.4M lamports gross; batched 5 per transaction, ~1.2M net
  (**~0.0012 SOL/day, ~$0.12**). That's ~30× what TukTuk has been earning. Small, but uncontested so far.

## Not pursued

- Lending liquidations (Kamino, marginfi, Save): capital, heavy competition. See `kamino-liquidations.md`.
- Anything permissioned (ORE automation executors, Jupiter keepers, Streamflow withdrawors).

## Method, to repeat later

`scratch/paid.ts`-style scan: getBlock with `maxSupportedTransactionVersion: 1` (some blocks already hold version-1
transactions), payer gain = post − pre + fee, skip payers whose token balances fell. Worth re-running weekly: new
protocols appear, and discovery's Claude pass only sees programs with a published IDL.

## Daily hunts

### Oct 31, 18:23 UTC: nothing new qualifies

100 blocks, 23 new patterns. Checked by hand:
- `satRush…` `SettleDeployPublic` / `ExecutePublicAutomation`: the IDL says the signer must be "the crank (round authority)" (or the deployment's owner); the gain is that crank recovering rent it paid itself. Permissioned.
- Pyth push oracle `UpdatePriceFeed`: the caller gets back the rent of its own encoded VAA (`CloseEncodedVaa`). Not a reward.
- The rest are players' own actions: games (Star Atlas SAGE, GODL, coin flips, reveals), closing one's own accounts (`CLEAN…`, `CloseAccount`, PumpSwap volume accumulators), cancelling one's own offers, payments (`Send9…`), Mayan solver settlement and Jupiter perps keepers (permissioned), the ORE automation executor (permissioned).

Live: ORE checkpoints 40 landed, 0 lost, +340,000 lamports since 10:17; TukTuk 16 landed in total. Total net +410,512 lamports.
