import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decisionPath,
  decisionUrl,
  findDecisionLinks,
  isDecisionId,
  parseDecisionLink,
} from "./decision-link.ts";

const ORIGIN = "https://app.example.com";
const ID = `0x${"0f".repeat(32)}`;
const ID2 = `0x${"1a".repeat(32)}`;
const AUTHOR = "ab".repeat(32);

describe("decisionPath / decisionUrl", () => {
  it("name the launch, its author, the Decisions tab and the decision", () => {
    const link = { launchId: "nebula dao", author: AUTHOR, decisionId: ID };
    assert.equal(
      decisionPath(link),
      `/launchpad/nebula%20dao?author=${AUTHOR}&tab=decisions&decision=${ID}`,
    );
    assert.equal(
      decisionUrl(link, `${ORIGIN}/`),
      `${ORIGIN}${decisionPath(link)}`,
    );
  });

  it("round-trip through parseDecisionLink", () => {
    const link = { launchId: "a/b c", author: AUTHOR, decisionId: ID };
    assert.deepEqual(
      parseDecisionLink(decisionUrl(link, ORIGIN), ORIGIN),
      link,
    );
    assert.deepEqual(parseDecisionLink(decisionPath(link), ORIGIN), link);
  });
});

describe("parseDecisionLink", () => {
  it("accepts this site's address with or without an author, in any case of the id", () => {
    assert.deepEqual(
      parseDecisionLink(
        `${ORIGIN}/launchpad/nebula?decision=${ID.toUpperCase().replace("0X", "0x")}`,
        ORIGIN,
      ),
      { launchId: "nebula", decisionId: ID },
    );
  });

  it("refuses another site, another page, and a missing or malformed decision", () => {
    for (const bad of [
      `https://evil.example/launchpad/nebula?decision=${ID}`,
      `${ORIGIN}/social/post?decision=${ID}`,
      `${ORIGIN}/launchpad/nebula`,
      `${ORIGIN}/launchpad/nebula?decision=0x12`,
      `${ORIGIN}/launchpad/nebula?decision=${ID}zz`,
      `${ORIGIN}/launchpad/?decision=${ID}`,
      `${ORIGIN}/launchpad/a/b?decision=${ID}`,
      "not a url at all",
    ]) {
      assert.equal(parseDecisionLink(bad, ORIGIN), null, bad);
    }
  });

  it("drops an author that is not a public key rather than trusting it", () => {
    assert.deepEqual(
      parseDecisionLink(
        `${ORIGIN}/launchpad/nebula?author=nope&decision=${ID}`,
        ORIGIN,
      ),
      { launchId: "nebula", decisionId: ID },
    );
  });

  it("never reads a DAO address from the link", () => {
    const link = parseDecisionLink(
      `${ORIGIN}/launchpad/nebula?decision=${ID}&dao=0x${"cd".repeat(20)}&chain=1`,
      ORIGIN,
    );
    assert.deepEqual(Object.keys(link).sort(), ["decisionId", "launchId"]);
  });
});

describe("findDecisionLinks", () => {
  const url = (id, extra = "") =>
    `${ORIGIN}/launchpad/nebula?tab=decisions&decision=${id}${extra}`;

  it("finds each decision linked to once, ignoring other links and trailing punctuation", () => {
    const text = `See ${url(ID)}, and also ${url(ID)}. Compare with (${url(ID2)}) or https://other.example/x.`;
    assert.deepEqual(
      findDecisionLinks(text, ORIGIN).map((l) => l.decisionId),
      [ID, ID2],
    );
  });

  it("returns nothing for text without one, and at most three for a wall of them", () => {
    assert.deepEqual(findDecisionLinks("nothing here", ORIGIN), []);
    const many = [1, 2, 3, 4, 5]
      .map((n) => url(`0x${String(n).padStart(2, "0").repeat(32)}`))
      .join(" ");
    assert.equal(findDecisionLinks(many, ORIGIN).length, 3);
  });
});

describe("isDecisionId", () => {
  it("is exactly 0x and 64 lower-case hex characters", () => {
    assert.equal(isDecisionId(ID), true);
    assert.equal(isDecisionId(ID.toUpperCase().replace("0X", "0x")), false);
    assert.equal(isDecisionId("0x12"), false);
  });
});
