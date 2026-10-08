import { ponder } from "ponder:registry";
import { candle, pool, swap } from "ponder:schema";

import {
  bucketStart,
  CANDLE_INTERVALS,
  foldCandle,
  swapPrice,
  swapVolumes,
} from "./lib/price.ts";

ponder.on("LimitBreakAMM:PoolCreated", async ({ event, context }) => {
  await context.db
    .insert(pool)
    .values({
      id: event.args.poolId,
      poolType: event.args.poolType,
      token0: event.args.token0,
      token1: event.args.token1,
      createdAt: Number(event.block.timestamp),
      lastPrice: null,
      swaps: 0,
    })
    // The same pool id can only be announced once; a replay of the log must not reset what was counted since.
    .onConflictDoNothing();
});

ponder.on("LimitBreakAMM:Swap", async ({ event, context }) => {
  const { poolId, recipient, zeroForOne, amountIn, amountOut } = event.args;
  const price = swapPrice(zeroForOne, amountIn, amountOut);
  // A swap with nothing on one side has no price to draw; it is not a trade the chart should show.
  if (price === null) return;
  const timestamp = Number(event.block.timestamp);

  await context.db
    .insert(swap)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      poolId,
      recipient,
      zeroForOne,
      amountIn,
      amountOut,
      price,
      timestamp,
    })
    .onConflictDoNothing();

  await context.db
    .update(pool, { id: poolId })
    .set((row) => ({ lastPrice: price, swaps: row.swaps + 1 }));

  const { volume0, volume1 } = swapVolumes(zeroForOne, amountIn, amountOut);
  for (const interval of CANDLE_INTERVALS) {
    const start = bucketStart(timestamp, interval);
    const key = { poolId, interval, start };
    const current = await context.db.find(candle, key);
    const next = foldCandle(current, price, volume0, volume1);
    if (current) {
      await context.db.update(candle, key).set(next);
    } else {
      await context.db.insert(candle).values({ ...key, ...next });
    }
  }
});
