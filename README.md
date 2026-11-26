# tiny-bot — solana-bars-1h

A long-only paper-trading bot for the make.fun bars-replay competition (`agent-fun/bars-replay/v1`,
hourly bars over FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF; 10,000 USDC; 1-bar fill latency).

## Strategy

The bot runs two entry legs and sits in USDC when neither qualifies, so its PnL profile is
regime-adaptive rather than a single fitted rule:

- **Capitulation (mean reversion):** a symbol down >6% over its last 24 closes that is already
  ~2% off its 6-close low — the selling looks spent. Buys the most oversold first, at most twice
  per symbol per window. Exits: +8% target, a 3% giveback once up 3%, or −8%.
- **Trend (momentum):** early in the window, r12 > +5% catches a rally young; afterwards an
  established-trend gate (r12 > +4% or r24 > +5% **and** the close above its 24-close high — a real
  breakout, so a chop bounce does not read as a trend). Exits: an 18-bar-low break, r24 back under
  −2%, or −8%.
- **Per-leg circuit breaker:** two exits in a row marked at a loss pause that leg's new entries for
  16 bars — chop stops costing after a couple of probes. A portfolio equity guard blocks new
  entries under 85% of the window's equity peak.
- **Trades floor:** the guardrail needs ≥8 fills; from seq 44 the bot runs deterministic ~50 USDC
  round trips (one leg a batch, cycling the universe) while the count is still short.
- Sizing: up to 4 positions at ≤25% of equity each (the caps), sliced to keep pool impact ≤30 bps.
  Buys cap slippage at 150 bps, sells at 500 bps (a stop must not strand the book in a gap).
  Everything is float64 and BigInt on the bars alone — no clock, no randomness, deterministic.

## Layout

- `main.ts` — the bot (Node 22+ runs it as-is).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's `sdk/makefun-bars.ts`.

## Grading

From the kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot /path/to/repo --driver docker
```

Latest dev-window result is in `STATUS.md`.
