/**
 * The money contracts of `contracts/pot` on anvil, deployed from the forge build (`contracts/pot/out`, no compile) in the
 * order of `contracts/pot/script/DeployPot.s.sol`: the play dollar, Parts, the Launcher. The loop then drives them only
 * through the app's own call builders, quote readers and wallet (`src/features/money/wallet.ts`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeParameters } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
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
}

/** A sender as the app builds it for an account: the injected wallet, over anvil's own account. */
export const walletOf = (account: string): MoneyWallet =>
  injectedWallet(providerFor(account), { polls: 100, pollMs: 20 });

/** Deploy the pot contracts from `admin`; `unit` seconds is the time unit (1,680 is 28 minutes). */
export async function deployPot(admin: string, unit = 1680): Promise<PotChain> {
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
  return { dollar, parts, launcher, unit };
}
