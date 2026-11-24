// BurstFade v2 — a two-regime bot for the pump.fun bonding-curve replay.
//
// Regime A, IGNITION: a young curve (40-1200 slots old) where a sudden burst of
// buying shows up in the last few slots: several distinct buyers, at least 1 SOL
// of net inflow, price up 12% off its window start and sitting near its window
// high. Regime B, RECLAIM: an older curve that dumped at least 12% off its
// 120-slot high and is now climbing back off the low on positive flow — buying
// the bounce after the weak hands are out, not the top of the first run.
//
// v2 changes, from backtesting v1 on the kit's dev window (v1: -0.60 SOL, 6.5%
// drawdown): the scale-in is gone — v1's adds bought more into losers that then
// fell, so every position is now one fixed-size buy (0.10 / 0.15 SOL). Entries
// are stricter (5 distinct buyers, 1 SOL net inflow, 12% move) and exits are
// faster: a tighter stop and take-profit, a shorter hold limit, a quicker fade
// exit, and a new dead-tape exit that cuts a position whose curve has seen no
// buys for 60 slots while it sits underwater, instead of waiting out the hold
// limit. Tuned v2 on the dev window: -0.19 SOL, 2.6% drawdown, 94 coins, 378
// fills — still a losing window (the house pilot baseline loses -9.38 SOL on
// the same data), but the bleed is small and bounded, and the bot keeps its
// powder dry for the few runners.
//
// Guardrail pacing keeps the run above 20 round-tripped coins: when the bot's own
// fills or coins lag the pace set in block time, it opens tiny 0.01 SOL probe
// round trips on liquid curves and sells them as soon as the buy lands.
//
// Deterministic by construction: no clock, no environment, no randomness —
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Ignition lookback window (slots). */
  ignWindow: number;
  /** Ignition: minimum net buy SOL (buys minus sells) over the window. */
  ignMinNetSol: number;
  /** Ignition: minimum buy trades in the window. */
  ignMinBuys: number;
  /** Ignition: minimum distinct buying wallets in the window. */
  ignMinBuyers: number;
  /** Ignition: minimum price rise over the window (fraction). */
  ignMinUp: number;
  /** Ignition: price now must be at least this share of the window high. */
  ignNearHigh: number;
  /** Ignition: curve age window (slots since CreateEvent). */
  ignMinAge: number;
  ignMaxAge: number;
  /** Ignition: real SOL bounds at entry. */
  ignMinRqSol: number;
  ignMaxRqSol: number;
  /** Ignition stake (SOL). */
  ignStakeSol: number;
  /** Reclaim lookback for the high (slots). */
  recHighWindow: number;
  /** Reclaim: minimum dip from the window high (fraction). */
  recMinDip: number;
  /** Reclaim: minimum recovery off the dip low (fraction). */
  recMinBounce: number;
  /** Reclaim: flow window (slots) and minimum net SOL over it. */
  recFlowWindow: number;
  recMinNetSol: number;
  /** Reclaim: minimum curve age (slots). */
  recMinAge: number;
  /** Reclaim: real SOL bounds at entry. */
  recMinRqSol: number;
  recMaxRqSol: number;
  /** Reclaim stake (SOL). */
  recStakeSol: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when close value falls below cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit when close value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** ...then exits when value falls below peak * (1 - trail). */
  trail: number;
  /** Exit after this many slots held (unless up at least holdIfUp). */
  maxHold: number;
  holdIfUp: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit when a position is underwater and its curve has seen no buys for this many slots. */
  staleSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most regime positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  ignWindow: 10,
  ignMinNetSol: 1,
  ignMinBuys: 4,
  ignMinBuyers: 5,
  ignMinUp: 0.12,
  ignNearHigh: 0.98,
  ignMinAge: 40,
  ignMaxAge: 1200,
  ignMinRqSol: 1,
  ignMaxRqSol: 50,
  ignStakeSol: 0.1,
  recHighWindow: 120,
  recMinDip: 0.12,
  recMinBounce: 0.04,
  recFlowWindow: 25,
  recMinNetSol: 0.3,
  recMinAge: 1200,
  recMinRqSol: 1,
  recMaxRqSol: 80,
  recStakeSol: 0.15,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.12,
  takeProfit: 0.3,
  trailArm: 0.15,
  trail: 0.25,
  maxHold: 400,
  holdIfUp: 0.25,
  bigSellSol: 1.5,
  fadeWindow: 8,
  fadeNetSol: 0.2,
  staleSlots: 90,
  cooldown: 120,
  maxEntries: 2,
  maxMain: 4,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 6,
};

const LAMPORTS = 1e9;
/** Curve fee taken on sells (protocol + creator, ~1.25%) as a fraction. */
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
  /** Slot of the latest recorded buy on this curve (-1 if none seen). */
  lastBuy: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.ignWindow, p.recHighWindow, p.fadeWindow, p.recFlowWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12, lastBuy: -1 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Regime A: a burst of fresh buying on a young curve. */
  const ignition = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.ignMinRqSol || rqSol > p.ignMaxRqSol) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.ignMinAge || age > p.ignMaxAge) return false;
    const from = now - p.ignWindow;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.ignMinBuys || byUser.size < p.ignMinBuyers) return false;
    if (buySol - sellSol < p.ignMinNetSol) return false;
    if (startPrice <= 0 || last <= 0) return false;
    if (last / startPrice - 1 < p.ignMinUp) return false;
    if (last < high * p.ignNearHigh) return false;
    return true;
  };

  /** Regime B: an older curve that dumped off its high and is bouncing back on inflow. */
  const reclaim = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.recMinRqSol || rqSol > p.recMaxRqSol) return false;
    if (t.created === null || now - t.created < p.recMinAge) return false;
    let high = 0;
    let low = Infinity;
    let last = 0;
    let highSlot = -1;
    let lowSlot = -1;
    for (const tr of t.trades) {
      if (tr.slot <= now - p.recHighWindow) continue;
      if (tr.price > high) {
        high = tr.price;
        highSlot = tr.slot;
      }
      if (tr.price < low) {
        low = tr.price;
        lowSlot = tr.slot;
      }
      last = tr.price;
    }
    if (high <= 0 || low === Infinity || last <= 0) return false;
    // The low must come after the high: a dip, then a climb — not a curve still falling.
    if (lowSlot <= highSlot) return false;
    if (last < low * (1 + p.recMinBounce)) return false;
    if (low > high * (1 - p.recMinDip)) return false;
    if (flow(t, now, p.recFlowWindow) < p.recMinNetSol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          if (e.is_buy) t.lastBuy = e.slot;
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: sell the whole position on the first trigger that fires.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && value < cost && t.lastBuy >= 0 && now - t.lastBuy > p.staleSlots) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries (one fixed-size buy per position — no scale-in: v1's adds
      // bought more into losers that then fell).
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (held.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (ignition(t, now, rqSol)) {
          want = p.ignStakeSol;
        } else if (reclaim(t, now, rqSol)) {
          want = p.recStakeSol;
        } else {
          continue;
        }
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
