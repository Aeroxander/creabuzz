// The earlier list's leaf and tree, against `cast keccak` and `cast abi-encode` (the contract's own rule), with INVENTED rows
// (anvil's public development accounts and amounts chosen here). Run with: node --experimental-strip-types --test src/pot/earlier-proof.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEarlierTree,
  earlierLeaf,
  verifyEarlierProof,
  verifyEarlierRow,
} from "./earlier-proof.ts";

const A0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cFFFb92266";
const A1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const A2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const A3 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const e18 = 10n ** 18n;

test("a leaf is the double hash of abi.encode(index, account, amount), pinned against cast", () => {
  // cast keccak $(cast abi-encode "f(uint256,address,uint256)" 0 <A0> 1000e18) then cast keccak of that
  assert.equal(
    earlierLeaf({ index: 0n, account: A0, amount: 1000n * e18 }),
    "0xa99f83ac05276adb4cd78725f1ad23abf3e2e9e3a1bbd65b5461ca2749f9780f",
  );
  assert.equal(
    earlierLeaf({ index: 1n, account: A1, amount: 2500n * e18 }),
    "0x08ce55ebbf48e77dd91d38234b1d46aab5f529985c5bccc4e5069d5c83821031",
  );
  assert.equal(
    earlierLeaf({ index: 3n, account: A1, amount: 5n * e18 }),
    "0x8d04bdb87900db76fd26a17d439a104a0aec6c08123ca220aa81470aba2c33e1",
  );
});

test("a two-row tree's root is the sorted pair hash, pinned against cast", () => {
  const rows = [
    { index: 0n, account: A0, amount: 1000n * e18 },
    { index: 1n, account: A1, amount: 2500n * e18 },
  ];
  const tree = buildEarlierTree(rows);
  // cast keccak 0x<leaf1><leaf0> (the smaller leaf first)
  assert.equal(
    tree.root,
    "0x34e39918bc4a5c9316e84012b18b70be1b50124fa143bbb10633442fadeee497",
  );
  assert.deepEqual(tree.proofOf(0), [earlierLeaf(rows[1])]);
  assert.deepEqual(tree.proofOf(1), [earlierLeaf(rows[0])]);
});

test("every row of a tree of any size proves, and only for its own account, index and amount", () => {
  for (const n of [1, 2, 3, 4, 5, 8, 9]) {
    const accounts = [A0, A1, A2, A3];
    const rows = Array.from({ length: n }, (_, i) => ({
      index: BigInt(i),
      account: accounts[i % 4],
      amount: BigInt(i + 1) * 10n * e18,
    }));
    const tree = buildEarlierTree(rows);
    rows.forEach((row, i) => {
      const proof = tree.proofOf(i);
      assert.ok(verifyEarlierRow(row, proof, tree.root), `n=${n} row ${i}`);
      // another account, another amount, another index: no
      assert.equal(
        verifyEarlierRow(
          { ...row, account: A3 === row.account ? A2 : A3 },
          proof,
          tree.root,
        ),
        false,
      );
      assert.equal(
        verifyEarlierRow({ ...row, amount: row.amount + 1n }, proof, tree.root),
        false,
      );
      assert.equal(
        verifyEarlierRow({ ...row, index: row.index + 100n }, proof, tree.root),
        false,
      );
    });
  }
});

test("an inner node never passes as a row (the double hash), and a proof that is cut or padded fails", () => {
  const rows = [0, 1, 2, 3].map((i) => ({
    index: BigInt(i),
    account: [A0, A1, A2, A3][i],
    amount: 10n * e18,
  }));
  const tree = buildEarlierTree(rows);
  const proof = tree.proofOf(0);
  assert.equal(proof.length, 2);
  // a single hash of the row is not its leaf
  assert.equal(
    verifyEarlierProof(proof, tree.root, `0x${"11".repeat(32)}`),
    false,
  );
  assert.equal(
    verifyEarlierProof(proof.slice(1), tree.root, earlierLeaf(rows[0])),
    false,
  );
  assert.equal(
    verifyEarlierProof([...proof, proof[0]], tree.root, earlierLeaf(rows[0])),
    false,
  );
  // not a hash at all
  assert.equal(
    verifyEarlierProof(["0x12"], tree.root, earlierLeaf(rows[0])),
    false,
  );
  assert.equal(verifyEarlierProof(proof, "0x12", earlierLeaf(rows[0])), false);
});

test("an empty list and a position outside it are refused", () => {
  assert.throws(() => buildEarlierTree([]));
  const tree = buildEarlierTree([{ index: 0n, account: A0, amount: e18 }]);
  assert.throws(() => tree.proofOf(1));
  assert.deepEqual(tree.proofOf(0), []);
});
