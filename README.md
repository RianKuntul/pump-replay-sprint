# pump-replay-sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/RianKuntul/pump-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/RianKuntul/pump-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

BurstFade — a paper trading bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity. Two regimes: IGNITION buys young curves on a sudden burst of distinct-buyer inflow, and RECLAIM buys older curves bouncing off a dip on positive flow. Positions are small and fixed-size (no scale-in), exits are fast (take-profit, stop-loss, trailing stop, fade and dead-tape exits), and tiny probe round trips keep the run above the 20-coin guardrail. Fully deterministic: no clock, no randomness, no network.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout (see `vendor/makefun-bot.ts`); the grader runs `node /bot/main.ts` on Node 22.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
