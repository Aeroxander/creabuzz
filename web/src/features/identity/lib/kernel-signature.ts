/**
 * A passkey account signs "this Nostr key may act for me" the way a smart account signs anything: not with a key
 * anyone can `ecrecover`, but with a signature the account itself checks on chain (ERC-1271). This is the signer and
 * the checker for the product's account, the ZeroDev Kernel 0.3.3 with the WebAuthn validator.
 *
 * How the deployed Kernel 0.3.3 checks `isValidSignature(hash, signature)` (its `Kernel.sol`, `ValidationManager.sol`
 * and `ValidationTypeLib.sol`, tag v3.3):
 * - the first byte of `signature` picks the validator: `0x00` is the root validator, which is the passkey validator;
 * - the validator is not asked about `hash` itself but about the EIP-712 wrapper of it, `Kernel(bytes32 hash)`, under
 *   the account's own domain (`name "Kernel"`, `version "0.3.3"`, the chain id, the account as verifying contract), so
 *   a signature cannot be replayed on another account or chain;
 * - the passkey validator then checks a WebAuthn assertion whose challenge is that wrapped hash, in the same tuple a
 *   user operation is signed with.
 *
 * Checked on a real deployed 0.3.3 account on Sepolia: this format returns the ERC-1271 magic value, and the same
 * signature over an unwrapped or different hash is refused (`scripts/kernel-1271-live-check.mjs`).
 *
 * Alias-free; `kernel-signature.test.mjs` drives it under `node --test`.
 */

import type { PasskeyAssertionSource } from "./kernel033.ts";
import { getPasskeyAssertion } from "./passkey.ts";
import { keccak256 } from "./userop.ts";
import {
  abiEncode,
  abiEncodeCall,
  bytesToHex,
  hexToBytes,
} from "./userop-abi.ts";
import { wrapPasskeyAssertionForZeroDevValidator } from "./webauthn-auth.ts";

/** The Kernel version this module signs for. The account's own domain names it, so it cannot be guessed. */
const KERNEL_VERSION = "0.3.3";

/** `keccak256("Kernel(bytes32 hash)")`, the type hash Kernel 0.3.3 wraps a hash with. */
export const KERNEL_WRAPPER_TYPE_HASH =
  "0x1547321c374afde8a591d972a084b071c594c275e36724931ff96c25f2999c83";

/** What `isValidSignature` returns for a signature it accepts. */
export const ERC1271_MAGIC = "0x1626ba7e";

const utf8 = (text: string) => bytesToHex(new TextEncoder().encode(text));

const DOMAIN_TYPE_HASH = keccak256(
  utf8(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);

/** The hash the passkey validator is actually asked about when the account is asked about `hash`. */
export function kernelWrapHash(
  hash: string,
  account: string,
  chainId: number,
  version: string = KERNEL_VERSION,
): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("kernel-signature: hash must be 32 bytes");
  }
  const separator = keccak256(
    abiEncode([
      { kind: "bytes32", value: DOMAIN_TYPE_HASH },
      { kind: "bytes32", value: keccak256(utf8("Kernel")) },
      { kind: "bytes32", value: keccak256(utf8(version)) },
      { kind: "uint", value: BigInt(chainId) },
      { kind: "address", value: account },
    ]),
  );
  const struct = keccak256(
    abiEncode([
      { kind: "bytes32", value: KERNEL_WRAPPER_TYPE_HASH },
      { kind: "bytes32", value: hash },
    ]),
  );
  return keccak256(`0x1901${separator.slice(2)}${struct.slice(2)}`);
}

/**
 * Sign `hash` as the passkey account `account` on `chainId`: one passkey prompt, and the signature the account's
 * `isValidSignature` accepts. `getAssertion` is the ceremony; it defaults to the real passkey.
 */
export async function signKernelHash(options: {
  credentialId: string;
  /** 0x-hex 32-byte hash to sign, such as an EIP-712 digest. */
  hash: string;
  account: string;
  chainId: number;
  rpId?: string | undefined;
  getAssertion?: PasskeyAssertionSource | undefined;
}): Promise<string> {
  const wrapped = kernelWrapHash(
    options.hash,
    options.account,
    options.chainId,
  );
  const getAssertion = options.getAssertion ?? getPasskeyAssertion;
  const assertion = await getAssertion({
    credentialId: options.credentialId,
    challenge: hexToBytes(wrapped),
    rpId: options.rpId,
  });
  const { encoded } = wrapPasskeyAssertionForZeroDevValidator(assertion, {
    challengeHex: wrapped,
    usePrecompiled: false,
  });
  // `0x00` picks the root validator, which is the passkey validator.
  return `0x00${encoded.slice(2)}`;
}

/** The `eth_call` data for `isValidSignature(hash, signature)`. */
export function isValidSignatureCall(hash: string, signature: string): string {
  return abiEncodeCall("isValidSignature(bytes32,bytes)", [
    { kind: "bytes32", value: hash },
    { kind: "bytes", value: signature },
  ]);
}

/** Whether a failed `eth_call` was the contract refusing (a revert) rather than the node being unreachable. */
function isRevert(error: unknown): boolean {
  return error instanceof Error && /revert/i.test(error.message);
}

/**
 * Ask `account` whether `signature` is valid over `hash`. True only for the ERC-1271 magic value. An account that
 * says anything else, has no code to answer, or reverts (an address that only delegates to some other code, say) is a
 * no. A node that cannot be reached throws, which is not a no.
 */
export async function isValidKernelSignature(
  ethCall: (tx: { to: string; data: string }) => Promise<string>,
  account: string,
  hash: string,
  signature: string,
): Promise<boolean> {
  let answer: string;
  try {
    answer = await ethCall({
      to: account,
      data: isValidSignatureCall(hash, signature),
    });
  } catch (error) {
    if (isRevert(error)) return false;
    throw error;
  }
  return answer.toLowerCase().startsWith(ERC1271_MAGIC);
}
