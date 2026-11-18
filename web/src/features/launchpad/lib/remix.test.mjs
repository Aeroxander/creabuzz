import assert from "node:assert/strict";
import { test } from "node:test";

import {
  builtOnCoordinate,
  normaliseLicence,
  offersLine,
  parseBuiltOn,
  parseRemixTerms,
  remixFit,
} from "./remix.ts";

const AUTHOR = "a".repeat(64);
const open = (licence) => ({
  v: 1,
  holder: "open",
  licence,
  entity: null,
  assignment: null,
  operating: null,
  contributorTerms: null,
});
const held = (holder) => ({ ...open(null), holder, licence: null });

test("a built-on link and remix terms read back only when well formed", () => {
  assert.deepEqual(parseBuiltOn({ author: AUTHOR, id: "docs-commons" }), {
    author: AUTHOR,
    id: "docs-commons",
  });
  assert.equal(parseBuiltOn({ author: "nope", id: "x" }), null);
  assert.equal(parseBuiltOn({ author: AUTHOR, id: "has spaces" }), null);
  assert.equal(parseBuiltOn("x"), null);
  assert.equal(
    builtOnCoordinate({ author: AUTHOR, id: "d" }),
    `37001:${AUTHOR}:d`,
  );
  assert.deepEqual(
    parseRemixTerms({
      invited: true,
      asks: "  credit us  ",
      offers: ["assets", "bogus", "name"],
    }),
    { invited: true, asks: "credit us", offers: ["name", "assets"] },
  );
  assert.equal(parseRemixTerms({ asks: "x" }), null);
  assert.equal(
    parseRemixTerms({ invited: false, asks: "x".repeat(600) }).asks.length,
    500,
  );
});

test("licences compare without their -only and -or-later", () => {
  assert.equal(normaliseLicence(" gpl-3.0-or-later "), "GPL-3.0");
  assert.equal(normaliseLicence("MIT"), "MIT");
});

test("an open, permissive parent fits anything; a share-alike one only the same licence", () => {
  assert.equal(
    remixFit(
      "Docs",
      { ipRecord: open("MIT"), remixTerms: null },
      { ipRecord: null },
    ).kind,
    "fits",
  );
  const sa = { ipRecord: open("CC-BY-SA-4.0"), remixTerms: null };
  assert.equal(
    remixFit("Docs", sa, { ipRecord: open("CC-BY-SA-4.0") }).kind,
    "fits",
  );
  const differs = remixFit("Docs", sa, { ipRecord: open("MIT") });
  assert.equal(differs.kind, "needs-same-licence");
  assert.equal(
    differs.line,
    "Docs is under CC-BY-SA-4.0, which asks that work built on it use CC-BY-SA-4.0 too. This project doesn't say it does.",
  );
  assert.equal(
    remixFit(
      "Docs",
      { ipRecord: open("Weird-1"), remixTerms: null },
      { ipRecord: null },
    ).kind,
    "unknown",
  );
});

test("a held parent fits only when it invites remixes, and says what it asks", () => {
  const terms = { invited: true, asks: "Credit us and share 5%.", offers: [] };
  assert.deepEqual(
    remixFit(
      "Docs",
      { ipRecord: held("founders"), remixTerms: terms },
      { ipRecord: null },
    ),
    {
      kind: "fits",
      line: "Docs invites projects built on it, and asks: Credit us and share 5%.",
    },
  );
  assert.deepEqual(
    remixFit(
      "Docs",
      { ipRecord: held("entity"), remixTerms: null },
      { ipRecord: null },
    ),
    {
      kind: "needs-terms",
      line: "Docs's work is held by its entity, and it doesn't invite projects built on it. Ask them first.",
    },
  );
  // An explicit invitation counts even when the parent never said who holds its work; silence does not.
  assert.equal(
    remixFit("Docs", { ipRecord: null, remixTerms: terms }, { ipRecord: null })
      .kind,
    "fits",
  );
  assert.equal(
    remixFit("Docs", { ipRecord: null, remixTerms: null }, { ipRecord: null })
      .kind,
    "unknown",
  );
});

test("what a remix gets reads as a list", () => {
  assert.equal(offersLine([]), null);
  assert.equal(
    offersLine(["name"]),
    "A project built on it gets use of the name.",
  );
  assert.equal(
    offersLine(["name", "assets", "contributors"]),
    "A project built on it gets use of the name, its assets and an invitation to its contributors.",
  );
});
