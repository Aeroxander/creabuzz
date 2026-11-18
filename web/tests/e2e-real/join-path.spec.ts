import { expect as baseExpect, test } from "@playwright/test";
import { decrypt as nip49Decrypt } from "nostr-tools/nip49";

import {
  JOIN_PATH_HOSTED_BUDGET,
  PressCounter,
} from "../helpers/press-counter";
import {
  INVITE_ONLY,
  accountFromKey,
  closeBrowsers,
  newAccount,
  ownBrowserPage,
  publishAs,
  readAs,
} from "./project-loop-helpers";

/**
 * A stranger asks to join a project from its link, against a REAL server with the hosted settings
 * (`E2E_WORLD=pilot E2E_SPEC=join-path.spec.ts scripts/real-loop-e2e.sh`: the web app built as the hosted image builds
 * it, the server with the pilot's terms of use, privacy note and the age box).
 *
 * The count is of everything the person does from the signed-out link to "Asked to join": Ask to join, the name, the age
 * tick, the terms tick and Create. The ask is sent by itself once the account exists, so there is no second press of
 * Ask to join. The budget is `JOIN_PATH_HOSTED_BUDGET`; the open-server count, without terms, is held by
 * `project-loop.spec.ts` flow 12 and the mocked `project-join.spec.ts`.
 */

const expect = baseExpect.configure({ timeout: 20_000 });
test.afterAll(closeBrowsers);

const RUN = Date.now().toString(36).slice(-5);
const SLUG = `lantern-${RUN}`;
const JOINER_NAME = `Jo ${RUN}`;

test("a stranger on the hosted settings asks to join from the link with every press and field counted, and the ask is sent by itself after sign-up", async ({
  browser,
}) => {
  test.skip(
    INVITE_ONLY,
    "a stranger cannot sign up on an invite-only server: an invite link makes the account",
  );
  test.setTimeout(180_000);
  const founder = newAccount(`Fay ${RUN}`);
  const coord = `37001:${founder.pubkey}:${SLUG}`;
  const cardPath = `/p/${SLUG}-${founder.pubkey.slice(0, 16)}`;

  const made = await publishAs(founder, {
    kind: 37001,
    content: JSON.stringify({
      pitch: "A lantern for the first page.",
      stage: "draft",
    }),
    tags: [
      ["d", SLUG],
      ["name", `Lantern ${RUN}`],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
    ],
  });
  expect(made.reason).toBe("");
  expect(made.accepted).toBe(true);

  const page = await ownBrowserPage(browser);
  await page.goto(cardPath);
  const card = page.getByTestId("scorecard");
  await expect(card).toBeVisible();
  const path = new PressCounter();
  await path.press(card.getByTestId("join-ask"), "Ask to join (signed out)");
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  // The hosted settings: the terms and the age box are on the dialog, unchanged.
  const policy = page.getByTestId("onboarding-policy");
  await expect(policy).toBeVisible();
  await expect(policy).toContainText("I am 18 years of age or older.");
  await expect(policy).toContainText(
    "I agree to the Terms of use and have read the Privacy note. Posts and votes are public.",
  );
  await path.type(page.getByTestId("onboarding-name"), JOINER_NAME, "Name");
  await path.tick(page.getByTestId("onboarding-policy-age"), "age");
  await path.tick(page.getByTestId("onboarding-policy-agree"), "terms");
  await path.press(page.getByTestId("onboarding-create"), "Create");

  await expect(page.getByTestId("join-asked")).toHaveText(
    "Asked to join. It shows on the founder's Team card and in their Notifications.",
  );
  expect(new URL(page.url()).pathname, "back on the project's link").toBe(
    cardPath,
  );
  console.log(path.summary("a stranger asks to join on the hosted settings"));
  expect(path.presses).toBe(JOIN_PATH_HOSTED_BUDGET.presses);
  expect(path.fields).toBe(JOIN_PATH_HOSTED_BUDGET.fields);

  // One ask, signed by the account they just made, naming the project and the founder.
  const [sealed, wrap] = await page.evaluate(() => [
    window.localStorage.getItem("buzz.identity.nsec") ?? "",
    window.localStorage.getItem("buzz.identity.wrap") ?? "",
  ]);
  const joiner = accountFromKey(nip49Decrypt(sealed, wrap), JOINER_NAME);
  const asks = (
    await readAs(founder, {
      kinds: [47003],
      authors: [joiner.pubkey],
      "#a": [coord],
      limit: 50,
    })
  ).filter((e) => e.tags.some((t) => t[0] === "join-ask"));
  expect(asks).toHaveLength(1);
  expect(asks[0].tags).toContainEqual(["p", founder.pubkey]);
  // A reload does not send a second one.
  await page.reload();
  await expect(page.getByTestId("join-asked")).toBeVisible();
  const again = await readAs(founder, {
    kinds: [47003],
    authors: [joiner.pubkey],
    "#a": [coord],
    limit: 50,
  });
  expect(
    again.filter((e) => e.tags.some((t) => t[0] === "join-ask")),
  ).toHaveLength(1);
});
