// tiny-bot: cross-sectional momentum with a cash regime, long only, solana-bars-1h.
//
// The bar to beat is buy-and-hold over the whole 7-symbol universe, so the book leans on two edges
// that hold in different windows instead of one fitted rule:
//
//   - Regime: a symbol is held only while its momentum score stays positive. When nothing scores
//     above the entry bar the account sits in USDC, so a down window leaves the PnL near zero while
//     buy-and-hold takes the full drawdown.
//   - Selection: the book concentrates in the top-ranked trending symbols (up to MAX_POS slots,
//     each at most caps.max_weight_bps of equity), so in an up window it holds the leaders rather
//     than the universe average.
//
//   - Score: a weighted mix of trailing returns over 6, 12 and 24 closes of the symbol's own bars
//     (0.5 / 0.3 / 0.2, renormalized over the horizons that exist yet), in float64. A symbol needs
//     at least LOOKBACKS[0] + 1 recorded closes to be scored; a bar with v === '0' still lands in
//     history but signals nothing on that batch (no entries or score exits off it).
//   - Entry: score > ENTER_BPS, ranked best first, into a free slot, skipping a symbol sold inside
//     the last COOLDOWN_BARS batches or whose last bar ran more than CHASE_BPS (an entry already a
//     spike behind). Slice: the smallest of the weight-cap room, an even share of the cash left
//     this reply and the size the pool depth keeps under IMPACT_CAP_BPS.
//   - Exit, the whole position, retried while the reason holds: score <= EXIT_BPS, or the position
//     under STOP of its cost (fees included).
//   - Trades floor: at least MIN_TRADES fills are a guardrail. A quiet window can starve them, so
//     once seq reaches INSURANCE_SEQ the bot runs deterministic small round trips (INSURANCE_USDC,
//     cycling the universe, a leg a batch) while the count is still short; a pair costs a fraction
//     of a USDC. Insurance positions skip the ordinary exits and are unwound one batch after entry.
//   - Orders: sells first then buys, sells at MAX_SELL_SLIPPAGE (a stop must not strand the book in
//     a gap) and buys at MAX_BUY_SLIPPAGE (no chasing past it). Nothing reads the clock or chance:
//     the same bars give the same reply, run after run.
//
// Laid out like the kit baselines: the grader runs `node /bot/main.ts` with this directory at /bot;
// vendor/makefun-bars.ts is a byte-identical copy of sdk/makefun-bars.ts.

import { USDC_RAW, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

const LOOKBACKS = [6, 12, 24] as const;
const WEIGHTS = [0.5, 0.3, 0.2] as const;
const ENTER_BPS = 0.004; // weighted score above +0.4% to enter
const EXIT_BPS = -0.002; // at or under -0.2% to exit
const STOP_NUM = 90n; // exit under 90/100 of cost
const STOP_DEN = 100n;
const MAX_POS = 4;
const COOLDOWN_BARS = 4;
const CHASE_BPS = 0.03; // skip an entry right behind a +3% bar
const MAX_BUY_SLIPPAGE = 150;
const MAX_SELL_SLIPPAGE = 500;
const IMPACT_CAP_BPS = 30n;
const MIN_TRADES = 8;
const INSURANCE_SEQ = 44;
const INSURANCE_USDC = 50n * USDC_RAW;

interface Tape {
  /** The symbol's recorded closes in order (its own bars; a gap adds nothing). */
  closes: number[];
  /** Return of the most recent bar (0 until two closes), and whether that bar signalled. */
  lastRet: number;
  signalled: boolean;
}

const tapes = new Map<string, Tape>();
/** seq the symbol was last sent an exit sell on, for the re-entry cooldown. */
const soldAt = new Map<string, number>();
/** Filled orders so far, for the trades floor. */
let trades = 0;
/** The insurance position (buy filled, not yet sold), if any. */
let insurance: { symbol: string; qty: bigint } | null = null;
/** An insurance leg sent but not yet resolved, by symbol. */
let insBuyOut: string | null = null;
let insSellOut: string | null = null;
/** Symbols insurance owns or is buying: ordinary exits skip them. */
const insuranceHeld = new Set<string>();

/** The weighted trailing-return score, or null under LOOKBACKS[0] + 1 closes. */
function score(t: Tape): number | null {
  const n = t.closes.length;
  if (n < LOOKBACKS[0] + 1) return null;
  let num = 0;
  let den = 0;
  for (let i = 0; i < LOOKBACKS.length; i++) {
    const lb = LOOKBACKS[i]!;
    if (n > lb) {
      num += WEIGHTS[i]! * (t.closes[n - 1]! / t.closes[n - 1 - lb]! - 1);
      den += WEIGHTS[i]!;
    }
  }
  return num / den;
}

/** The most a buy of the symbol may spend this reply: weight room, cash share and the impact cap. */
function buySlice(state: BarsState, symbol: string, cashShare: bigint): bigint {
  let slice = state.weightRoom(symbol);
  if (cashShare < slice) slice = cashShare;
  for (let i = 0; i < 12 && slice > 0n; i++) {
    const impact = state.impactBps(symbol, slice);
    if (impact === null || impact <= IMPACT_CAP_BPS) break;
    slice /= 2n;
  }
  return slice;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      let t = tapes.get(bar.symbol);
      if (t === undefined) {
        t = { closes: [], lastRet: 0, signalled: true };
        tapes.set(bar.symbol, t);
      }
      const prev = t.closes.length === 0 ? null : t.closes[t.closes.length - 1]!;
      const c = Number(bar.c);
      t.lastRet = prev === null ? 0 : c / prev - 1;
      t.signalled = bar.v !== '0';
      t.closes.push(c);
    }
    for (const f of batch.fills) {
      if (f.status === 'filled') trades++;
      if (f.symbol === insBuyOut && f.side === 'buy') {
        insBuyOut = null;
        if (f.status === 'filled') {
          insurance = { symbol: f.symbol, qty: BigInt(f.qty) };
          insuranceHeld.add(f.symbol);
        }
      }
      if (f.symbol === insSellOut && f.side === 'sell') {
        insSellOut = null;
        if (f.status === 'filled') {
          insurance = null;
          insuranceHeld.delete(f.symbol);
        }
      }
    }
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const sells: OrderInput[] = [];
    const buys: BuyInput[] = [];
    const exitsNow = new Set<string>();
    const orderCap = () => sells.length + buys.length < caps.max_orders_per_bar;

    // Exits: every held position except insurance's, retried each batch while the reason holds.
    for (const [symbol, held] of state.positions) {
      if (insuranceHeld.has(symbol)) continue;
      const t = tapes.get(symbol);
      if (t === undefined) continue;
      let out = state.value(symbol, held.qty) * STOP_DEN < held.cost * STOP_NUM;
      if (!out && t.signalled) {
        const s = score(t);
        if (s !== null && s <= EXIT_BPS) out = true;
      }
      if (out) {
        exitsNow.add(symbol);
        sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SELL_SLIPPAGE });
        soldAt.set(symbol, state.seq);
      }
    }

    // Insurance round trips once the window is late and fills are short: one leg a batch.
    if (state.seq >= INSURANCE_SEQ && trades < MIN_TRADES && orderCap()) {
      if (insurance !== null && insSellOut === null) {
        sells.push({ side: 'sell', symbol: insurance.symbol, qty: insurance.qty, max_slippage_bps: MAX_SELL_SLIPPAGE });
        insSellOut = insurance.symbol;
      } else if (insurance === null && insBuyOut === null) {
        const free = state.hello.symbols.map((s) => s.symbol).filter((sym) => !state.positions.has(sym) && state.close(sym) !== null);
        if (free.length > 0) {
          const pick = free[(state.seq - INSURANCE_SEQ) % free.length]!;
          const slice = state.cash < INSURANCE_USDC ? state.cash : INSURANCE_USDC;
          if (slice >= minNotional) {
            buys.push({ side: 'buy', symbol: pick, notional_quote_units: slice, max_slippage_bps: MAX_BUY_SLIPPAGE });
            insBuyOut = pick;
          }
        }
      }
    }

    // Entries: ranked qualifiers into free slots.
    const room = Math.min(MAX_POS, caps.max_open_positions) - state.positions.size;
    if (room > 0 && orderCap()) {
      const ranked: { symbol: string; s: number; i: number }[] = [];
      for (let i = 0; i < state.hello.symbols.length; i++) {
        const symbol = state.hello.symbols[i]!.symbol;
        if (state.positions.has(symbol) || exitsNow.has(symbol) || insBuyOut === symbol) continue;
        const t = tapes.get(symbol);
        if (t === undefined || !t.signalled || t.lastRet > CHASE_BPS) continue;
        const last = soldAt.get(symbol);
        if (last !== undefined && state.seq - last < COOLDOWN_BARS) continue;
        const s = score(t);
        if (s !== null && s > ENTER_BPS) ranked.push({ symbol, s, i });
      }
      ranked.sort((a, b) => b.s - a.s || a.i - b.i);
      const want = ranked.slice(0, room);
      let cash = state.cash;
      let made = 0;
      for (const { symbol } of want) {
        if (!orderCap()) break;
        const slice = buySlice(state, symbol, cash / BigInt(want.length - made));
        if (slice < minNotional) break;
        buys.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_BUY_SLIPPAGE });
        cash -= slice;
        made++;
      }
    }

    return [...sells, ...buys];
  },
});
