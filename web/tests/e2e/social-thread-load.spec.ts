import { expect, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";

/**
 * A post's page costs the reader sockets, not just requests: each is a connection, a handshake and a sign-in to a server
 * that can be far away, and a reply's page used to open one per note above it. This loads a deep reply against a server
 * that asks everyone to sign in as soon as they connect, as a real one does, and counts the reads the page made for the thread itself.
 */

const ME_NSEC = "57".repeat(32);
const ANN = "a1".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

let counter = 0;
const eid = () =>
  `${(++counter).toString(16).padStart(8, "0")}`.padEnd(64, "d");

function note(at: number, content: string, tags: string[][] = []) {
  return {
    id: eid(),
    pubkey: ANN,
    created_at: at,
    kind: 1,
    tags,
    content,
    sig: "sig",
  };
}

test("a deep reply's page reads its thread on two sockets, not one per note above it", async ({
  page,
}) => {
  const relay = createMockRelay({ requireAuth: true, challengeDelayMs: 5 });
  const root = note(now() - 600, "Where should we meet?");
  const chain = [root];
  for (const [i, text] of [
    "The park",
    "Which park?",
    "The big one",
  ].entries()) {
    const parent = chain[chain.length - 1];
    chain.push(
      note(now() - 500 + i, text, [
        ["e", root.id, "", "root"],
        ["e", parent.id, "", "reply"],
      ]),
    );
  }
  const focus = note(now() - 400, "Fine, noon then", [
    ["e", root.id, "", "root"],
    ["e", chain[chain.length - 1].id, "", "reply"],
  ]);
  const answer = note(now() - 300, "See you there", [
    ["e", root.id, "", "root"],
    ["e", focus.id, "", "reply"],
  ]);
  for (const event of [...chain, focus, answer]) relay.seed(event);

  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, ME_NSEC);
  await page.goto(`/social/post/${focus.id}`);

  await expect(page.getByTestId("social-thread-focus")).toContainText(
    "Fine, noon then",
  );
  for (const above of chain) {
    await expect(page.getByText(above.content).first()).toBeVisible();
  }
  await expect(page.getByText("See you there")).toBeVisible();

  const reqs = relay.reqsReceived();
  const holds = (filters: { ids?: unknown }[], id: string) =>
    filters.some((f) => Array.isArray(f.ids) && f.ids.includes(id));
  const aboveIds = chain.map((e) => e.id);
  // Every read that named the focused post or one above it: the thread's own (other parts of the page read other things).
  const threadReads = reqs.filter((filters) =>
    [focus.id, ...aboveIds].some((id) => holds(filters, id)),
  );
  console.log(
    `thread load: ${relay.connectionsOpened()} sockets opened in all, ${reqs.length} REQs, ${threadReads.length} thread reads on ${threadReads.length} sockets`,
  );
  expect(threadReads.length).toBeLessThanOrEqual(2);
  expect(
    threadReads.every((filters) => filters.length > 1),
    "each thread read carries its filters in one REQ",
  ).toBe(true);
  expect(
    reqs.some(
      (filters) =>
        filters.length === 1 && aboveIds.some((id) => holds(filters, id)),
    ),
    "no note above is read on a socket of its own",
  ).toBe(false);
});
