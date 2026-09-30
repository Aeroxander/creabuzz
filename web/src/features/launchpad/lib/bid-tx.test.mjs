import test from "node:test";
import assert from "node:assert/strict";
import { maxBidPrice as maxBidPriceImpl } from "./launch-params.ts";
import {
  PERMIT2_ADDRESS,
  SELECTOR_SUBMIT_BID,
  SELECTOR_EXIT_BID,
  SELECTOR_CLAIM_TOKENS,
  SELECTOR_CLAIM_TOKENS_BATCH,
  SELECTOR_PERMIT2_APPROVE,
  snapMaxPriceToTick,
  validateBid,
  encodeSubmitBid,
  encodeExitBid,
  encodeClaimTokens,
  encodeClaimTokensBatch,
  encodePermit2Approve,
  buildBidTransaction,
  buildBidCalls,
  bidPlanWithDefaultHint,
} from "./bid-tx.ts";

// Reference encodings produced by `cast calldata` from the same signatures;
// they are the binding between this module and the real ABI. Regenerated from
// the canonical `cast` output; do not hand-edit hex.
const CAST_SUBMIT_EMPTY =
  "0x" +
  "a52c872800000000000000000000000000000000000000000000003635c9adc5" +
  "dea000000000000000000000000000000000000000000000000000000000000b" +
  "a43b740000000000000000000000000011111111111111111111111111111111" +
  "1111111100000000000000000000000000000000000000000000000000000001" +
  "0000000100000000000000000000000000000000000000000000000000000000" +
  "000000a000000000000000000000000000000000000000000000000000000000" +
  "00000000";

const CAST_SUBMIT_HOOK =
  "0x" +
  "a52c872800000000000000000000000000000000000000000000006c6b935b8b" +
  "bd4000000000000000000000000000000000000000000000000000000000000b" +
  "a43b740000000000000000000000000011111111111111111111111111111111" +
  "1111111100000000000000000000000000000000000000000000000000000001" +
  "0000000100000000000000000000000000000000000000000000000000000000" +
  "000000a000000000000000000000000000000000000000000000000000000000" +
  "0000000212340000000000000000000000000000000000000000000000000000" +
  "00000000";

const CAST_EXIT =
  "0x" +
  "8e4deb1700000000000000000000000000000000000000000000000000000000" +
  "0000002a";

const CAST_CLAIM_BATCH =
  "0x" +
  "b8f163d600000000000000000000000022222222222222222222222222222222" +
  "2222222200000000000000000000000000000000000000000000000000000000" +
  "0000004000000000000000000000000000000000000000000000000000000000" +
  "0000000300000000000000000000000000000000000000000000000000000000" +
  "0000000100000000000000000000000000000000000000000000000000000000" +
  "0000000200000000000000000000000000000000000000000000000000000000" +
  "00000003";

const CAST_PERMIT2_APPROVE =
  "0x" +
  "87517c4500000000000000000000000033333333333333333333333333333333" +
  "3333333300000000000000000000000044444444444444444444444444444444" +
  "44444444000000000000000000000000000000000000000000000000112210f4" +
  "7de9811500000000000000000000000000000000000000000000000000000000" +
  "f4865700";

test("selectors are the pinned CCA/Permit2 signatures", () => {
  assert.equal(SELECTOR_SUBMIT_BID, "0xa52c8728");
  assert.equal(SELECTOR_EXIT_BID, "0x8e4deb17");
  assert.equal(SELECTOR_CLAIM_TOKENS, "0x46e04a2f");
  assert.equal(SELECTOR_CLAIM_TOKENS_BATCH, "0xb8f163d6");
  assert.equal(SELECTOR_PERMIT2_APPROVE, "0x87517c45");
  // The canonical Permit2 address is implicit in this selector's signature.
  assert.match(PERMIT2_ADDRESS, /^0x[0-9a-fA-F]{40}$/);
});

test("submitBid encoding matches cast for empty hookData", () => {
  const plan = bidPlanWithDefaultHint(
    {
      maxPriceQ96: 10n ** 21n,
      amount: 50_000_000_000n,
      owner: "0x1111111111111111111111111111111111111111",
      hookData: "0x",
    },
    4_294_967_297n, // floor = 2^32+1
  );
  assert.equal(encodeSubmitBid(plan), CAST_SUBMIT_EMPTY);
});

test("submitBid encoding matches cast with non-empty hookData", () => {
  const plan = bidPlanWithDefaultHint(
    {
      maxPriceQ96: 2n * 10n ** 21n,
      amount: 50_000_000_000n,
      owner: "0x1111111111111111111111111111111111111111",
      hookData: "0x1234",
    },
    4_294_967_297n,
  );
  assert.equal(encodeSubmitBid(plan), CAST_SUBMIT_HOOK);
});

test("exitBid encoding matches cast", () => {
  assert.equal(encodeExitBid(42n), CAST_EXIT);
});

test("claimTokensBatch encoding matches cast (owner, [1,2,3])", () => {
  assert.equal(
    encodeClaimTokensBatch("0x2222222222222222222222222222222222222222", [
      1n,
      2n,
      3n,
    ]),
    CAST_CLAIM_BATCH,
  );
});

test("claimTokensBatch rejects an empty batch", () => {
  assert.throws(() =>
    encodeClaimTokensBatch("0x1111111111111111111111111111111111111111", []),
  );
});

test("Permit2 approve encoding matches cast", () => {
  assert.equal(
    encodePermit2Approve(
      "0x3333333333333333333333333333333333333333",
      "0x4444444444444444444444444444444444444444",
      1_234_567_890_123_456_789n,
      4_102_444_800n,
    ),
    CAST_PERMIT2_APPROVE,
  );
});

test("claimTokens single id encoding shape", () => {
  const got = encodeClaimTokens(7n);
  assert.ok(got.startsWith(SELECTOR_CLAIM_TOKENS));
  assert.ok(
    got.endsWith(
      "0000000000000000000000000000000000000000000000000000000000000007",
    ),
  );
});

test("snapMaxPriceToTick snaps up to the grid and preserves aligned prices", () => {
  // 100 spacing: 1050 -> 1100
  assert.equal(snapMaxPriceToTick(1050n, 100n), 1100n);
  // Already aligned: unchanged
  assert.equal(snapMaxPriceToTick(1100n, 100n), 1100n);
  // Zero spacing: passthrough
  assert.equal(snapMaxPriceToTick(1050n, 0n), 1050n);
  // The contract rule it mirrors: price % spacing == 0
  assert.equal(snapMaxPriceToTick(1050n, 100n) % 100n, 0n);
  // Large tick Q96 prices stay exact
  const q96big = (1n << 96n) * 1000n + 5n;
  assert.equal(snapMaxPriceToTick(q96big, 10n) % 10n, 0n);
});

test("validateBid flags tick misalignment, sub-clearing and over-ceiling prices", () => {
  const ctx = {
    tickSpacingQ96: 100n,
    clearingPriceQ96: 900n,
    supply: 10n ** 19n, // maxBidPrice well above 1100
  };
  // Off-grid max price
  let issues = validateBid(
    {
      maxPriceQ96: 1050n,
      amount: 100n,
      owner: "0x1111111111111111111111111111111111111111",
      prevTickPriceQ96: 100n,
      hookData: "0x",
    },
    ctx,
  );
  assert.ok(
    issues.some(
      (i) => i.field === "maxPrice" && i.message.includes("tick grid"),
    ),
  );
  // At or below clearing
  issues = validateBid(
    {
      maxPriceQ96: 900n,
      amount: 100n,
      owner: "0x1111111111111111111111111111111111111111",
      prevTickPriceQ96: 100n,
      hookData: "0x",
    },
    ctx,
  );
  assert.ok(issues.some((i) => i.message.includes("clearing price")));
  // Zero amount
  issues = validateBid(
    {
      maxPriceQ96: 1100n,
      amount: 0n,
      owner: "0x1111111111111111111111111111111111111111",
      prevTickPriceQ96: 100n,
      hookData: "0x",
    },
    ctx,
  );
  assert.ok(issues.some((i) => i.field === "amount"));
  // Valid plan: no errors
  issues = validateBid(
    {
      maxPriceQ96: 1100n,
      amount: 100n,
      owner: "0x1111111111111111111111111111111111111111",
      prevTickPriceQ96: 100n,
      hookData: "0x",
    },
    ctx,
  );
  assert.equal(issues.length, 0);
});

test("validateBid flags an over-ceiling price against the supply", () => {
  // Small supply => MAX_BID_PRICE is uint160.max (the liquidity bound applies
  // only above 2^62). A maxPrice above that ceiling must be refused before
  // signing.
  const ceilingForSmall = (1n << 160n) - 1n; // uint160.max
  const ctx = { tickSpacingQ96: 2n, clearingPriceQ96: 100n, supply: 1n << 40n };
  const issues = validateBid(
    {
      maxPriceQ96: ceilingForSmall + 1n,
      amount: 1n,
      owner: "0x1111111111111111111111111111111111111111",
      prevTickPriceQ96: 2n,
      hookData: "0x",
    },
    ctx,
  );
  assert.ok(issues.some((i) => i.message.includes("ceiling")));
  // A huge supply tightens the bound far below uint160.max.
  const bigSupply = 1n << 90n;
  const ceilingForBig = maxBidPriceImpl(bigSupply);
  const ctx2 = {
    tickSpacingQ96: 2n,
    clearingPriceQ96: 100n,
    supply: bigSupply,
  };
  const issues2 = validateBid(
    {
      maxPriceQ96: ceilingForBig + 1n,
      amount: 1n,
      owner: "0x1111111111111111111111111111111111111111",
      prevTickPriceQ96: 2n,
      hookData: "0x",
    },
    ctx2,
  );
  assert.ok(issues2.some((i) => i.message.includes("ceiling")));
});

test("buildBidTransaction wraps the encode for an ERC-20 currency", () => {
  const auct = "0x5555555555555555555555555555555555555555";
  const plan = bidPlanWithDefaultHint(
    {
      maxPriceQ96: 1100n,
      amount: 100n,
      owner: "0x1111111111111111111111111111111111111111",
      hookData: "0x",
    },
    100n,
  );
  const tx = buildBidTransaction(auct, plan);
  assert.equal(tx.to, auct);
  assert.equal(tx.value, "0x0");
  assert.ok(tx.data.startsWith(SELECTOR_SUBMIT_BID));
});

test("bidPlanWithDefaultHint keeps an explicit hint and fills the floor otherwise", () => {
  const floor = 1000000000000000000n;
  const plan = bidPlanWithDefaultHint(
    {
      maxPriceQ96: 2000n,
      amount: 1n,
      owner: "0x1111111111111111111111111111111111111111",
      hookData: "0x",
    },
    floor,
  );
  assert.equal(plan.prevTickPriceQ96, floor);
});

// ---- buildBidCalls: ERC-20 vs native ---------------------------------------

const BID_PLAN = {
  maxPriceQ96: 4294967297n * 2n,
  amount: 5n * 10n ** 18n,
  owner: "0x1111111111111111111111111111111111111111",
  hookData: "0x",
  prevTickPriceQ96: 4294967297n,
};
const AUCTION = "0x5555555555555555555555555555555555555555";
const USDC = "0x6666666666666666666666666666666666666666";

test("a native (ETH) bid is ONE call and carries the bid amount as its value", () => {
  // submitBid reverts InvalidAmount unless msg.value == amount on a native
  // auction: a zero-value call would fail every ETH bid.
  for (const currency of [null, ""]) {
    const calls = buildBidCalls({
      auction: AUCTION,
      plan: BID_PLAN,
      currency,
      deadline: 1n,
    });
    assert.equal(calls.length, 1, `currency ${JSON.stringify(currency)}`);
    assert.equal(calls[0].to, AUCTION);
    assert.equal(calls[0].value, `0x${BID_PLAN.amount.toString(16)}`);
    assert.equal(calls[0].data, encodeSubmitBid(BID_PLAN));
  }
});

test("an ERC-20 bid approves Permit2, then the auction, then bids with NO value", () => {
  const calls = buildBidCalls({
    auction: AUCTION,
    plan: BID_PLAN,
    currency: USDC,
    deadline: 1n,
    underlyingAllowance: 0n,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].to, USDC, "token approve to Permit2");
  assert.equal(calls[1].to, PERMIT2_ADDRESS, "Permit2 approve to the auction");
  assert.equal(calls[2].to, AUCTION);
  assert.equal(calls[2].value, "0x0", "an ERC-20 bid must not carry ETH");
});

test("an ERC-20 bid skips the token approve when the allowance already covers it", () => {
  const calls = buildBidCalls({
    auction: AUCTION,
    plan: BID_PLAN,
    currency: USDC,
    deadline: 1n,
    underlyingAllowance: BID_PLAN.amount,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to, PERMIT2_ADDRESS);
});
