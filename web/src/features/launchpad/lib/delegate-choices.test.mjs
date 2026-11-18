import assert from "node:assert/strict";
import { test } from "node:test";

import { delegateChoices } from "./delegate-choices.ts";

const addr = (n) => `0x${n.repeat(40)}`;
const people = [
  { pubkey: "p1", address: addr("1") },
  { pubkey: "p2", address: addr("2") },
  { pubkey: "p3", address: addr("3") },
];
const nameOf = (pubkey) => ({ p1: "Ada", p2: "Bo", p3: "Cy" })[pubkey] ?? null;

test("the account choosing is never one of its own choices, so it cannot use up a place in the list", () => {
  const choices = delegateChoices({
    holders: [addr("1"), addr("2"), addr("3")],
    people,
    nameOf,
    exclude: [addr("d"), addr("1").toUpperCase().replace("0X", "0x")],
    limit: 2,
  });
  assert.deepEqual(
    choices.map((c) => c.value),
    [addr("2"), addr("3")],
  );
  // A missing acting account (nobody signed in) excludes nothing more.
  assert.equal(
    delegateChoices({
      holders: [addr("1")],
      people,
      nameOf,
      exclude: [addr("d"), null],
    }).length,
    1,
  );
});
