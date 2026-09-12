import assert from "node:assert/strict";
import test from "node:test";

import { cn } from "./cn.ts";

/**
 * `cn` merges Tailwind classes with tailwind-merge, which decides conflicts from
 * its own class tables. `text-message` is a *size* in this project but looks like
 * a colour to the stock table, so plain `twMerge` dropped it silently whenever a
 * colour utility followed — the conversation type simply did not apply.
 */
test("a conversation size survives next to a colour", () => {
  assert.equal(
    cn("text-message", "text-muted-foreground"),
    "text-message text-muted-foreground",
  );
  assert.equal(
    cn("text-message-timestamp", "text-black/60"),
    "text-message-timestamp text-black/60",
  );
});

test("real conflicts still resolve to the last one", () => {
  assert.equal(cn("text-sm", "text-lg"), "text-lg");
  assert.equal(cn("p-2", "p-4"), "p-4");
  assert.equal(
    cn("text-message", "text-message-timestamp"),
    "text-message-timestamp",
  );
});

test("conditional and falsy inputs behave", () => {
  assert.equal(
    cn("text-message", false && "text-lg", null, undefined),
    "text-message",
  );
  assert.equal(cn(["text-message", "font-medium"]), "text-message font-medium");
});
