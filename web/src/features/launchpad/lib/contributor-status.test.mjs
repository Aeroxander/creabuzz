import assert from "node:assert/strict";
import test from "node:test";

import {
  contributorStatus,
  TOPIC_CONTRIBUTOR_LAUNCHED,
} from "./contributor-status.ts";

test("the kit's launch event is the one the contract emits", () => {
  // cast keccak 'ContributorProjectLaunched(address,address,address,bytes32,uint256)'
  assert.equal(
    TOPIC_CONTRIBUTOR_LAUNCHED,
    "0x7f4eb55556e4a4d7639e36b6ec8b0e6d4ab4fcfff92dd9c201bed8e870716583",
  );
});

const rules = (over = {}) => ({
  kind: "rules",
  rules: {
    awardsOnly: true,
    issuanceCapBps: 65_535,
    yearStart: 0,
    yearBase: 0n,
    issuedThisYear: 0n,
    transfersLocked: true,
    unlockNoticeRequired: true,
    unlockAnnouncedAt: 0,
    transferExempt: `0x${"0".repeat(40)}`,
    ...over,
  },
});

test("the start is said as checked: by the kit's event, or only as the record says", () => {
  assert.match(contributorStatus("kit", rules()).start, /^No token sale\.$/);
  assert.match(
    contributorStatus("record", rules()).start,
    /started without a token sale; this could not be checked/,
  );
  assert.equal(contributorStatus("reading", rules()).start, null);
});

test("new Shares 'only from awards' only when the Shares say so", () => {
  assert.equal(
    contributorStatus("kit", rules()).shares,
    "New Shares come only from awards for reviewed work.",
  );
  assert.equal(
    contributorStatus("kit", rules({ awardsOnly: false })).shares,
    "A vote can also create new Shares, not only awards for work.",
  );
  // A read that failed, Shares made before the rule, and one still reading never keep the promise.
  assert.match(
    contributorStatus("kit", { kind: "error" }).shares,
    /Could not check/,
  );
  assert.match(
    contributorStatus("kit", { kind: "predates" }).shares,
    /A vote can also create new Shares/,
  );
  assert.equal(contributorStatus("kit", { kind: "reading" }).shares, null);
});

test("trading as the lock says, with no announcement invented and no browser clock", () => {
  assert.equal(
    contributorStatus("kit", rules()).trading,
    "Shares can't be sold or sent to others.",
  );
  // Locked, but needing no notice: one vote opens it, and nothing was announced.
  assert.equal(
    contributorStatus("kit", rules({ unlockNoticeRequired: false })).trading,
    "Shares can't be sold yet, but one vote can change that.",
  );
  // Announced: the date it can open, the same whether that date has passed or not.
  const announced = Date.UTC(2026, 9, 1) / 1000;
  assert.match(
    contributorStatus("kit", rules({ unlockAnnouncedAt: announced })).trading,
    /^A vote announced that Shares will become sellable\. A second vote can do it from October 31, 2026\.$/,
  );
  assert.equal(
    contributorStatus("kit", rules({ transfersLocked: false })).trading,
    "Shares can be sold or sent to others.",
  );
  assert.equal(contributorStatus("kit", { kind: "error" }).trading, null);
});
