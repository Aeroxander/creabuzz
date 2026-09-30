// Ragequit calldata — `cast` goldens + the Moloch token-list precondition.
//
// Derivation (hermit env: `. ./bin/activate-hermit`, `cast 1.4.3-stable`):
//
//   cast sig 'ragequit(address[],uint256,uint256)'        -> 0x29f64d1a
//   cast calldata 'ragequit(address[],uint256,uint256)' \
//     '[0x0000000000000000000000000000000000000000,0x2222222222222222222222222222222222222222]' 100 0
//   cast calldata 'ragequit(address[],uint256,uint256)' \
//     '[0x0000000000000000000000000000000000000000]' 0 7
//   cast calldata 'ragequit(address[],uint256,uint256)' \
//     '[0x0000000000000000000000000000000000000000,0x1111111111111111111111111111111111111111,0xcccccccccccccccccccccccccccccccccccccccc]' 1 2
//
// The selector list from `crates/buzz-cli/src/commands/org_ragequit.rs`
// (`selectors_match_cast_sig`, READ-ONLY) is the cross-check that these
// semantics track the shipped CLI.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRagequitTx,
  encodeRagequitCalldata,
  ETH_TOKEN,
  normalizeRagequitTokens,
  RAGEQUIT_SELECTOR,
} from "./ragequit-tx.ts";

const GOLDEN_TWO_TOKENS =
  "0x29f64d1a" +
  "0000000000000000000000000000000000000000000000000000000000000060" +
  "0000000000000000000000000000000000000000000000000000000000000064" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000002" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000002222222222222222222222222222222222222222";

const GOLDEN_LOOT_ONLY =
  "0x29f64d1a" +
  "0000000000000000000000000000000000000000000000000000000000000060" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000007" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000000";

const GOLDEN_THREE_TOKENS =
  "0x29f64d1a" +
  "0000000000000000000000000000000000000000000000000000000000000060" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000002" +
  "0000000000000000000000000000000000000000000000000000000000000003" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "000000000000000000000000cccccccccccccccccccccccccccccccccccccccc";

const ZERO = ETH_TOKEN;
const TOKEN_2 = `0x${"22".repeat(20)}`;
const TOKEN_1 = `0x${"11".repeat(20)}`;
const TOKEN_C = `0x${"cc".repeat(20)}`;

test("ragequit(two tokens, 100 shares, 0 loot) matches the cast golden", () => {
  const data = encodeRagequitCalldata({
    tokens: [ZERO, TOKEN_2],
    sharesToBurn: 100n,
    lootToBurn: 0n,
  });
  assert.equal(data, GOLDEN_TWO_TOKENS);
});

test("ragequit(ETH only, 0 shares, 7 loot) matches the cast golden", () => {
  const data = encodeRagequitCalldata({
    tokens: [ZERO],
    sharesToBurn: 0n,
    lootToBurn: 7n,
  });
  assert.equal(data, GOLDEN_LOOT_ONLY);
});

test("ragequit(three tokens, 1 share, 2 loot) matches the cast golden", () => {
  const data = encodeRagequitCalldata({
    tokens: [ZERO, TOKEN_1, TOKEN_C],
    sharesToBurn: 1n,
    lootToBurn: 2n,
  });
  assert.equal(data, GOLDEN_THREE_TOKENS);
});

test("the composer normalizes order to the contract's ascending precondition", () => {
  // Moloch.sol:782 reverts unless tokens[i] > tokens[i-1]; unsorted input
  // must never reach the chain as composed bytes.
  const normalized = normalizeRagequitTokens([TOKEN_C, ZERO, TOKEN_1]);
  assert.deepEqual(normalized, [ZERO, TOKEN_1, TOKEN_C]);
  assert.equal(
    encodeRagequitCalldata({
      tokens: [TOKEN_C, ZERO, TOKEN_1],
      sharesToBurn: 1n,
      lootToBurn: 2n,
    }),
    GOLDEN_THREE_TOKENS,
    "order normalization must not change the composed bytes",
  );
});

test("duplicates collapse — the contract rejects equal adjacent tokens", () => {
  assert.deepEqual(normalizeRagequitTokens([ZERO, ZERO, TOKEN_2]), [
    ZERO,
    TOKEN_2,
  ]);
});

test("the forbidden set (shares/loot/DAO/1007) is rejected before the chain can revert", () => {
  assert.throws(
    () => normalizeRagequitTokens([ZERO, TOKEN_2], [`0x${"22".repeat(20)}`]),
    /cannot be ragequit/,
  );
  assert.throws(
    () =>
      normalizeRagequitTokens(
        [`0x${"03".repeat(20)}`],
        [`0x${"03".repeat(20)}`],
      ),
    /cannot be ragequit/,
  );
});

test("an empty token list cannot be composed (LengthMismatch would revert)", () => {
  assert.throws(() => normalizeRagequitTokens([]), /at least one token/);
});

test("a zero-total burn cannot be composed (NotOk would revert)", () => {
  assert.throws(
    () =>
      encodeRagequitCalldata({
        tokens: [ZERO],
        sharesToBurn: 0n,
        lootToBurn: 0n,
      }),
    /both be zero/,
  );
});

test("the composed call targets the DAO with zero value and the pinned selector", () => {
  const dao = `0x${"da".repeat(20)}`;
  const tx = buildRagequitTx(dao, {
    tokens: [ZERO],
    sharesToBurn: 1n,
    lootToBurn: 0n,
  });
  assert.equal(tx.to, dao);
  assert.equal(tx.value, "0x0");
  assert.ok(tx.data.startsWith(RAGEQUIT_SELECTOR));
  assert.equal(
    encodeRagequitCalldata({
      tokens: [ZERO],
      sharesToBurn: 1n,
      lootToBurn: 0n,
    }),
    tx.data,
    "buildRagequitTx must not alter the composed bytes",
  );
});
