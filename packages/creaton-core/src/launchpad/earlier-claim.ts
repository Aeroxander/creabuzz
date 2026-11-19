/**
 * The earlier backers' claim contract (`contracts/next/src/EarlierBackers.sol`), as plain data: the message a holder
 * signs, the calls (consent, cancel a replacement, deliver), the reads, the fingerprints the page checks the text against,
 * and the link fragment that carries one entry's own leaf data.
 *
 * Pure and alias-free; `earlier-claim.test.mjs` pins every value against `cast`. The contract is the source of truth: the
 * leaf data (entry, holder, amount, salt) is hashed on the chain, so it can only come from the holder's own link, never
 * be discovered from the chain, and nothing here lists other entries.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  decodeParameters,
  encodeFunctionData,
  encodeParameters,
  selectorOf,
} from "./evmAbi.ts";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

/** The EIP-712 domain name and version the contract signs under. */
const DOMAIN_NAME = "Creaton earlier backers";
const DOMAIN_VERSION = "1";

const CONSENT_FIELDS = [
  { name: "entry", type: "uint256" },
  { name: "holder", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "receiver", type: "address" },
  { name: "project", type: "bytes32" },
  { name: "textHash", type: "bytes32" },
  { name: "textVersion", type: "uint256" },
  { name: "summary", type: "string" },
  { name: "holderVersion", type: "uint256" },
  { name: "validUntil", type: "uint256" },
] as const;

const CONSENT_TYPE = `Consent(${CONSENT_FIELDS.map((f) => `${f.type} ${f.name}`).join(",")})`;
const DOMAIN_TYPE =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) => `0x${bytesToHex(bytes)}`;
const hashText = (text: string) => hex(keccak_256(utf8(text)));
const bytesOf = (data: string): Uint8Array =>
  Uint8Array.from(
    data
      .replace(/^0x/, "")
      .match(/../g)
      ?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
const hashHex = (data: string) => hex(keccak_256(bytesOf(data)));

/** The fingerprint of an agreement text or summary: `keccak256` of its UTF-8 bytes, as the contract stores it. */
export function fingerprintOf(text: string): string {
  return hashText(text);
}

/** One entry's leaf, `keccak256(abi.encode(entry, holder, amount, salt))`. */
export function leafOf(
  entry: bigint,
  holder: string,
  amount: bigint,
  salt: string,
): string {
  return hashHex(
    encodeParameters(
      ["uint256", "address", "uint256", "bytes32"],
      [entry, holder.toLowerCase(), amount, salt.toLowerCase()],
    ),
  );
}

/** What a holder signs for one entry (everything the contract's `consentDigest` hashes). */
export interface ConsentMessage {
  entry: bigint;
  holder: string;
  amount: bigint;
  receiver: string;
  /** The project's chain key (`key()` on the claim contract). */
  project: string;
  textHash: string;
  textVersion: bigint;
  /** Counsel's one-line summary, shown by the wallet as typed. */
  summary: string;
  holderVersion: bigint;
  validUntil: bigint;
}

/** The EIP-712 typed data for `eth_signTypedData_v4`, in the wallet's own wording of the field names. */
export function consentTypedData(
  chainId: number,
  contract: string,
  m: ConsentMessage,
) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Consent: CONSENT_FIELDS.map((f) => ({ ...f })),
    },
    primaryType: "Consent",
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: String(chainId),
      verifyingContract: contract.toLowerCase(),
    },
    message: {
      entry: m.entry.toString(),
      holder: m.holder.toLowerCase(),
      amount: m.amount.toString(),
      receiver: m.receiver.toLowerCase(),
      project: m.project,
      textHash: m.textHash,
      textVersion: m.textVersion.toString(),
      summary: m.summary,
      holderVersion: m.holderVersion.toString(),
      validUntil: m.validUntil.toString(),
    },
  };
}

/** The digest those typed data hash to: what the contract's `consentDigest` returns for the same message. */
export function consentDigest(
  chainId: number,
  contract: string,
  m: ConsentMessage,
): string {
  const domain = hashHex(
    encodeParameters(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        hashText(DOMAIN_TYPE),
        hashText(DOMAIN_NAME),
        hashText(DOMAIN_VERSION),
        BigInt(chainId),
        contract.toLowerCase(),
      ],
    ),
  );
  const struct = hashHex(
    encodeParameters(
      [
        "bytes32",
        "uint256",
        "address",
        "uint256",
        "address",
        "bytes32",
        "bytes32",
        "uint256",
        "bytes32",
        "uint256",
        "uint256",
      ],
      [
        hashText(CONSENT_TYPE),
        m.entry,
        m.holder.toLowerCase(),
        m.amount,
        m.receiver.toLowerCase(),
        m.project,
        m.textHash,
        m.textVersion,
        hashText(m.summary),
        m.holderVersion,
        m.validUntil,
      ],
    ),
  );
  return hashHex(`0x1901${domain.slice(2)}${struct.slice(2)}`);
}

const CONSENT_SIGNATURE =
  "consent(uint256,address,uint256,bytes32,address,bytes32,uint256,bytes)";

/**
 * The data of `consent(...)`. An empty `signature` is a call in person (only the holder may send it); a signature lets
 * anyone submit the holder's message.
 */
export function consentData(input: {
  entry: bigint;
  holder: string;
  amount: bigint;
  salt: string;
  receiver: string;
  textHash: string;
  validUntil: bigint;
  signature?: string;
}): string {
  return encodeFunctionData(
    CONSENT_SIGNATURE,
    [
      "uint256",
      "address",
      "uint256",
      "bytes32",
      "address",
      "bytes32",
      "uint256",
      "bytes",
    ],
    [
      input.entry,
      input.holder.toLowerCase(),
      input.amount,
      input.salt.toLowerCase(),
      input.receiver.toLowerCase(),
      input.textHash.toLowerCase(),
      input.validUntil,
      input.signature ?? "0x",
    ],
  );
}

/** The data of `cancelHolder(entry, amount, salt)`: the holder's one veto of a proposed replacement. */
export function cancelHolderData(
  entry: bigint,
  amount: bigint,
  salt: string,
): string {
  return encodeFunctionData(
    "cancelHolder(uint256,uint256,bytes32)",
    ["uint256", "uint256", "bytes32"],
    [entry, amount, salt.toLowerCase()],
  );
}

/** The data of `deliver(entry)`: anyone may send an agreed entry its released Shares (to its receiver only). */
export function deliverData(entry: bigint): string {
  return encodeFunctionData("deliver(uint256)", ["uint256"], [entry]);
}

const read = (
  signature: string,
  types: Parameters<typeof encodeFunctionData>[1] = [],
  values: Parameters<typeof encodeFunctionData>[2] = [],
): string => encodeFunctionData(signature, types, values);

/** Every read the claim page makes. Reads for one entry carry that entry's index only: no other entry is ever asked for. */
export const CLAIM_READS = {
  key: read("key()"),
  textHash: read("textHash()"),
  summaryHash: read("summaryHash()"),
  textVersion: read("textVersion()"),
  closed: read("closed()"),
  closeAt: read("closeAt()"),
  total: read("total()"),
  funding: read("funding()"),
  minHoldFromConsent: read("minHoldFromConsent()"),
  entryOf: (entry: bigint) => read("entryOf(uint256)", ["uint256"], [entry]),
  due: (entry: bigint) => read("due(uint256)", ["uint256"], [entry]),
  leaf: (entry: bigint) => read("leaf(uint256)", ["uint256"], [entry]),
} as const;

/** The fixed values of `CHALLENGE` and `REPLACE_WAIT`, in seconds. */
export const CLAIM_CHALLENGE_SECONDS = 21 * 86_400;
export const CLAIM_REPLACE_WAIT_SECONDS = 30 * 86_400;

/** An entry as the contract stores it (`entryOf`). Zero addresses are `null`; times are seconds, 0 for none. */
export interface ClaimEntry {
  /** The holder after a replacement; null while the holder is the one in the leaf. */
  holder: string | null;
  holderVersion: bigint;
  /** When the current consent was given; 0n while the entry is open. */
  consentAt: bigint;
  signer: string | null;
  pendingAt: bigint;
  vetoed: boolean;
  /** The proposed new holder; null when none. */
  pending: string | null;
  barred: string | null;
  receiver: string | null;
  amount: bigint;
  taken: bigint;
}

const ZERO = `0x${"0".repeat(40)}`;
const orNull = (value: string) => (value === ZERO ? null : value);

/** Read the answer of `entryOf(entry)`; throws on data that is not eleven static words. */
export function parseEntry(data: string): ClaimEntry {
  const v = decodeParameters(
    [
      "address",
      "uint32",
      "uint64",
      "address",
      "uint64",
      "bool",
      "address",
      "address",
      "address",
      "uint256",
      "uint256",
    ],
    data,
  );
  return {
    holder: orNull(v[0] as string),
    holderVersion: v[1] as bigint,
    consentAt: v[2] as bigint,
    signer: orNull(v[3] as string),
    pendingAt: v[4] as bigint,
    vetoed: v[5] as boolean,
    pending: orNull(v[6] as string),
    barred: orNull(v[7] as string),
    receiver: orNull(v[8] as string),
    amount: v[9] as bigint,
    taken: v[10] as bigint,
  };
}

/** Read a single 32-byte answer as a number. */
export function parseWord(data: string): bigint {
  return decodeParameters(["uint256"], data)[0] as bigint;
}

/** Read a single 32-byte answer as a flag. */
export function parseFlag(data: string): boolean {
  return parseWord(data) !== 0n;
}

/** Read a single 32-byte answer as lower-case hex. */
export function parseBytes32(data: string): string {
  return (decodeParameters(["bytes32"], data)[0] as string).toLowerCase();
}

/** Read a single address answer. */
export function parseAddress(data: string): string {
  return (decodeParameters(["address"], data)[0] as string).toLowerCase();
}

/** One entry's own data, as its link carries it. */
export interface ClaimLink {
  entry: bigint;
  holder: string;
  amount: bigint;
  salt: string;
}

/**
 * Read a link's fragment (`#entry=2&holder=0x..&amount=..&salt=0x..`). Null for anything missing or malformed, so a half
 * link never builds a call. The fragment never leaves the browser.
 */
export function parseClaimFragment(fragment: string): ClaimLink | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const entry = params.get("entry") ?? "";
  const amount = params.get("amount") ?? "";
  const holder = (params.get("holder") ?? "").toLowerCase();
  const salt = (params.get("salt") ?? "").toLowerCase();
  if (!/^\d{1,3}$/.test(entry) || !/^\d{1,40}$/.test(amount)) return null;
  if (!ADDRESS.test(holder) || !BYTES32.test(salt)) return null;
  if (BigInt(amount) === 0n) return null;
  return { entry: BigInt(entry), holder, amount: BigInt(amount), salt };
}

/** The fragment for one entry (what the owner's link tool writes). */
export function claimFragment(link: ClaimLink): string {
  return `#entry=${link.entry}&holder=${link.holder.toLowerCase()}&amount=${link.amount}&salt=${link.salt.toLowerCase()}`;
}

/** The first four bytes of `consent(...)`, so a wallet stand-in can tell it from other calls. */
export const CONSENT_SELECTOR = selectorOf(CONSENT_SIGNATURE);
