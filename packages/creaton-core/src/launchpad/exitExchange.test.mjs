import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDecision } from "./decisionDescribe.ts";
import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
import {
  EXIT_EXCHANGE_SIGNATURES,
  stopExchangeDecision,
} from "./exitExchange.ts";

const FORMER_ROUNDS = "0x00000000000000000000000000000000000e1717";
const SHARES = "0x0000000000000000000000000000000000000005";
const OTHER = "0x0000000000000000000000000000000000000006";

test("the selectors are the Shares' (cast sig goldens)", () => {
  const sig = (s) => selectorOf(s);
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.announce), "0x0ac75141");
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.clear), "0x838cf4ee");
});

test("a vote that turns the exchange off reads back in the same words", () => {
  const ctx = { projectToken: SHARES };
  const stop = stopExchangeDecision({ sharesToken: SHARES });
  assert.equal(stop.to, SHARES);
  assert.equal(stop.data, "0x838cf4ee");
  assert.equal(stop.lane, "unrestricted");
  assert.deepEqual(describeDecision(stop, ctx), {
    kind: "trading",
    title: stop.title,
    lines: stop.lines,
  });
});

test("a vote naming any contract as the exchange says it is not one this app knows, even the old weekly rounds", () => {
  // The old weekly rounds contract is deprecated (D185): this app does not call it its own any more.
  for (const exchange of [FORMER_ROUNDS, OTHER]) {
    const vote = {
      to: SHARES,
      data: encodeFunctionData(
        EXIT_EXCHANGE_SIGNATURES.announce,
        ["address"],
        [exchange],
      ),
    };
    const described = describeDecision(vote, { projectToken: SHARES });
    assert.equal(
      described.title,
      "Let another contract move Shares in 30 days",
    );
    assert.match(described.lines[0], /not the one this app knows/);
    assert.equal(
      describeDecision({ ...vote, to: OTHER }, { projectToken: SHARES }).kind,
      "unknown",
      "a vote aimed elsewhere is not described as an exchange",
    );
  }
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
      { projectToken: SHARES },
    ).kind,
    "unknown",
    "a word that is not an address is not an exchange",
  );
});
