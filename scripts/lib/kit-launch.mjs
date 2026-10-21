// scripts/lib/kit-launch.mjs — what the launch page does, for a shell script: turn a launch record into the launch
// kit's calldata (the same `@creaton/core` code the app runs), and read the DAO the kit made out of a receipt.
//
// ⚠️  DEV ONLY. Used by the throwaway-world e2e scripts; nothing here signs or sends.
//
//   node --experimental-strip-types scripts/lib/kit-launch.mjs plan   <rpc> <kit> <launcher> <currency> <startBlock> <reviewers> <quorum> [bond]
//       prints {"to","data"} for `cast send`. `reviewers` is a comma-separated list of the wallets that judge the
//       team's milestones (named in the launch itself); `bond` is whole units of the sale currency, 6 decimals.
//   node --experimental-strip-types scripts/lib/kit-launch.mjs decode <kit> <receipt.json>
//       prints {"dao","shares","executor","auction","lock","launcher"} from the receipt's Launched event.

import { readFileSync } from "node:fs";

import {
  daoLaunchInputsFromRecord,
  decodeKitLaunched,
  encodeKitLaunch,
  encodeKitPredictExecutor,
  planDaoLaunch,
} from "../../packages/creaton-core/src/launchpad/daoLaunch.ts";

const [mode, ...args] = process.argv.slice(2);

async function ethCall(rpc, to, data) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

if (mode === "plan") {
  const [rpc, kit, launcher, currency, start, reviewers, quorum, bond] = args;
  const startBlock = Number(start);
  // A 600M-Share sale of an 800M supply in the dev USDC ($0.0005 a Share): the whole tranche at the floor is the
  // $300,000 target, so the sale sells out or refunds (D74), and the split is the standard 75 / 25 / 0 (D75). The team's
  // 200M are all held back by two milestones of half each, worded exactly as the project that judges each will word
  // its acceptance check.
  const record = {
    id: "milestone-e2e",
    author: launcher.toLowerCase(),
    chainId: "31337",
    tokenPlan: { mode: "dao", name: "Nebula", symbol: "NEB", supply: "600000000" },
    allocation: { sale: 75, team: 25, treasury: 0, liquidity: 0, milestones: 0, community: 0 },
    currency,
    floorPrice: "39614081257000",
    tickSpacing: "79228162514",
    requiredRaised: "299999999998",
    startBlock,
    endBlock: startBlock + 200,
    claimBlock: startBlock + 260,
    unlocks: {
      mode: "milestones",
      milestones: [
        { label: "alpha shipped", percent: 50 },
        { label: "mainnet live", percent: 50 },
      ],
    },
  };
  const now = Math.floor(Date.now() / 1000);
  const panel = {
    reviewers: (reviewers ?? "").split(",").filter(Boolean),
    quorum: Number(quorum ?? "1"),
    bond: bond ? BigInt(bond) * 10n ** 6n : 0n,
    bondToken: "",
    endsAt: now + 730 * 86_400,
    now,
  };
  const plan = planDaoLaunch(daoLaunchInputsFromRecord(record, launcher, { panel }));
  const executor = `0x${(await ethCall(rpc, kit, encodeKitPredictExecutor(launcher, plan.salt))).slice(-40)}`;
  console.log(JSON.stringify({ to: kit, data: encodeKitLaunch(plan, executor) }));
} else if (mode === "decode") {
  const [kit, receiptPath] = args;
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const launched = decodeKitLaunched(receipt.logs ?? [], kit);
  if (!launched) {
    console.error("no Launched event from the kit in that receipt");
    process.exit(1);
  }
  console.log(JSON.stringify(launched, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
} else {
  console.error("usage: kit-launch.mjs plan|decode …");
  process.exit(2);
}
