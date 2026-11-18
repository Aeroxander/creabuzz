/**
 * How a project's own record (kind 37001, signed by its founder) is tied to its project on the chain.
 *
 * The contracts know a project by `keyOf(founder, projectId) = keccak256(abi.encode(founder, projectId))`, where
 * `founder` is the wallet that launched it and `projectId` is "the id in the founder's signed project record"
 * (Launcher.launch). The record's id is a word, not 32 bytes, so the id on the chain is the hash of the record's address:
 * `projectId = keccak256(utf8("37001:<founder's public key>:<record id>"))`.
 *
 * The founder's record names its chain key in a `chain-key` tag. A reader believes a project's numbers only when the
 * server signed them, their key is the one the record names, the key is the hash of the founder and the id they carry,
 * and that id is the hash of this record's address: a launch made for someone else's record, or a record pointing at
 * someone else's launch, shows nothing.
 *
 * Pure and alias-free: `project-chain.test.mjs` drives it under `node --test`.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encodeParameters } from "./evmAbi.ts";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

/** The name of the record tag that carries the project's chain key. */
const CHAIN_KEY_TAG = "chain-key";

/** The id a project is launched with on the chain: the hash of its record's address ("37001:<pubkey>:<id>"). */
export function projectIdOf(coordinate: string): string {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(coordinate)))}`;
}

/** The key the contracts store a project under: `keccak256(abi.encode(founder, projectId))`, lower case. */
export function chainKeyOf(founder: string, projectId: string): string {
  const encoded = encodeParameters(
    ["address", "bytes32"],
    [founder.toLowerCase(), projectId.toLowerCase()],
  );
  const bytes = Uint8Array.from(
    encoded
      .slice(2)
      .match(/../g)
      ?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
  return `0x${bytesToHex(keccak_256(bytes))}`;
}

/** The chain key a project record names, lower case, or null when it names none (or a malformed one). */
export function chainKeyFromTags(
  tags: readonly (readonly string[])[],
): string | null {
  const value = tags.find((tag) => tag[0] === CHAIN_KEY_TAG)?.[1];
  if (typeof value !== "string") return null;
  const key = value.toLowerCase();
  return BYTES32.test(key) ? key : null;
}

/**
 * The tags of a project record that names `chainKey` as its launch: any earlier `chain-key` tag is replaced, every other
 * tag is kept in order. Throws for a key that is not 32 bytes of hex, so a malformed link is never written.
 *
 * The link itself (a tag on the founder's own record, written after `Launcher.launch` lands) is the lead's proposal
 * from milestone 6 part 2 and still waits for the owner's decision.
 */
export function withChainKey(
  tags: readonly (readonly string[])[],
  chainKey: string,
): string[][] {
  const key = chainKey.toLowerCase();
  if (!BYTES32.test(key)) throw new Error("A chain key is 32 bytes of hex.");
  return [
    ...tags.filter((tag) => tag[0] !== CHAIN_KEY_TAG).map((tag) => [...tag]),
    [CHAIN_KEY_TAG, key],
  ];
}

/**
 * Whether a record of numbers (its `d` tag and the founder and id it carries) belongs to the project at `coordinate`
 * whose record names `chainKey`. All four must agree.
 */
export function numbersBelongTo(input: {
  d: string;
  founder: unknown;
  projectId: unknown;
  chainKey: string;
  coordinate: string;
}): boolean {
  const d = input.d.toLowerCase();
  if (!BYTES32.test(d) || d !== input.chainKey.toLowerCase()) return false;
  if (typeof input.founder !== "string" || typeof input.projectId !== "string")
    return false;
  const founder = input.founder.toLowerCase();
  const projectId = input.projectId.toLowerCase();
  if (!ADDRESS.test(founder) || !BYTES32.test(projectId)) return false;
  if (projectId !== projectIdOf(input.coordinate)) return false;
  return chainKeyOf(founder, projectId) === d;
}
