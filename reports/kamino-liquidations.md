# Kamino liquidations: are they a fit for Crumbs?

Oct 31, 2026. **Recommendation: don't build it now.** Revisit if the wallet grows past ~1 SOL, or as a volatility-only add-on once the rest of v2 is measured.

## What we measured

| | Value | Source |
|---|---|---|
| Kamino main market size | $1.00B supplied, $408M borrowed, 58 reserves | Kamino API (`/kamino-market/7u3H…5PfF/reserves/metrics`), today |
| Largest borrows | SOL $211M, USDC $115M, USDG $36M, PYUSD $27M | same |
| Lending program activity | ~1,285 transactions/hour, 28% fail | 3,000 recent signatures of `KLend2g…gmjD` |
| Liquidations seen | **0 in a sample of 180** successful transactions over ~2 h | transaction logs; the rest is refreshes, deposits and borrows |
| Discovery's replay check | `liquidateObligationAndRedeemReserveCollateral(V2)`: no recent call in 80 scanned signatures | Crumbs discovery feed |

A sample of 180 with no liquidation suggests they're under about 2% of successful transactions in a calm market (95% bound): **at most a few dozen per hour, likely far fewer**. Liquidations bunch up in sharp price moves.

## Why it doesn't fit yet

1. **Capital.** A liquidator repays part of an unhealthy loan and receives collateral plus a bonus. Kamino has flash loans (`flash_borrow_reserve_liquidity` / `flash_repay_reserve_liquidity`), so in principle no capital is needed. But the seized collateral then has to be swapped back to repay the flash loan in the same transaction (Jupiter route + oracle refreshes + liquidation). Those transactions are large (they need lookup tables) and the swap leg carries price risk if it slips. **Unverified:** the exact flash-loan fee and per-reserve bonus ranges. Kamino's reserve configs hold them; I haven't decoded them and won't guess.
2. **Competition.** Lending liquidations are the most contested job on Solana: professional searchers with co-located nodes, LaserStream-class data and large Jito tips. Our measured disadvantage on TukTuk (Helium's bot lands in the same slot, ahead of us) would be worse here.
3. **Our safety rules make it harder, rightly.** A liquidation moves a borrower's funds by design. The third-party fund guard would flag it, so it needs a dedicated, reviewed adapter rather than discovery's generic replay.
4. **Cost to build.** The official SDK is ~300 MB with its dependencies (too heavy for the phone and the 512 MB Render instance). A hand-rolled adapter needs obligation health maths per reserve, oracle refresh ordering, elevation groups and Jupiter swaps: several days of work.
5. **Expected value at our size.** With a 0.025 SOL wallet, Jito tips set by the market and few liquidations in calm conditions, expected wins are near zero most days.

## What would change the answer

- The wallet holding ≥ 1 SOL (to pay competitive tips without risking the caps).
- A paid data feed (LaserStream, $499/month) or a co-located host. Not justified by current earnings.
- A sharp market move: liquidation volume spikes, and some small liquidations are left to whoever is watching. A "watch only" mode could count missed opportunities first, at no risk, before deciding.

Nothing here was built or enabled. If you want the watch-only counter, it's about a day of work and needs your approval like any new job type.
