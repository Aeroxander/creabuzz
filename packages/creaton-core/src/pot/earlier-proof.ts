/**
 * The earlier backers' list as the claim contract checks it (`contracts/pot/src/EarlierGrants.sol`): a Merkle tree whose leaf
 * is `keccak256(keccak256(abi.encode(index, account, amount)))` (the double hash keeps an inner node from passing as a row) and
 * whose inner nodes hash their two children in sorted order (the OpenZeppelin rule). This file builds a leaf, checks a proof
 * against a root, and builds a whole tree from rows given to it. It holds no row: a caller brings its own, and the tests bring
 * invented ones. The app uses `verifyEarlierRow` to tell a person, before any signature, that a link is not for their account.
 */
import { encodeParameters, keccak256Hex } from "../launchpad/evmAbi.ts";

const HASH = /^0x[0-9a-f]{64}$/;

/** One row of the list: its place, the account it names and the Team Share wei it grants. */
export interface EarlierRow {
  index: bigint;
  account: string;
  amount: bigint;
}

/** The leaf of a row, as the contract computes it for `msg.sender == account`. */
export function earlierLeaf(row: EarlierRow): string {
  const inner = keccak256Hex(
    encodeParameters(
      ["uint256", "address", "uint256"],
      [row.index, row.account, row.amount],
    ),
  );
  return keccak256Hex(inner);
}

function pairHash(a: string, b: string): string {
  const [low, high] = a < b ? [a, b] : [b, a];
  return keccak256Hex(`${low}${high.slice(2)}`);
}

/** Whether `proof` takes `leaf` to `root` (hashes are 0x and 64 hex characters, compared in lower case). */
export function verifyEarlierProof(
  proof: readonly string[],
  root: string,
  leaf: string,
): boolean {
  if (!HASH.test(root.toLowerCase()) || !HASH.test(leaf.toLowerCase()))
    return false;
  let computed = leaf.toLowerCase();
  for (const step of proof) {
    if (!HASH.test(step.toLowerCase())) return false;
    computed = pairHash(computed, step.toLowerCase());
  }
  return computed === root.toLowerCase();
}

/** Whether a row, with its proof, is in the list whose fingerprint is `root`. */
export function verifyEarlierRow(
  row: EarlierRow,
  proof: readonly string[],
  root: string,
): boolean {
  return verifyEarlierProof(proof, root, earlierLeaf(row));
}

/** A tree built from rows: its root and each row's proof. */
export interface EarlierTree {
  root: string;
  proofOf: (position: number) => string[];
}

/**
 * Build the tree of `rows` (their order is their position in the tree; the contract reads each row's own `index`). An odd node
 * is carried up unpaired, as the OpenZeppelin tree does. A list needs at least one row.
 */
export function buildEarlierTree(rows: readonly EarlierRow[]): EarlierTree {
  if (rows.length === 0) throw new Error("A list needs at least one row.");
  const levels: string[][] = [rows.map(earlierLeaf)];
  while ((levels[levels.length - 1] as string[]).length > 1) {
    const level = levels[levels.length - 1] as string[];
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as string;
      const right = level[i + 1];
      next.push(right === undefined ? left : pairHash(left, right));
    }
    levels.push(next);
  }
  return {
    root: (levels[levels.length - 1] as string[])[0] as string,
    proofOf(position) {
      if (
        !Number.isInteger(position) ||
        position < 0 ||
        position >= rows.length
      )
        throw new Error("That position is not in the list.");
      const proof: string[] = [];
      let at = position;
      for (let l = 0; l < levels.length - 1; l += 1) {
        const level = levels[l] as string[];
        const sibling = level[at % 2 === 0 ? at + 1 : at - 1];
        if (sibling !== undefined) proof.push(sibling);
        at = Math.floor(at / 2);
      }
      return proof;
    },
  };
}
