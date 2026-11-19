/**
 * The chain the phone path runs on, set up on a fresh anvil with no outside service:
 *
 * - EntryPoint v0.7 at its canonical address, deployed through the CREATE2 deployer anvil has at genesis, from the creation
 *   payload in the vendored Kernel repo's v3.3 tag (`fixtures/entrypoint-v07.json`);
 * - the deployed Kernel 0.3.3 stack (factory, Kernel, the passkey validator, the P-256 verifier), set with the runtime code
 *   read once from the public Sepolia network (`fixtures/kernel033-stack.json`), at the same addresses, so the app's own
 *   constants need no override and the passkey signature is checked by the code that is deployed;
 * - `AcceptAllPaymaster` with a deposit, and a dollar token to send to.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeParameters } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import { deploy, rpc, send } from "./rpc";

const FIXTURES = resolve(__dirname, "fixtures");
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
export const ENTRY_POINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as T;

export interface PhoneChain {
  entryPoint: string;
  paymaster: string;
  /** An open-mint dollar token (the platform's test token). */
  token: string;
  submitter: string;
}

export async function setUpPhoneChain(admin: string): Promise<PhoneChain> {
  // EntryPoint v0.7 where it is on every network.
  if ((await rpc<string>("eth_getCode", [ENTRY_POINT, "latest"])) === "0x") {
    const { payload } = fixture<{ payload: string }>("entrypoint-v07.json");
    await send(admin, CREATE2_DEPLOYER, payload);
    if ((await rpc<string>("eth_getCode", [ENTRY_POINT, "latest"])) === "0x")
      throw new Error("EntryPoint is not at its canonical address");
  }

  // The deployed Kernel stack, at its own addresses.
  const stack = fixture<
    Record<string, { address: string; runtimeCode: string }>
  >("kernel033-stack.json");
  for (const name of [
    "factory",
    "kernelImplementation",
    "validator",
    "p256Verifier",
  ])
    await rpc("anvil_setCode", [stack[name].address, stack[name].runtimeCode]);

  // A paymaster that pays for everything, with money behind it at EntryPoint.
  const { creationCode: paymasterCode } = fixture<{ creationCode: string }>(
    "accept-all-paymaster.json",
  );
  const args = encodeParameters(["address"], [ENTRY_POINT]).slice(2);
  const receipt = await send(admin, null, paymasterCode + args);
  const paymaster = receipt.contractAddress?.toLowerCase();
  if (!paymaster) throw new Error("no paymaster address");
  // deposit() is payable: send it with value.
  await rpc("eth_sendTransaction", [
    {
      from: admin,
      to: paymaster,
      value: "0x56bc75e2d63100000", // 100 coins
      data: "0xd0e30db0",
      gas: "0x7a120",
    },
  ]);

  const token = await deploy(admin, "QuoteToken.sol/QuoteToken.json");
  return { entryPoint: ENTRY_POINT, paymaster, token, submitter: admin };
}
