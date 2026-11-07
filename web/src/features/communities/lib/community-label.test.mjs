import assert from "node:assert/strict";
import test from "node:test";

import { communityLabel, listedCommunities } from "./community-label.ts";

test("a community someone started is called by the name they picked, with its address under it", () => {
  assert.deepEqual(
    communityLabel("my-film.creaton.example", "creaton.example", "Creaton"),
    { name: "my-film", address: "my-film.creaton.example" },
  );
  // Ports are part of the domain, as the server reports it.
  assert.deepEqual(
    communityLabel("my-film.localhost:3199", "localhost:3199", "Creaton"),
    { name: "my-film", address: "my-film.localhost:3199" },
  );
});

test("the server's main community carries the product's name", () => {
  assert.deepEqual(
    communityLabel("localhost:3199", "localhost:3199", "Creaton"),
    { name: "Creaton", address: "localhost:3199" },
  );
  assert.deepEqual(
    communityLabel("Creaton.Example", "creaton.example", "Creaton"),
    { name: "Creaton", address: "Creaton.Example" },
  );
});

test("anything else keeps its address as its name, shown once", () => {
  assert.deepEqual(communityLabel("alpha.example.com", null, "Creaton"), {
    name: "alpha.example.com",
    address: null,
  });
  // A deeper name under the domain is not one someone picked here.
  assert.deepEqual(
    communityLabel("a.b.creaton.example", "creaton.example", "Creaton"),
    { name: "a.b.creaton.example", address: null },
  );
  assert.deepEqual(
    communityLabel("other.example", "creaton.example", "Creaton"),
    { name: "other.example", address: null },
  );
});

test("the list leaves out the connected community and empty ones", () => {
  const entries = [
    { host: "localhost:3199", member_count: 11 },
    { host: "localhost", member_count: 0 },
    { host: "127.0.0.1", member_count: 0 },
    { host: "my-film.localhost:3199", member_count: 2 },
  ];
  assert.deepEqual(
    listedCommunities(entries, "localhost:3199").map((e) => e.host),
    ["my-film.localhost:3199"],
  );
});

test("Communities goes straight into the one community only when there is nothing else to pick", async () => {
  const { onlyCommunityHost } = await import("./community-label.ts");
  const here = "creaton.example";
  // No self-serve, nothing else listed (or no directory at all): straight in.
  assert.equal(onlyCommunityHost(false, [], here), here);
  assert.equal(
    onlyCommunityHost(false, [{ host: here, member_count: 4 }], here),
    here,
  );
  // An empty community nobody started is not listed, so it does not count.
  assert.equal(
    onlyCommunityHost(
      false,
      [{ host: "empty.example", member_count: 0 }],
      here,
    ),
    here,
  );
  // Another community to pick, or a server that makes new ones: the directory.
  assert.equal(
    onlyCommunityHost(
      false,
      [{ host: "other.example", member_count: 2 }],
      here,
    ),
    null,
  );
  assert.equal(onlyCommunityHost(true, [], here), null);
  // Still reading, or a read failed: the directory, which still opens the connected community.
  assert.equal(onlyCommunityHost(undefined, [], here), null);
  assert.equal(onlyCommunityHost(false, undefined, here), null);
});
