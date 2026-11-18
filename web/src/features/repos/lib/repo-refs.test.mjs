import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  fetchRepoRefsFrom,
  relaySignerFromInfo,
  RepoSignerUnknownError,
  RepoSignerUnreachableError,
  repoRefsQueryKey,
  trustedRepoStateEvent,
} from "./repo-refs.ts";

const REPO = "creaton-app";
const serverA = generateSecretKey();
const serverB = generateSecretKey();
const forger = generateSecretKey();
const A = getPublicKey(serverA);
const B = getPublicKey(serverB);
const FORGER = getPublicKey(forger);
const SHA_MAIN = "1".repeat(40);
const SHA_EVIL = "e".repeat(40);

function stateEvent(
  secret,
  createdAt,
  { head = "main", refs = {}, repo = REPO } = {},
) {
  return finalizeEvent(
    {
      kind: 30618,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", repo],
        ...Object.entries(refs),
        ["HEAD", `ref: refs/heads/${head}`],
      ],
    },
    secret,
  );
}

const genuine = stateEvent(serverA, 100, {
  refs: { "refs/heads/main": SHA_MAIN, "refs/tags/v1": SHA_MAIN },
});
const forged = stateEvent(forger, 200, {
  head: "evil",
  refs: { "refs/heads/evil": SHA_EVIL, "refs/tags/v666": SHA_EVIL },
});

/**
 * A server that answers a query the way a careless one would: every record for the repository, whatever author the
 * filter asked for. The page must still only believe the server's own key.
 */
function careless(eventsByUrl, infoByUrl) {
  const calls = [];
  return {
    calls,
    deps: {
      fetchInfo: async (url) => {
        calls.push(["info", url]);
        const info = infoByUrl[url];
        if (info instanceof Error) throw info;
        return info;
      },
      queryEvents: async (url, filter) => {
        calls.push(["query", url, filter]);
        return eventsByUrl[url] ?? [];
      },
    },
  };
}

describe("repository refs only come from the server's own key", () => {
  it("a newer record by someone else cannot change HEAD, branches or tags", async () => {
    const { deps, calls } = careless(
      { "wss://a": [forged, genuine] },
      { "wss://a": { self: A } },
    );
    const refs = await fetchRepoRefsFrom("wss://a", REPO, deps);
    assert.deepEqual(refs, {
      branches: ["main"],
      tags: ["v1"],
      head: { ref: "main", sha: SHA_MAIN },
    });
    const query = calls.find((call) => call[0] === "query");
    assert.deepEqual(query[2], { kinds: [30618], authors: [A], "#d": [REPO] });
  });

  it("a record claiming the server's key with a bad signature is ignored", () => {
    // As it arrives from the network: plain JSON, no verification remembered on it.
    const spoof = { ...JSON.parse(JSON.stringify(forged)), pubkey: A };
    assert.equal(trustedRepoStateEvent([spoof, genuine], REPO, A), genuine);
  });

  it("a record for another repository is ignored", () => {
    const other = stateEvent(serverA, 300, { repo: "other", head: "evil" });
    assert.equal(trustedRepoStateEvent([other, genuine], REPO, A), genuine);
  });

  it("the newest record by the server wins", () => {
    const newer = stateEvent(serverA, 150, {
      head: "dev",
      refs: { "refs/heads/dev": SHA_EVIL },
    });
    assert.equal(trustedRepoStateEvent([genuine, newer], REPO, A), newer);
  });

  it("only forged records means no refs, not the forger's refs", async () => {
    const { deps } = careless(
      { "wss://a": [forged] },
      { "wss://a": { self: A } },
    );
    assert.deepEqual(await fetchRepoRefsFrom("wss://a", REPO, deps), {
      branches: [],
      tags: [],
      head: null,
    });
  });

  it("refuses plainly when the server does not say which key it signs with", async () => {
    for (const info of [{}, { self: "" }, { self: "not-a-key" }, null]) {
      const { deps, calls } = careless(
        { "wss://a": [forged, genuine] },
        { "wss://a": info },
      );
      await assert.rejects(
        fetchRepoRefsFrom("wss://a", REPO, deps),
        RepoSignerUnknownError,
      );
      assert.equal(
        calls.some((call) => call[0] === "query"),
        false,
        "no records are read without a key to check them against",
      );
    }
  });

  it("an unreadable information document is an error, never an empty list", async () => {
    const { deps } = careless(
      { "wss://a": [genuine] },
      { "wss://a": new Error("offline") },
    );
    await assert.rejects(
      fetchRepoRefsFrom("wss://a", REPO, deps),
      RepoSignerUnreachableError,
    );
  });

  it("after switching community, the new server's key decides, not the old one's", async () => {
    // On server B, server A's record is just someone else's record.
    const onB = stateEvent(serverB, 50, {
      head: "trunk",
      refs: { "refs/heads/trunk": SHA_MAIN },
    });
    const stale = stateEvent(serverA, 400, {
      head: "evil",
      refs: { "refs/heads/evil": SHA_EVIL },
    });
    const { deps, calls } = careless(
      { "wss://a": [genuine], "wss://b": [stale, onB] },
      { "wss://a": { self: A }, "wss://b": { self: B } },
    );
    await fetchRepoRefsFrom("wss://a", REPO, deps);
    const refsB = await fetchRepoRefsFrom("wss://b", REPO, deps);
    assert.deepEqual(refsB.head, { ref: "trunk", sha: SHA_MAIN });
    assert.deepEqual(refsB.branches, ["trunk"]);
    assert.deepEqual(
      calls
        .filter((call) => call[0] !== "query" || call[1] === "wss://b")
        .at(-1)[2].authors,
      [B],
    );
    assert.ok(
      calls.some((call) => call[0] === "info" && call[1] === "wss://b"),
    );
    assert.notDeepEqual(
      repoRefsQueryKey("wss://a", REPO),
      repoRefsQueryKey("wss://b", REPO),
    );
  });

  it("reads the key from the information document's self field", () => {
    assert.equal(relaySignerFromInfo({ self: A.toUpperCase() }), A);
    assert.equal(relaySignerFromInfo({ pubkey: A }), null);
    assert.equal(FORGER.length, 64);
  });
});
