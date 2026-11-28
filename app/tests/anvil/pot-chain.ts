/**
 * The money contracts of `contracts/pot` on anvil, deployed from the forge build (`contracts/pot/out`, no compile) in the
 * order of `contracts/pot/script/DeployPot.s.sol`: the play dollar, Parts, the Launcher. The loop then drives them only
 * through the app's own call builders, quote readers and wallet (`src/features/money/wallet.ts`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeParameters } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import { encodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { LAUNCHER_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import {
  injectedWallet,
  type MoneyWallet,
} from "../../src/features/money/wallet";
import { providerFor, send } from "./rpc";

const OUT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../contracts/pot/out",
);

/** A contract's creation code from the pot build. */
export function potCode(name: string): string {
  const json = JSON.parse(
    readFileSync(resolve(OUT, `${name}.sol`, `${name}.json`), "utf8"),
  ) as { bytecode: { object: string } };
  return json.bytecode.object;
}

export interface PotChain {
  dollar: string;
  parts: string;
  launcher: string;
  /** The time unit in seconds (a multiple of 168 on a test chain). */
  unit: number;
  /** The earlier backers' claim contract, when the deployment was given its settings. */
  earlier?: string;
}

/** The earlier-grant settings of a deployment (`DeployPot.s.sol`'s six, as the contract takes them): invented rows only. */
export interface EarlierSettings {
  root: string;
  textHash: string;
  total: bigint;
  rows: number;
  /** `Launcher.keyOf(founder, projectId)` of project zero. */
  key: string;
}

/** A sender as the app builds it for an account: the injected wallet, over anvil's own account. */
export const walletOf = (account: string): MoneyWallet =>
  injectedWallet(providerFor(account), { polls: 100, pollMs: 20 });

/** Deploy the pot contracts from `admin`; `unit` seconds is the time unit (1,680 is 28 minutes). */
export async function deployPot(
  admin: string,
  unit = 1680,
  options: { earlier?: EarlierSettings } = {},
): Promise<PotChain> {
  const deployFrom = async (
    name: string,
    types: Parameters<typeof encodeParameters>[0] = [],
    values: Parameters<typeof encodeParameters>[1] = [],
  ) => {
    const args = types.length ? encodeParameters(types, values).slice(2) : "";
    const receipt = await send(admin, null, potCode(name) + args);
    if (!receipt.contractAddress) throw new Error(`no address for ${name}`);
    return receipt.contractAddress.toLowerCase();
  };
  const dollar = await deployFrom("PlayDollar", ["address"], [admin]);
  const parts = await deployFrom("Parts");
  const launcher = await deployFrom(
    "Launcher",
    [
      "address",
      { tuple: ["address", "address", "uint16", "uint32", "uint128"] },
      "address",
    ],
    [admin, [dollar, admin, 200n, BigInt(unit), 25_000_000n], parts],
  );
  const chain: PotChain = { dollar, parts, launcher, unit };
  // The earlier backers' claim switch, as `DeployPot.s.sol` does it: deployed and bound before any project is launched.
  if (options.earlier) {
    const e = options.earlier;
    chain.earlier = await deployFrom(
      "EarlierGrants",
      ["address", "bytes32", "bytes32", "uint256", "uint32", "bytes32"],
      [launcher, e.root, e.textHash, e.total, BigInt(e.rows), e.key],
    );
    await send(
      admin,
      launcher,
      encodeCall(LAUNCHER_ABI, "bindEarlier", [chain.earlier]),
    );
  }
  return chain;
}
