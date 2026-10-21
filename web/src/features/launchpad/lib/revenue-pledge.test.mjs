import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRevenuePledge,
  pledgeDraftFromRecord,
  pledgeFromDraft,
  pledgeSentence,
  revenuePledgeContent,
} from "./revenue-pledge.ts";

const DOC = {
  title: "Revenue pledge, signed",
  url: "https://example.com/pledge.pdf",
  sha256: "ab".repeat(32),
};

test("a pledge reads back only what is well formed", () => {
  assert.deepEqual(
    parseRevenuePledge({
      v: 1,
      percent: 50,
      every: "quarter",
      until: null,
      document: DOC,
    }),
    { v: 1, percent: 50, every: "quarter", until: null, document: DOC },
  );
  assert.equal(parseRevenuePledge({ percent: 0, every: "month" }), null);
  assert.equal(parseRevenuePledge({ percent: 101, every: "month" }), null);
  assert.equal(parseRevenuePledge({ percent: 10, every: "fortnight" }), null);
  assert.equal(parseRevenuePledge("50%"), null);
  // A bad date or a bad document is dropped: that can only make the pledge say less.
  assert.deepEqual(
    parseRevenuePledge({
      percent: 10,
      every: "year",
      until: "soon",
      document: { url: "http://x" },
    }),
    { v: 1, percent: 10, every: "year", until: null, document: null },
  );
});

test("what is published is only what is present", () => {
  assert.deepEqual(
    revenuePledgeContent({
      v: 1,
      percent: 20,
      every: "month",
      until: "2030-12-31",
      document: null,
    }),
    { v: 1, percent: 20, every: "month", until: "2030-12-31" },
  );
});

test("the editor checks the pledge and says what is wrong", () => {
  const draft = {
    ...pledgeDraftFromRecord(null),
    percent: "25",
    every: "quarter",
  };
  assert.deepEqual(pledgeFromDraft(draft), {
    pledge: {
      v: 1,
      percent: 25,
      every: "quarter",
      until: null,
      document: null,
    },
  });
  assert.match(pledgeFromDraft({ ...draft, percent: "" }).problem, /percent/i);
  assert.match(pledgeFromDraft({ ...draft, percent: "12.5" }).problem, /whole/);
  assert.match(
    pledgeFromDraft({ ...draft, until: "next year" }).problem,
    /date/,
  );
  assert.match(
    pledgeFromDraft({ ...draft, document: { title: "x", url: "", sha256: "" } })
      .problem,
    /document/,
  );
  assert.equal(
    pledgeFromDraft({ ...draft, document: DOC }).pledge.document.sha256,
    DOC.sha256,
  );
});

test("the pledge is said plainly, and always says the contracts do not enforce it", () => {
  assert.equal(
    pledgeSentence({
      v: 1,
      percent: 50,
      every: "quarter",
      until: null,
      document: DOC,
    }),
    "The team pledges 50% of the project's net receipts to the treasury, every quarter, for as long as the project earns. It is written into “Revenue pledge, signed”. The contracts do not enforce it.",
  );
  assert.equal(
    pledgeSentence({
      v: 1,
      percent: 10,
      every: "month",
      until: "2030-12-31",
      document: null,
    }),
    "The team pledges 10% of the project's net receipts to the treasury, every month, until 2030-12-31. It is not written into a signed document on record. The contracts do not enforce it.",
  );
});
