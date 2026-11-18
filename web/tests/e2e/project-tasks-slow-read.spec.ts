import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { COMMUNITY_HOST, createMockRelay, matches } from "./mock-relay";

/**
 * A server that takes a moment to answer, as a real one does. The other task specs' server answers a read in the
 * same instant a task is made, so the page never showed what it does in between: found by running the loop against
 * the real server (`scripts/real-loop-e2e.sh`), where the read after "Make the task" takes seconds.
 */

const FOUNDER_KEY = "4".repeat(64);
const pubkeyOf = (key: string) =>
  getPublicKey(Uint8Array.from(Buffer.from(key, "hex")));
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const HELPER = pubkeyOf("5".repeat(64));
const COORD = `37001:${FOUNDER}:nebula-os`;
const ASK = "Someone to test sign-up on an older phone.";
const now = () => Math.floor(Date.now() / 1000);

test("after a task is made the page says so at once and does not offer to make it again while it reads it back", async ({
  page,
}) => {
  const relay = createMockRelay();
  let n = 0;
  const seed = (
    kind: number,
    pubkey: string,
    content: unknown,
    tags: string[][],
    ago: number,
  ) => {
    n += 1;
    const event = {
      id: n.toString(16).padStart(64, "0"),
      kind,
      pubkey,
      content: JSON.stringify(content),
      tags,
      created_at: now() - ago,
      sig: "0".repeat(128),
    };
    relay.seed(event);
    return event;
  };
  seed(
    37001,
    FOUNDER,
    { pitch: "Build a useful app together.", stage: "draft" },
    [
      ["d", "nebula-os"],
      ["name", "Nebula OS"],
      ["t", "dao-launchpad"],
    ],
    86_400 * 60,
  );
  seed(0, FOUNDER, { name: "Fay Founder" }, [], 86_400 * 60);
  seed(0, HELPER, { name: "Robin Helper" }, [], 86_400 * 60);
  const update = seed(
    47003,
    FOUNDER,
    { title: "Week one", body: `Help needed (Small)\n${ASK}` },
    [
      ["a", COORD],
      ["update-kind", "weekly"],
      ["help-needed", ASK],
      ["help-size", "small"],
    ],
    86_400 * 2,
  );
  seed(
    47003,
    HELPER,
    { title: "Offer to help", body: "I have an old phone." },
    [
      ["a", COORD],
      ["e", update.id],
      ["p", FOUNDER],
      ["help-offer", update.id],
    ],
    86_400,
  );

  await relay.install(page);
  await page.addInitScript((key) => {
    localStorage.setItem("buzz.identity.nsec", key);
    localStorage.setItem("buzz.identity.backedUp", "1");
  }, FOUNDER_KEY);
  await page.route("**/communities", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        communities: [
          {
            host: COMMUNITY_HOST,
            name: "Alpha",
            description: "Build together",
            icon: null,
            member_count: 3,
            archived: false,
          },
        ],
      }),
    }),
  );
  await page.route("**/query", (route) => {
    const filters = JSON.parse(route.request().postData() ?? "[]");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        relay.events.filter((e) =>
          filters.some((f: Parameters<typeof matches>[0]) => matches(f, e)),
        ),
      ),
    });
  });

  await page.goto(`/launchpad/nebula-os?author=${FOUNDER}`);
  const offer = page
    .getByTestId("project-update-card")
    .getByTestId("help-offer");
  await offer.getByTestId("offer-accept").click();
  const form = offer.getByRole("form", {
    name: "Make a task for Robin Helper",
  });
  await form.getByLabel("Done means").fill("A screen recording.");

  // From here the server takes the task at once, and is slow to answer any read of the project's tasks.
  relay.holdReads((filter) =>
    ((filter as { "#l"?: string[] })["#l"] ?? []).includes("creaton-task"),
  );
  await form.getByRole("button", { name: "Make the task" }).click();
  await expect
    .poll(
      () =>
        relay.events.filter((e) =>
          e.tags.some((t) => t[0] === "task-part" && t[1] === "task"),
        ).length,
    )
    .toBe(1);

  // Still reading: the page already says the task was made, and the button is not back.
  await expect(offer.getByTestId("offer-task-made")).toContainText(
    "Task made. It is Robin Helper's once they say yes.",
  );
  expect(await offer.getByTestId("offer-accept").count()).toBe(0);
  await expect(offer.getByRole("link", { name: "See the task" })).toHaveCount(
    0,
  );

  // The read answers: the same line, now with the way to the task. Still one task.
  relay.releaseReads();
  await expect(offer.getByRole("link", { name: "See the task" })).toBeVisible();
  await expect(offer.getByTestId("offer-task-made")).toContainText(
    "Task made.",
  );
  expect(
    relay.events.filter((e) =>
      e.tags.some((t) => t[0] === "task-part" && t[1] === "task"),
    ),
  ).toHaveLength(1);
});
