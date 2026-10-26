import assert from "node:assert/strict";
import { test } from "node:test";

import { KIND_EXIT_OFFER } from "../kinds.generated.ts";
import { describeDecision } from "./decisionDescribe.ts";
import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
import {
  allowExitSalesDecision,
  distinctOffers,
  encodeCancelBelow,
  encodeCancelOffer,
  encodeFill,
  EXIT_EXCHANGE_SIGNATURES,
  exitOfferDigest,
  exitOfferTemplate,
  exitOfferTypedData,
  exitSalesState,
  exitTopic,
  MATCHED_EXIT_SIGNATURES,
  parseExitOffer,
  readExitExchange,
  readOfferStatus,
  stopExitSalesDecision,
} from "./matchedExit.ts";
import { UNLOCK_NOTICE } from "./tradingActions.ts";
import { encodeAllowance, encodeBalanceOf } from "./workBounty.ts";

const EXCHANGE = "0x00000000000000000000000000000000000e1717";
const SHARES = "0x0000000000000000000000000000000000000005";
const SELLER = "0x0000000000000000000000000000000000000006";
const WAD = 10n ** 18n;
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = (...v) => `0x${v.map(word).join("")}`;

const terms = (over = {}) => ({
  chainId: 31337,
  exchange: EXCHANGE,
  shares: SHARES,
  seller: SELLER,
  amount: 10n * WAD,
  price: 120_000_000n,
  expiry: 1_790_000_000,
  nonce: 1n,
  ...over,
});
const offer = (over = {}) => ({ ...terms(), signature: "0xabcd", ...over });

// ---- the contract's own words ---------------------------------------------------------------------

test("the selectors are the contracts' (cast sig goldens)", () => {
  const sig = (s) => selectorOf(s);
  assert.equal(sig(MATCHED_EXIT_SIGNATURES.fill), "0x7d19b8e6");
  assert.equal(sig(MATCHED_EXIT_SIGNATURES.cancel), "0x62fe809f");
  assert.equal(sig(MATCHED_EXIT_SIGNATURES.cancelBelow), "0xf28ad83b");
  assert.equal(sig(MATCHED_EXIT_SIGNATURES.isOpen), "0xe8ba5790");
  assert.equal(sig(MATCHED_EXIT_SIGNATURES.minNonce), "0xaa99fa98");
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.announce), "0x0ac75141");
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.activate), "0x137f703a");
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.clear), "0x838cf4ee");
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.exchange), "0x6e80cd03");
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.pending), "0x6cb21d83");
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.announcedAt), "0x952e389a");
});

test("the calls are cast calldata goldens", () => {
  assert.equal(
    encodeFill(offer()),
    "0x7d19b8e6000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000008ac7230489e800000000000000000000000000000000000000000000000000000000000007270e00000000000000000000000000000000000000000000000000000000006ab13b80000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000002abcd000000000000000000000000000000000000000000000000000000000000",
  );
  assert.equal(
    encodeCancelOffer(terms()),
    "0x62fe809f000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000008ac7230489e800000000000000000000000000000000000000000000000000000000000007270e00000000000000000000000000000000000000000000000000000000006ab13b800000000000000000000000000000000000000000000000000000000000000001",
  );
  assert.equal(
    encodeCancelBelow(7n),
    "0xf28ad83b0000000000000000000000000000000000000000000000000000000000000007",
  );
  assert.throws(() => encodeCancelBelow(0n), /offer number/);
});

test("the digest is the exchange's digestOf (pinned in MatchedExit.t.sol) and every term changes it", () => {
  const digest =
    "0x92553589ffa8748d01f97ea67137cca6c5d77830dfad65ac9367097508f86ae4";
  assert.equal(exitOfferDigest(terms()), digest);
  assert.equal(
    exitOfferDigest(
      terms({ exchange: EXCHANGE.toUpperCase().replace("0X", "0x") }),
    ),
    digest,
  );
  for (const change of [
    { chainId: 1 },
    { exchange: SELLER },
    { shares: SELLER },
    { seller: SHARES },
    { amount: 1n },
    { price: 1n },
    { expiry: 1 },
    { nonce: 2n },
  ]) {
    assert.notEqual(
      exitOfferDigest(terms(change)),
      digest,
      JSON.stringify(change, (_, v) => (typeof v === "bigint" ? `${v}` : v)),
    );
  }
});

test("the typed data a wallet signs names the exchange's domain and the offer's terms", () => {
  const typed = exitOfferTypedData(terms());
  assert.equal(typed.primaryType, "Offer");
  assert.deepEqual(typed.domain, {
    name: "Creaton matched exit",
    version: "1",
    chainId: 31337,
    verifyingContract: EXCHANGE,
  });
  assert.deepEqual(typed.message, {
    shares: SHARES,
    seller: SELLER,
    amount: "10000000000000000000",
    price: "120000000",
    expiry: "1790000000",
    nonce: "1",
  });
  assert.deepEqual(
    typed.types.Offer.map((f) => `${f.type} ${f.name}`).join(","),
    "address shares,address seller,uint256 amount,uint256 price,uint64 expiry,uint256 nonce",
  );
  assert.throws(() => exitOfferTypedData(terms({ amount: 0n })), /amount/);
  assert.throws(() => exitOfferTypedData(terms({ price: 0n })), /price/);
});

// ---- the record ----------------------------------------------------------------------------------

test("an offer record is tagged with its DAO's Shares and reads back to the same offer", () => {
  const record = exitOfferTemplate(offer());
  assert.equal(record.kind, KIND_EXIT_OFFER);
  assert.deepEqual(record.tags, [["t", `exit:31337:${SHARES}`]]);
  assert.equal(
    exitTopic(31337, SHARES.toUpperCase().replace("0X", "0x")),
    `exit:31337:${SHARES}`,
  );
  assert.deepEqual(parseExitOffer(record), offer());
  assert.throws(
    () => exitOfferTemplate(offer({ signature: `0x${"ab".repeat(1000)}` })),
    /too long/,
  );
});

test("a record the server would refuse, or one the exchange could not fill, is not read as an offer", () => {
  const good = exitOfferTemplate(offer());
  const body = JSON.parse(good.content);
  const withBody = (over) => ({
    ...good,
    content: JSON.stringify({ ...body, ...over }),
  });
  assert.equal(parseExitOffer({ ...good, kind: 1 }), null);
  assert.equal(parseExitOffer({ ...good, content: "[1]" }), null);
  assert.equal(parseExitOffer({ ...good, content: "nope" }), null);
  assert.equal(parseExitOffer({ ...good, tags: [] }), null);
  assert.equal(
    parseExitOffer({ ...good, tags: [["t", `exit:1:${SHARES}`]] }),
    null,
    "the tag names another network",
  );
  for (const over of [
    { amount: "0" },
    { amount: "01" },
    { amount: 5 },
    { price: "0" },
    { nonce: "-1" },
    { expiry: "1" },
    { expiry: 1.5 },
    { seller: "0x6" },
    { signature: "abcd" },
    { signature: "0xabc" },
    { chainId: "31337" },
  ]) {
    assert.equal(parseExitOffer(withBody(over)), null, JSON.stringify(over));
  }
});

test("each offer counts once, only for this exchange and these Shares, unexpired, cheapest per Share first", () => {
  const scope = { chainId: 31337, exchange: EXCHANGE, shares: SHARES };
  const cheap = offer({ amount: 10n * WAD, price: 100n, nonce: 2n });
  const dear = offer({ amount: 1n * WAD, price: 100n, nonce: 3n });
  const kept = distinctOffers(
    [
      dear,
      cheap,
      { ...cheap, signature: "0xffff" }, // the same terms again: the same offer
      offer({ nonce: 4n, chainId: 1 }),
      offer({ nonce: 5n, exchange: SELLER }),
      offer({ nonce: 6n, shares: SELLER }),
      offer({ nonce: 7n, expiry: 1_000 }),
    ],
    scope,
    1_000,
  );
  assert.deepEqual(
    kept.map((o) => o.nonce),
    [2n, 3n],
  );
});

// ---- decisions -----------------------------------------------------------------------------------

test("the votes name the exchange on the Shares or turn it off, and read back in the same words", () => {
  const allow = allowExitSalesDecision({
    sharesToken: SHARES,
    exchange: EXCHANGE,
  });
  assert.equal(allow.to, SHARES);
  assert.equal(
    allow.data,
    "0x0ac7514100000000000000000000000000000000000000000000000000000000000e1717",
  );
  assert.equal(allow.lane, "unrestricted");
  const ctx = { projectToken: SHARES, matchedExit: EXCHANGE };
  assert.equal(describeDecision(allow, ctx).title, allow.title);
  const stop = stopExitSalesDecision({ sharesToken: SHARES });
  assert.equal(stop.data, "0x838cf4ee");
  assert.deepEqual(describeDecision(stop, ctx), {
    kind: "trading",
    title: stop.title,
    lines: stop.lines,
  });
  assert.throws(
    () => allowExitSalesDecision({ sharesToken: SHARES, exchange: "" }),
    /not set up/,
  );
});

test("a vote naming any other contract as the exchange says so, and one aimed elsewhere is not described as sales", () => {
  const other = allowExitSalesDecision({
    sharesToken: SHARES,
    exchange: SELLER,
  });
  const described = describeDecision(other, {
    projectToken: SHARES,
    matchedExit: EXCHANGE,
  });
  assert.equal(described.title, "Let another contract move Shares in 30 days");
  assert.match(described.lines[0], /not the one this app knows/);
  assert.equal(
    describeDecision(other, { projectToken: SHARES }).title,
    "Let another contract move Shares in 30 days",
    "with no exchange known, nothing is called the app's",
  );
  assert.equal(
    describeDecision(
      { ...other, to: SELLER },
      { projectToken: SHARES, matchedExit: EXCHANGE },
    ).kind,
    "unknown",
  );
  assert.equal(
    describeDecision(
      {
        to: SHARES,
        data: encodeFunctionData(
          EXIT_EXCHANGE_SIGNATURES.announce,
          ["uint256"],
          [1n << 200n],
        ),
      },
      { projectToken: SHARES, matchedExit: EXCHANGE },
    ).kind,
    "unknown",
    "a word that is not an address is not an exchange",
  );
});

// ---- where it stands -----------------------------------------------------------------------------

test("sales are off, announced, ready, on, or run by an exchange this app does not know", () => {
  const read = (over = {}) => ({
    transfersLocked: true,
    exchange: null,
    pending: null,
    announcedAt: 0,
    ...over,
  });
  assert.deepEqual(exitSalesState(read(), EXCHANGE, 5), {
    phase: "off",
    opensAt: null,
  });
  const announced = read({ pending: EXCHANGE, announcedAt: 100 });
  assert.deepEqual(
    exitSalesState(announced, EXCHANGE, 100 + UNLOCK_NOTICE - 1),
    {
      phase: "announced",
      opensAt: 100 + UNLOCK_NOTICE,
    },
  );
  assert.equal(
    exitSalesState(announced, EXCHANGE, 100 + UNLOCK_NOTICE).phase,
    "ready",
  );
  assert.equal(
    exitSalesState(read({ exchange: EXCHANGE }), EXCHANGE, 0).phase,
    "on",
  );
  assert.equal(
    exitSalesState(read({ exchange: SELLER }), EXCHANGE, 0).phase,
    "other",
  );
  assert.equal(
    exitSalesState(read({ pending: SELLER }), EXCHANGE, 0).phase,
    "other",
  );
  assert.equal(
    exitSalesState(read({ exchange: EXCHANGE }), null, 0).phase,
    "other",
  );
  assert.equal(
    exitSalesState(read({ transfersLocked: false }), EXCHANGE, 0).phase,
    "unlocked",
  );
});

test("the exchange's state is read from the Shares", async () => {
  const answers = {
    [selectorOf(EXIT_EXCHANGE_SIGNATURES.transfersLocked)]: words(1),
    [selectorOf(EXIT_EXCHANGE_SIGNATURES.exchange)]: words(0),
    [selectorOf(EXIT_EXCHANGE_SIGNATURES.pending)]: words(BigInt(EXCHANGE)),
    [selectorOf(EXIT_EXCHANGE_SIGNATURES.announcedAt)]: words(77),
  };
  const chain = {
    call: async (to, data) => {
      assert.equal(to, SHARES);
      return answers[data];
    },
  };
  assert.deepEqual(await readExitExchange(chain, SHARES), {
    transfersLocked: true,
    exchange: null,
    pending: EXCHANGE,
    announcedAt: 77,
  });
});

test("an offer is fillable only while the exchange says it is open and the seller holds and allows enough", async () => {
  const status = async ({ open, balance, allowance }) =>
    readOfferStatus(
      {
        call: async (to, data) => {
          if (to === EXCHANGE) {
            assert.equal(data.slice(0, 10), "0xe8ba5790");
            return words(open ? 1 : 0);
          }
          assert.equal(to, SHARES);
          if (data === encodeBalanceOf(SELLER)) return words(balance);
          if (data === encodeAllowance(SELLER, EXCHANGE))
            return words(allowance);
          throw new Error(`unexpected ${data}`);
        },
      },
      offer(),
    );
  const enough = { open: true, balance: 10n * WAD, allowance: 10n * WAD };
  const fine = await status(enough);
  assert.equal(fine.fillable, true);
  assert.equal(fine.digest, exitOfferDigest(terms()));
  assert.equal((await status({ ...enough, open: false })).fillable, false);
  assert.equal(
    (await status({ ...enough, balance: 10n * WAD - 1n })).fillable,
    false,
  );
  assert.equal(
    (await status({ ...enough, allowance: 10n * WAD - 1n })).fillable,
    false,
  );
});
