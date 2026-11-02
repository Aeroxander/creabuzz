import assert from "node:assert/strict";
import test from "node:test";

import { duePhrase, nextActionOf, nextActionRole } from "./next-action.ts";

const item = (over = {}) => ({
  key: "k",
  kind: "review",
  text: "Work was submitted that needs your review.",
  action: "Review it",
  tab: "work",
  ...over,
});

test("the front-most thing the person can act on is the one next action", () => {
  const next = nextActionOf(
    [
      item({ actor: "others", text: "Their own work waits on a reviewer." }),
      item({ kind: "payout", text: "Your submission was approved." }),
    ],
    100,
  );
  assert.equal(next?.text, "Your submission was approved.");
  assert.equal(next?.tab, "work");
});

test("nothing for this person: no next action", () => {
  assert.equal(nextActionOf([item({ actor: "others" })], 100), null);
  assert.equal(nextActionOf([], 100), null);
});

test("the role comes from why the item is addressed to this person", () => {
  assert.equal(
    nextActionRole(item({ why: "You hold Shares in this project." })),
    "holder (you)",
  );
  assert.equal(
    nextActionRole(item({ why: "You are a reviewer on this work budget." })),
    "reviewer (you)",
  );
  assert.equal(
    nextActionRole(
      item({ why: "You manage the work area its words are for." }),
    ),
    "manager (you)",
  );
  assert.equal(
    nextActionRole(item({ kind: "payout", why: "It is your submission." })),
    "contributor (you)",
  );
  assert.equal(
    nextActionRole(item({ kind: "move", why: undefined })),
    "holder (you)",
  );
  assert.equal(
    nextActionRole(item({ kind: "bond", why: undefined })),
    "reviewer (you)",
  );
});

test("a date that has passed is dropped, so the copy never says a closed deadline is open", () => {
  const open = nextActionOf([item({ due: 200 })], 100);
  assert.equal(open?.due, 200);
  const closed = nextActionOf([item({ due: 50 })], 100);
  assert.equal(closed?.due, undefined);
});

test("the date on an item names the window that closes, never a clock that acts", () => {
  const format = (seconds) => `FEB ${seconds}`;
  // A vote closes at its end; nothing executes itself there.
  assert.equal(
    duePhrase({ kind: "vote", due: 900 }, format),
    "The vote ends FEB 900.",
  );
  // A submission's review window ends, and whoever has not answered has missed it.
  assert.equal(
    duePhrase({ kind: "review", due: 700 }, format),
    "The review window ends FEB 700.",
  );
  // A piece of the reader's own work cannot be touched before the wait is over.
  assert.equal(
    duePhrase({ kind: "waiting", due: 600 }, format),
    "You can act on it after FEB 600.",
  );
  // The fallback is a window too: it names nothing that would happen on its own.
  assert.equal(
    duePhrase({ kind: "award", due: 500 }, format),
    "The window ends FEB 500.",
  );
  assert.equal(duePhrase({ kind: "payout", due: undefined }, format), null);
});
