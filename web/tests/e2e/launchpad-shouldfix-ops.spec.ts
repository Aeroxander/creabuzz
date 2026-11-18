import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * A busy chain node, as people see it (the ops area of the contributor-pilot audit), against a stubbed server and a
 * stubbed chain (same-origin `/test-rpc`).
 *
 * When the page's node is rate-limited (HTTP 429, or a JSON-RPC error in the node's own words), a read is asked again
 * twice after a pause and then says, in plain words, that the node is busy and what to do. Before, people saw
 * "rpc http 429" or the node's raw text ("daily request count exceeded, request rate limited"), and a rate limit in a
 * history read was taken for a range limit and paged around, about eleven more requests to a node that was already
 * overloaded. The rules are unit-tested in `chain.test.mjs` and `lib/log-pages.test.mjs`; this checks the words reach the
 * screen a contributor-project member uses for award votes (Decisions).
 */

const NSEC = "8".repeat(64);
const ME = getPublicKey(Uint8Array.from(Buffer.from(NSEC, "hex")));
const a = (byte: string) => `0x${byte.repeat(20)}`;
const DAO = a("da");
const SHARES = a("5e");

const record = {
  id: "d".repeat(64),
  pubkey: ME,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "busy-node"],
    ["name", "Busy Node"],
    ["t", "dao-launchpad"],
    ["admission", "community"],
    ["chain", "31337"],
    ["token", SHARES],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "A contributor project whose chain node is overloaded.",
    stage: "graduated",
    funding: {
      stance: "not-raising",
      seeking: ["contributors"],
      path: "contributors",
    },
    tokenPlan: {
      mode: "dao",
      name: "Busy Node",
      symbol: "BUSY",
      supply: "100000",
    },
  }),
  sig: "sig",
};

type Busy = "http-429" | "rate-words";

/** A chain whose every read is refused as `busy`; counts the requests it was sent. */
async function installBusyChain(page: Page, busy: Busy) {
  const seen = { requests: 0 };
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
    window.localStorage.setItem(
      "buzz.launchpad.rpc",
      `${window.location.origin}/test-rpc`,
    );
  }, NSEC);
  await page.route("**/test-rpc", async (route) => {
    seen.requests += 1;
    const { id } = JSON.parse(route.request().postData() ?? "{}") as {
      id: number;
    };
    if (busy === "http-429") {
      return route.fulfill({ status: 429, body: "Too Many Requests" });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32005,
          message: "daily request count exceeded, request rate limited",
        },
      }),
    });
  });
  return seen;
}

for (const busy of ["http-429", "rate-words"] as const) {
  test(`a busy chain node (${busy}) is said in plain words with what to do, never in the node's own`, async ({
    page,
  }) => {
    const relay = createMockRelay();
    relay.seed(record);
    await relay.install(page);
    const seen = await installBusyChain(page, busy);
    await page.goto(`/launchpad/busy-node?author=${ME}&tab=decisions`);

    const failure = page.getByTestId("decisions-error");
    await expect(failure).toContainText(
      "The chain node is busy. Try again in a minute; if it keeps happening, tell the site's organiser.",
      { timeout: 45_000 },
    );
    await expect(failure).not.toContainText("rpc http");
    await expect(failure).not.toContainText("request count");
    await expect(failure).not.toContainText("rate limited");
    await expectAccessible(page, "a busy chain node");
    // Bounded: a few reads, each asked at most three times, not a page loop against an overloaded node (45 today).
    expect(seen.requests).toBeLessThan(60);
  });
}
