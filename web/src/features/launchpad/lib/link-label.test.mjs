import assert from "node:assert/strict";
import { test } from "node:test";

import { linkLabel } from "./link-label.ts";

const SITE = "http://localhost:3199";

test("a post on this site's boards reads as one, never as its address", () => {
  assert.equal(
    linkLabel(
      `${SITE}/b/c18c3e0a-8437-4bf2-8f09-e7bf8aade2d5?post=${"ff".repeat(32)}`,
      SITE,
    ),
    "Post on a board",
  );
  assert.equal(linkLabel(`${SITE}/b/abc`, SITE), "A board");
});

test("any other link is shown as written, so people see where someone else's link goes", () => {
  const external = "https://github.com/acme/docs/pull/12";
  assert.equal(linkLabel(external, SITE), external);
  // A board link on another site is just a link there.
  assert.equal(
    linkLabel("https://other.site/b/abc?post=1", SITE),
    "https://other.site/b/abc?post=1",
  );
  assert.equal(linkLabel(`${SITE}/launchpad/x`, SITE), `${SITE}/launchpad/x`);
  assert.equal(linkLabel("not a url", SITE), "not a url");
});
