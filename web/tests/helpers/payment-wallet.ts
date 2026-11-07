import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import {
  newWalletAttestation,
  siweMessageHash,
  walletAttestationDigest,
} from "../../src/features/identity/lib/wallet-proof";

/** Public development keys, used only for the simulated wallet in browser tests. */
export const NSEC = "33".repeat(32);
export const ME = getPublicKey(hexToBytes(NSEC));
export const ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const evmKey = hexToBytes(
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

/** An Ethereum-style signature from Anvil's public account zero. */
export function signDigest(digest: Uint8Array): string {
  const signature = secp256k1.sign(digest, evmKey, {
    prehash: false,
    format: "recovered",
  });
  return `0x${bytesToHex(signature.slice(1))}${(signature[0] + 27).toString(16)}`;
}

/** Valid production-format identity record, with independently signed Nostr and EVM layers. */
export function paymentRecord(
  options: { revoked?: boolean; expired?: boolean } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const attestation = newWalletAttestation(ADDRESS, ME, 8453, now, 42);
  if (options.expired) attestation.attestation.expires = now - 1;
  attestation.signature = signDigest(walletAttestationDigest(attestation));
  return finalizeEvent(
    {
      kind: 37017,
      created_at: now - 10,
      tags: [
        ["d", ADDRESS],
        ["address", ADDRESS],
        ["chain", "8453"],
      ],
      content: JSON.stringify({
        v: 1,
        address: ADDRESS,
        siweMessageHash: siweMessageHash("hello"),
        attestation,
        ...(options.revoked ? { revoked: true } : {}),
      }),
    },
    hexToBytes(NSEC),
  );
}
