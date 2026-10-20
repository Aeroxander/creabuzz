#!/usr/bin/env node
// The web exit screen's arithmetic, run for Forge (`RagequitPreviewFfi.t.sol`, vm.ffi). It imports the screen's own
// module, so the Forge test compares the chain's ragequit with the code people see, not with a copy of it.
//
// Usage: node exit-preview.mjs <sharesBalance> <locked> <lootToBurn> <lootBalance> <sharesTotal> <lootTotal>
//                              <daoHeld> <lockedTotal> <poolUsdc> <poolEth>
// Prints 0x + abi.encode(uint256 burnable, uint256 dueUsdc, uint256 dueEth): the exit burns every free Share (as the
// screen offers) plus `lootToBurn` Loot.
import {
  burnableShares,
  deriveClaimablePosition,
} from "../../../web/src/features/launchpad/lib/ragequit-position.ts";

const [
  sharesBalance,
  locked,
  lootToBurn,
  lootBalance,
  sharesTotal,
  lootTotal,
  daoHeld,
  lockedTotal,
  poolUsdc,
  poolEth,
] = process.argv.slice(2).map((v) => BigInt(v));

const burnable = burnableShares(sharesBalance, locked);
const rows = deriveClaimablePosition({
  sharesToBurn: burnable,
  lootToBurn,
  sharesBalance,
  lootBalance,
  sharesTotal,
  lootTotal,
  daoHeld,
  lockedTotal,
  pools: [
    { token: "usdc", pool: poolUsdc },
    { token: "eth", pool: poolEth },
  ],
});
const word = (n) => n.toString(16).padStart(64, "0");
process.stdout.write(`0x${word(burnable)}${word(rows[0].due)}${word(rows[1].due)}`);
