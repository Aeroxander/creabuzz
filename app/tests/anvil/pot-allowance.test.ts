/**
 * An announced raise as the app reads it, against the real Treasury: the date it can be applied must be the date the
 * contract itself announces (`RateProposed.applicableAt` = announced at + one time unit), and applying before it is
 * refused. Run by `scripts/pot-app-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import {
  decodeReturn,
  encodeCall,
} from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { LAUNCHER_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import { topicOf } from "../../../packages/creaton-core/src/launchpad/work.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, passTime, RPC, rpc } from "./rpc";

const run = RPC ? describe : describe.skip;
const read = (to: string, data: string) => call(to, data);

run("an announced raise against the real Treasury", () => {
  it("can be applied at the date the contract announces, not at the moment it was announced", async () => {
    const [admin, founder] = await accounts();
    const chain = await deployPot(admin);
    const wallet = walletOf(founder);
    const [settingsHash] = decodeReturn(
      LAUNCHER_ABI,
      "settingsHash",
      await read(chain.launcher, encodeCall(LAUNCHER_ABI, "settingsHash", [])),
      0,
    );
    const projectId = projectIdOf(`37002:${"ab".repeat(32)}:allowance`);
    await wallet.sendCalls(
      [
        pot.launchCall({
          launcher: chain.launcher,
          projectId,
          name: "Lantern",
          symbol: "LNT",
          ratePpm: 1000,
          teamPool: 10_000_000n * 10n ** 18n,
          settingsHash: settingsHash as string,
        }),
      ],
      31337,
    );
    const parts = await state.readProjectParts(
      read,
      chain.launcher,
      chainKeyOf(founder, projectId),
    );
    await wallet.sendCalls([pot.proposeRateCall(parts.treasury, 1500)], 31337);

    const logs = await rpc<{ data: string }[]>("eth_getLogs", [
      {
        address: parts.treasury,
        topics: [topicOf("RateProposed(uint32,uint64)")],
        fromBlock: "0x0",
        toBlock: "latest",
      },
    ]);
    expect(logs).toHaveLength(1);
    const announcedFor = Number(
      BigInt(`0x${logs[0].data.slice(2 + 64, 2 + 128)}`),
    );

    const allowance = await state.readAllowanceState(read, parts.treasury);
    expect(allowance.pending?.ratePpm).toBe(1500);
    expect(allowance.pending?.applicableAt).toBe(announcedFor);
    expect(allowance.pending?.applicableAt).toBeGreaterThan(
      Math.floor(Date.now() / 1000) - 86_400,
    );

    // Before that date the contract refuses; after it, it applies.
    await expect(
      wallet.sendCalls([pot.applyRateCall(parts.treasury)], 31337),
    ).rejects.toBeDefined();
    await passTime(chain.unit + 5);
    await wallet.sendCalls([pot.applyRateCall(parts.treasury)], 31337);
    expect((await state.readAllowanceState(read, parts.treasury)).ratePpm).toBe(
      1500,
    );
  });
});
