/**
 * A person's wallet link (kind 37017) signed for real, as web/ and the app's "Link this wallet" write it: the wallet's
 * EIP-712 proof naming the account, inside a record the account signs. The app checks both signatures, so tests that
 * need a teammate's wallet seed one of these. The keys are anvil's well-known development keys.
 */
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { secp256k1 } from "../../../packages/creaton-core/node_modules/@noble/curves/secp256k1.js";
import {
  bytesToHex,
  hexToBytes,
} from "../../../packages/creaton-core/node_modules/@noble/hashes/utils.js";
import {
  newWalletAttestation,
  siweMessageHash,
  walletAttestationDigest,
} from "../../../packages/creaton-core/src/account/wallet-proof.ts";

/** Anvil's development keys by account (public, test-only, never a real wallet). */
export const ANVIL_KEYS: Record<string, string> = {
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8":
    "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc":
    "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906":
    "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
};

/** The account key of a hex secret key. */
export const accountOf = (nostrKey: string) =>
  getPublicKey(hexToBytes(nostrKey));

/** `nostrKey` (hex) links `address` (one of anvil's) on chain 31337, signed `at`. */
export function linkedWalletRecord(
  nostrKey: string,
  address: string,
  at = Math.floor(Date.now() / 1000) - 3600,
) {
  const evmKey = ANVIL_KEYS[address.toLowerCase()];
  if (!evmKey) throw new Error("not an anvil account");
  const pubkey = getPublicKey(hexToBytes(nostrKey));
  const attestation = newWalletAttestation(address, pubkey, 31337, at, 1);
  const sig = secp256k1.sign(
    walletAttestationDigest(attestation),
    hexToBytes(evmKey),
    {
      prehash: false,
      format: "recovered",
    },
  );
  attestation.signature = `0x${bytesToHex(sig.slice(1))}${(sig[0] + 27).toString(16)}`;
  return finalizeEvent(
    {
      kind: 37017,
      created_at: at,
      tags: [
        ["d", address.toLowerCase()],
        ["address", address.toLowerCase()],
        ["chain", "31337"],
      ],
      content: JSON.stringify({
        v: 1,
        address: address.toLowerCase(),
        siweMessageHash: siweMessageHash(
          "Link this wallet to my Creaton account.",
        ),
        attestation,
      }),
    },
    hexToBytes(nostrKey),
  );
}
