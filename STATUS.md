# STATUS

Grades via `node cli/makefun.mjs grade-local --kit . --bot ../repo --driver docker` from the kit
directory. Buy-and-hold baseline dev reference: **-869.34 USDC** (graded the same way,
result_sha256 82d067a156eb9f09e198ac423c0650d631a6e0240f4252075eef3d9522b23d0e).

## Round 1 — cross-sectional momentum + cash regime (f1bf16e)

Weighted 6/12/24-bar momentum score entries, score exits, -10% stops.

- Dev Net PnL: **-874.62 USDC** (margin -5.28 vs B&H)
- Max DD 10.4%, 62 trades, fees 155.5 USDC, exposure 44.5%
- Per-asset: all 7 negative (-17 to -229). Verdict: REJECTED — the dev window's crash-then-chop
  whipsaws momentum entries; 31 round trips of fee+slippage+fade bleed.

## Round 2 — capitulation MR + gated trend + circuit breaker (HEAD)

- Dev Net PnL: **+138.35 USDC** (margin **+1007.69** vs B&H)
- Max DD 4.0%, 10 trades over 6 symbols, win rate 50%, fees 20.7 USDC, exposure 51.2%, 1 rejected
- At 2x fees: +117.51 USDC — still positive.
- Per-asset: POPCAT +214.7, FARTCOIN +34.4, WETH +0.1, JITOSOL -0.0, WIF -31.2, RAY -79.7, SOL 0.
  Driven by the crash-bottom dip buys (bar ~25); profit concentrated in POPCAT but the entry
  family (4 simultaneous dip buys) is structural, not a one-symbol fluke.
- result_sha256 8ce199b56899b16c4320976d41c218777cb1267820ee0241f8fdc333b8a8ea0f
- Robustness (local replay with the same fill model + synthetic 72-bar regimes, 5 seeds):
  crash +5-6k, V-shape +2k, downtrend +1.2-1.5k margin; flat/chop near 0; smooth uptrend
  trails B&H (late entries, structural). Loss-streak circuit breaker bounds chop bleed.
  Flat-window check: insurance fills reach 8 trades at ~0.5 USDC cost.
- Determinism: grade-local double execution + L1 regrade reproduced byte for byte.
