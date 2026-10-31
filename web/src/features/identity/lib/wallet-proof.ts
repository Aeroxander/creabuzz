import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import { verifyEvent } from "nostr-tools/pure";
import type { Event } from "nostr-tools/pure";

import { KIND_EVM_BINDING } from "../../../shared/constants/kinds.ts";

const ZERO = `0x${"0".repeat(40)}`;
const addressPattern = /^0x[0-9a-f]{40}$/i;
const domainType =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const signerType =
  "NostrSigner(address account,bytes32 npub,uint256 expires,uint256 nonce)";
const hashText = (text: string) => keccak_256(utf8ToBytes(text));
const uint = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("Invalid proof number");
  return hexToBytes(BigInt(n).toString(16).padStart(64, "0"));
};
const addressWord = (address: string) => {
  if (!addressPattern.test(address)) throw new Error("Invalid wallet address");
  return hexToBytes(address.slice(2).padStart(64, "0"));
};

/** The relay's EIP-712 NostrSigner envelope (buzz-evm-auth/attestation.rs). */
export interface WalletAttestation {
  domain: {
    name: string;
    version: string;
    chain_id: number;
    verifying_contract: string;
  };
  attestation: {
    account: string;
    npub: number[];
    expires: number;
    nonce: number;
  };
  signature: string;
}

/** The exact EIP-712 digest checked by the relay, without an RPC dependency. */
export function walletAttestationDigest(
  envelope: WalletAttestation,
): Uint8Array {
  const { domain: d, attestation: a } = envelope;
  if (
    !Array.isArray(a.npub) ||
    a.npub.length !== 32 ||
    a.npub.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    throw new Error("The wallet link names an account that is not valid");
  }
  const domain = keccak_256(
    concatBytes(
      hashText(domainType),
      hashText(d.name),
      hashText(d.version),
      uint(d.chain_id),
      addressWord(d.verifying_contract),
    ),
  );
  const signer = keccak_256(
    concatBytes(
      hashText(signerType),
      addressWord(a.account),
      Uint8Array.from(a.npub),
      uint(a.expires),
      uint(a.nonce),
    ),
  );
  return keccak_256(concatBytes(new Uint8Array([25, 1]), domain, signer));
}

/** Wallet-readable typed data authorizing this Nostr account, never a transfer. */
export function walletTypedData(envelope: WalletAttestation) {
  const { domain: d, attestation: a } = envelope;
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      NostrSigner: [
        { name: "account", type: "address" },
        { name: "npub", type: "bytes32" },
        { name: "expires", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "NostrSigner",
    domain: {
      name: d.name,
      version: d.version,
      chainId: d.chain_id,
      verifyingContract: d.verifying_contract,
    },
    message: { ...a, npub: `0x${bytesToHex(Uint8Array.from(a.npub))}` },
  };
}

/** New one-year, chain-scoped proof; the wallet supplies its signature next. */
export function newWalletAttestation(
  address: string,
  pubkey: string,
  chain: number,
  now: number,
  nonce: number,
): WalletAttestation {
  return {
    domain: {
      name: "creabuzz",
      version: "1",
      chain_id: chain,
      verifying_contract: ZERO,
    },
    attestation: {
      account: address.toLowerCase(),
      npub: [...hexToBytes(pubkey)],
      expires: now + 365 * 86400,
      nonce,
    },
    signature: "",
  };
}

/** Recover an ordinary EVM wallet's address from a 65-byte Ethereum signature. */
export function recoverWallet(digest: Uint8Array, signature: string): string {
  if (!/^0x[0-9a-f]{130}$/i.test(signature))
    throw new Error("Unsupported wallet signature");
  const bytes = hexToBytes(signature.slice(2));
  const recovery = bytes[64] >= 27 ? bytes[64] - 27 : bytes[64];
  if (recovery > 1) throw new Error("Invalid wallet signature");
  const recovered = concatBytes(new Uint8Array([recovery]), bytes.slice(0, 64));
  const compressed = secp256k1.recoverPublicKey(recovered, digest, {
    prehash: false,
  });
  const publicKey = secp256k1.Point.fromBytes(compressed).toBytes(false);
  return `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`;
}

/** EIP-191 commitment to the SIWE message used when registering the wallet. */
export function siweMessageHash(message: string): string {
  const bytes = utf8ToBytes(message);
  return `0x${bytesToHex(keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes)))}`;
}

/** Full checksum address for copying and comparing a payment recipient. */
export function checksumAddress(address: string): string {
  if (!addressPattern.test(address)) throw new Error("Invalid wallet address");
  const lower = address.slice(2).toLowerCase();
  const hash = bytesToHex(hashText(lower));
  return `0x${[...lower].map((c, i) => (Number.parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join("")}`;
}

/** A signed payment identity. It proves key control, not work quality or identity. */
export interface PaymentWallet {
  event: Event;
  address: string;
  chain: number;
  expires: number;
}

/**
 * What a smart account's proof still needs asked of the chain: its signature is not an `ecrecover`-able 65 bytes but
 * whatever the account contract accepts (a passkey account's is a few hundred bytes), so only the account itself can
 * say whether it is valid.
 */
interface ContractCheck {
  account: string;
  chain: number;
  /** The EIP-712 digest that was signed. */
  digest: string;
  signature: string;
}

/** Asks the chain whether `account` accepts `signature` over `digest`. Throws when the chain cannot be asked. */
export type ChainChecker = (check: ContractCheck) => Promise<boolean>;

/**
 * Whether a proof's signature is a smart account's rather than an ordinary wallet's: valid hex that is not exactly 65
 * bytes. Anything else is left for the ordinary check to refuse.
 */
export function isContractSignature(signature: unknown): boolean {
  return (
    typeof signature === "string" &&
    /^0x([0-9a-f]{2})+$/i.test(signature) &&
    signature.length !== 132
  );
}

export type PaymentWalletResult =
  | { state: "verified"; wallet: PaymentWallet }
  /**
   * Sound as far as this device can tell (the Nostr signature, the fields, the expiry), but signed by a smart
   * account: it is not verified until the chain says so, and a reader that does not ask treats it as not verified.
   */
  | { state: "unchecked"; wallet: PaymentWallet; check: ContractCheck }
  | {
      state: "absent" | "revoked" | "expired" | "invalid" | "unreachable";
      event?: Event;
    };

/** Latest authenticated statement wins, including revocation and expired proofs. */
export function resolvePaymentWallet(
  events: readonly Event[],
  pubkey: string,
  now: number,
): PaymentWalletResult {
  const latest = events
    .filter((e) => {
      try {
        return (
          e.kind === KIND_EVM_BINDING &&
          e.pubkey === pubkey &&
          verifyEvent({
            id: e.id,
            pubkey: e.pubkey,
            kind: e.kind,
            created_at: e.created_at,
            content: e.content,
            tags: e.tags,
            sig: e.sig,
          })
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  if (!latest) return { state: "absent" };
  try {
    if (latest.content.length > 8192 || latest.created_at > now + 60)
      throw new Error("Invalid record");
    const body = JSON.parse(latest.content);
    const tag = (name: string) => {
      const tags = latest.tags.filter((t) => t[0] === name);
      if (tags.length !== 1) throw new Error("Ambiguous wallet proof");
      return tags[0][1];
    };
    const address = tag("d");
    const chain = Number(tag("chain"));
    if (
      body.v !== 1 ||
      !addressPattern.test(address) ||
      address === ZERO ||
      address !== address.toLowerCase() ||
      tag("address") !== address ||
      body.address !== address ||
      !Number.isSafeInteger(chain) ||
      chain <= 0 ||
      String(chain) !== tag("chain") ||
      !/^0x[0-9a-f]{64}$/i.test(body.siweMessageHash)
    ) {
      throw new Error("Inconsistent wallet proof");
    }
    if (body.revoked === true) return { state: "revoked", event: latest };
    if (body.revoked !== undefined && body.revoked !== false)
      throw new Error("Invalid revocation");
    const proof = body.attestation as WalletAttestation;
    if (
      proof.domain.chain_id !== chain ||
      proof.attestation.account !== address ||
      bytesToHex(Uint8Array.from(proof.attestation.npub)) !== pubkey
    ) {
      throw new Error("Wallet signature does not match this account");
    }
    if (isContractSignature(proof.signature)) {
      if (proof.attestation.expires < now)
        return { state: "expired", event: latest };
      const wallet: PaymentWallet = {
        event: latest,
        address: checksumAddress(address),
        chain,
        expires: proof.attestation.expires,
      };
      return {
        state: "unchecked",
        wallet,
        check: {
          account: address,
          chain,
          digest: `0x${bytesToHex(walletAttestationDigest(proof))}`,
          signature: proof.signature,
        },
      };
    }
    if (
      recoverWallet(walletAttestationDigest(proof), proof.signature) !== address
    ) {
      throw new Error("Wallet signature does not match this account");
    }
    if (proof.attestation.expires < now)
      return { state: "expired", event: latest };
    return {
      state: "verified",
      wallet: {
        event: latest,
        address: checksumAddress(address),
        chain,
        expires: proof.attestation.expires,
      },
    };
  } catch {
    return { state: "invalid", event: latest };
  }
}

/**
 * Settle a proof that needs the chain. A smart account's proof is verified exactly when the account says its signature
 * is valid; if it says no, the proof is invalid; if the chain cannot be asked (no connection to that network, a node
 * that does not answer), it is `unreachable`, which is neither a yes nor a claim that the proof is false. Without a
 * `checker` nothing is ever upgraded, so a reader that cannot ask never shows a smart account's address as verified.
 */
export async function confirmPaymentWallet(
  result: PaymentWalletResult,
  checker: ChainChecker | undefined,
): Promise<PaymentWalletResult> {
  if (result.state !== "unchecked") return result;
  if (!checker) return { state: "unreachable", event: result.wallet.event };
  try {
    return (await checker(result.check))
      ? { state: "verified", wallet: result.wallet }
      : { state: "invalid", event: result.wallet.event };
  } catch {
    return { state: "unreachable", event: result.wallet.event };
  }
}

/** [`resolvePaymentWallet`], then the chain's word for a smart account's proof. */
export async function resolvePaymentWalletChecked(
  events: readonly Event[],
  pubkey: string,
  now: number,
  checker: ChainChecker | undefined,
): Promise<PaymentWalletResult> {
  return confirmPaymentWallet(
    resolvePaymentWallet(events, pubkey, now),
    checker,
  );
}
