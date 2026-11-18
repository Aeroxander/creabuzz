import assert from "node:assert/strict";
import { test } from "node:test";

import { serverExampleSlug } from "./server-example.ts";

const SLUG = "creaton-0123456789abcdef";

test("the server's example project is its scorecard address, as the server gave it", () => {
  assert.equal(serverExampleSlug({ example_project: SLUG }), SLUG);
  assert.equal(
    serverExampleSlug({
      name: "Creaton",
      example_project: "my map-v2-0123456789abcdef",
    }),
    "my map-v2-0123456789abcdef",
  );
});

test("a server that names none, or names something that is not a project's address, has no example", () => {
  for (const info of [
    null,
    undefined,
    "creaton-0123456789abcdef",
    [],
    [{ example_project: SLUG }],
    {},
    { example_project: null },
    { example_project: 7 },
    { example_project: "" },
    { example_project: "creaton" },
    { example_project: "creaton-0123" },
    { example_project: "creaton-0123456789ABCDEF" },
    { example_project: "/p/creaton-0123456789abcdef/../../u/x" },
    { example_project: `${"a".repeat(200)}-0123456789abcdef` },
  ])
    assert.equal(serverExampleSlug(info), null, JSON.stringify(info));
});
