/**
 * The passkey choice in the raise screens' "Pay with" picker (`ui/SenderPicker.tsx`): which network its fees are covered
 * on, named from the chain the sponsored account actually runs on. A build pointed at a real-money network must not say
 * "the test network". Pure, so `sender-picker-copy.test.mjs` pins it.
 */
import { isMainnetChain, networkLabel } from "../chain-config.ts";

const known = (chainId: number) => Number.isInteger(chainId) && chainId > 0;

/** Where fees are covered: "the test network" on a test chain, the network's name on a real-money one. */
function feeNetwork(chainId: number): string {
  return isMainnetChain(chainId) ? networkLabel(chainId) : "the test network";
}

/** The radio label; without a configured chain nothing is covered, so it makes no promise. */
export function passkeyChoiceLabel(chainId: number): string {
  return known(chainId)
    ? `Your passkey account (fees are covered on ${feeNetwork(chainId)})`
    : "Your passkey account";
}

/** The line under it once the account address is known. */
export function passkeyAccountLine(account: string, chainId: number): string {
  const fees = known(chainId)
    ? ` Fees are covered on ${feeNetwork(chainId)}.`
    : "";
  return `Account ${account}: what you buy and any refunds arrive there.${fees}`;
}
