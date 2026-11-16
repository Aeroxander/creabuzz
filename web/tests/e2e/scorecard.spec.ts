import { expect, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/project-world";

/**
 * A project's public scorecard at its own short address: readable signed out, with the goal, the run of weekly
 * updates, promises kept, missed and changed with the last ones answered, the latest update, open help and the
 * team; Follow and "I can help" to act; Share to pass it on. It shows no price, and it opens only the project whose
 * founder the address names.
 */

const ME_KEY = "d1".repeat(32);
const ME = pubkeyOf(ME_KEY);
const MATE = pubkeyOf("d2".repeat(32));
const OTHER = pubkeyOf("d3".repeat(32));
const VISITOR_KEY = "d4".repeat(32);
const COORD = coordOf(ME, "rhythm");
const CARD = `/p/rhythm-${ME.slice(0, 16)}`;

function seed(relay: Relay) {
  for (const [key, name] of [
    [ME, "Mia Maker"],
    [MATE, "Max Mate"],
  ])
    relay.seed(
      event(0, key, { name, display_name: name }, [], now() - 90 * DAY),
    );
  relay.seed(
    projectRecord(ME, "rhythm", "Rhythm", now() - 60 * DAY, {
      content: { pitch: "A metronome anyone can fork." },
      tags: [
        ["team", MATE, "member"],
        ["team-invite", MATE, "inv1"],
        ["p", MATE],
      ],
    }),
  );
  relay.seed(
    event(
      47003,
      MATE,
      "",
      [
        ["a", COORD],
        ["l", "creaton-team"],
        ["team-answer", "yes"],
        ["team-invite", "inv1"],
      ],
      now() - 50 * DAY,
    ),
  );
  // Updates as the app writes them: the body reads on its own, and the tags carry the same parts.
  const written = (title: string, body: string, tags: string[][], at: number) =>
    event(47003, ME, { title, body }, [["a", COORD], ...tags], at);
  const first = written(
    "Two weeks ago",
    "What's next\nShip sign-up\nWrite the guide\nFind a designer",
    [
      ["update-part", "next", "Ship sign-up\nWrite the guide\nFind a designer"],
      ["promise", "0", "Ship sign-up"],
      ["promise", "1", "Write the guide"],
      ["promise", "2", "Find a designer"],
    ],
    now() - 14 * DAY,
  );
  relay.seed(first);
  relay.seed(
    written(
      "Sign-up is live",
      [
        "What we said last time\nDone: Ship sign-up\nNot done: Write the guide (Ran out of week.)\nChanged: Find a designer",
        "What happened this week\nSign-up shipped on Tuesday.",
        "Help needed (Small)\nSomeone to test on an older phone.",
      ].join("\n\n"),
      [
        ["update-part", "done", "Sign-up shipped on Tuesday."],
        ["promise-mark", `${first.id}:0`, "done", ""],
        ["promise-mark", `${first.id}:1`, "not-done", "Ran out of week."],
        ["promise-mark", `${first.id}:2`, "changed", ""],
        ["help-needed", "Someone to test on an older phone."],
        ["help-size", "small"],
      ],
      now() - 7 * DAY,
    ),
  );
  // Another founder took the same project id.
  relay.seed(projectRecord(OTHER, "rhythm", "Rhythm Copy", now() - DAY));
}

const meta = (page: import("@playwright/test").Page, selector: string) =>
  page.evaluate(
    (sel) => document.head.querySelector(sel)?.getAttribute("content") ?? null,
    selector,
  );

test("signed out, a project's scorecard shows its record and no price; Follow asks for an account", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("blocked")) },
    });
  });
  await install(page, relay, null);
  await page.goto(CARD);
  const card = page.getByTestId("scorecard");
  await expect(card.getByRole("heading", { level: 1 })).toHaveText("Rhythm");
  await expect(card.getByTestId("scorecard-goal")).toHaveText(
    "A metronome anyone can fork.",
  );
  // The record is one line of chips: how fresh, how steady, and how many promises were kept, missed and changed.
  await expect(card.getByTestId("record-line-streak")).toHaveText(
    "2 weeks in a row",
    { timeout: 30_000 },
  );
  await expect(card.getByTestId("record-line-kept")).toHaveText(
    "Kept 1 of 3 promises, 1 missed, 1 changed",
  );
  await expect(card.getByTestId("record-line-freshness")).toHaveText(
    "Next update today",
  );
  await expect(card.getByTestId("scorecard-update-help")).toContainText(
    "Someone to test on an older phone.",
  );
  await expect
    .poll(() =>
      card
        .getByTestId("scorecard-promise")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-state")).sort(),
        ),
    )
    .toEqual(["changed", "kept", "missed"]);
  await expect(
    card
      .getByTestId("scorecard-promise")
      .filter({ hasText: "Write the guide" }),
  ).toContainText("Ran out of week.");
  await expect(card.getByTestId("scorecard-update")).toContainText(
    "Sign-up is live",
  );
  // The update is laid out under last week's promises, each answered by what the update signed.
  await expect
    .poll(() =>
      card
        .getByTestId("update-promise-row")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-state")),
        ),
    )
    .toEqual(["kept", "missed", "changed"]);
  await expect(
    card.getByTestId("update-promise-row").filter({ hasText: "Ship sign-up" }),
  ).toContainText("Kept");
  await expect(card.getByTestId("update-this-week")).toContainText(
    "Sign-up shipped on Tuesday.",
  );
  // A visitor: Follow is the one green button, "I can help" and Share are outline, and the way to start one's own
  // project is a quiet link.
  await expect(card.getByTestId("scorecard-follow")).toHaveClass(/bg-primary/);
  await expect(card.getByTestId("scorecard-help")).not.toHaveClass(
    /bg-primary/,
  );
  await expect(card.getByTestId("share-record")).not.toHaveClass(/bg-primary/);
  await expect(card.getByTestId("start-yours")).toHaveText(
    "Start your own project",
  );
  await expect(card.getByTestId("scorecard-team")).toContainText(
    "Mia Maker · founder",
  );
  await expect(card.getByTestId("scorecard-team")).toContainText("Max Mate");
  await expect(card).not.toContainText(/\$|price|earn|Rhythm Copy/i);

  // The tab and the description say whose record this is.
  await expect(page).toHaveTitle("Rhythm on Creaton");
  expect(await meta(page, 'meta[name="description"]')).toBe(
    "A metronome anyone can fork. 2 weeks in a row. 1 of 3 promises kept.",
  );
  expect(await meta(page, 'meta[property="og:title"]')).toBe(
    "Rhythm on Creaton",
  );
  expect(await meta(page, 'meta[property="og:url"]')).toContain(CARD);
  await expectAccessible(page, "a project's scorecard, signed out");

  // Share: the browser will not copy here, so the words are shown.
  await card.getByTestId("share-record").click();
  await expect(card.getByTestId("share-record-words")).toHaveValue(
    new RegExp(
      `^Rhythm on Creaton: 2 weeks in a row, 1 of 3 promises kept\\. http\\S+${CARD}$`,
    ),
  );
  await expect(card.getByTestId("scorecard-help")).toHaveAttribute(
    "href",
    new RegExp(`/launchpad/rhythm\\?author=${ME}&tab=updates`),
  );
  // Follow needs an account: the sign-up dialog opens, and nothing is stored.
  await card.getByTestId("scorecard-follow").click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  expect(relay.events.filter((e) => e.kind === 10003)).toHaveLength(0);

  // Leaving the page puts the site's own title back.
  await page.keyboard.press("Escape");
  await page.goto("/discover");
  await expect(page).not.toHaveTitle("Rhythm on Creaton");
});

test("the address opens only the project whose founder it names", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  await install(page, relay, null);
  await page.goto(`/p/rhythm-${OTHER.slice(0, 16)}`);
  await expect(
    page.getByTestId("scorecard").getByRole("heading", { level: 1 }),
  ).toHaveText("Rhythm Copy");
  await page.goto(`/p/rhythm-${"0".repeat(16)}`);
  await expect(page.getByTestId("scorecard-missing")).toBeVisible();
  await expect(page.getByTestId("scorecard")).toHaveCount(0);
  // One project holds this id, under another founder than the address names: it is not opened in their place.
  relay.seed(projectRecord(OTHER, "solo", "Solo", now() - DAY));
  await page.goto(`/p/solo-${ME.slice(0, 16)}`);
  await expect(page.getByTestId("scorecard-missing")).toBeVisible();
  await expect(page.getByTestId("scorecard")).toHaveCount(0);
  await page.goto(`/p/solo-${OTHER.slice(0, 16)}`);
  await expect(
    page.getByTestId("scorecard").getByRole("heading", { level: 1 }),
  ).toHaveText("Solo");
  await page.goto("/p/rhythm");
  await expect(page.getByTestId("scorecard-missing")).toContainText(
    "doesn't name a project",
  );
});

test("signed in, Follow is one tap and is stored", async ({ page }) => {
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  await install(page, relay, VISITOR_KEY);
  await page.goto(CARD);
  const follow = page.getByTestId("scorecard-follow");
  await expect(follow).toBeEnabled({ timeout: 30_000 });
  await follow.click();
  await expect(follow).toHaveText("Following");
  await expect
    .poll(() =>
      relay.events.some(
        (e) =>
          e.kind === 10003 &&
          e.pubkey === pubkeyOf(VISITOR_KEY) &&
          e.tags.some((t) => t[0] === "a" && t[1] === COORD),
      ),
    )
    .toBe(true);
});

test("when the record cannot be read the scorecard says so, with a retry", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  relay.setClosingSockets(
    (filter) =>
      Array.isArray(filter?.kinds) &&
      filter.kinds.length === 1 &&
      filter.kinds[0] === 47003,
  );
  await install(page, relay, null);
  await page.goto(CARD);
  const card = page.getByTestId("scorecard");
  await expect(card.getByRole("heading", { level: 1 })).toHaveText("Rhythm", {
    timeout: 60_000,
  });
  await expect(card.getByTestId("scorecard-failed")).toBeVisible({
    timeout: 60_000,
  });
  await expect(card.getByTestId("record-line-kept")).toHaveCount(0);
  relay.setClosingSockets(false);
  await card
    .getByTestId("scorecard-failed")
    .getByRole("button", { name: "Try again" })
    .click();
  await expect(card.getByTestId("record-line-kept")).toContainText(
    "Kept 1 of 3 promises",
    { timeout: 30_000 },
  );
});

test("at 390px the scorecard fits with no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  await install(page, relay, null);
  await page.goto(CARD);
  await expect(page.getByTestId("record-line-kept")).toContainText(
    "Kept 1 of 3 promises",
    { timeout: 30_000 },
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
