import { execFile } from "node:child_process";

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { expect as baseExpect, test, type Page } from "@playwright/test";
import { decrypt as nip49Decrypt } from "nostr-tools/nip49";

import { PressCounter, SOLO_PATH_BUDGET } from "../helpers/press-counter";
import {
  type Account,
  INVITE_ONLY,
  OWNER_KEY,
  accountFromKey,
  addMembers,
  closeBrowsers,
  newAccount,
  ownBrowserPage,
  publishAs,
  readAs,
  shot,
  tagOf,
} from "./project-loop-helpers";

/**
 * A person alone, against a REAL server (`E2E_WORLD=pilot scripts/real-loop-e2e.sh` boots it): the web app built as the
 * hosted image builds it (contributor-only), the server with the pilot's terms of use, privacy note and age box.
 *
 * One person with no account, no key, no address and nobody else, from Home's goal box to the first piece of work done,
 * and then what the project page, the scorecard, the picture, the first update, Home a week later and "Add a person"
 * say about it. Every record is signed in the browser and checked by the server's own rules; what the server holds is
 * read back from it. The tests share one project and run in order.
 *
 * On an open server the path starts at Home's goal box and is held to the budget in `SOLO_PATH_BUDGET` (the same one
 * `tests/e2e/solo-path-guard.spec.ts` holds on a mocked server). On an invite-only server nobody arrives signed out at
 * Home: the invite link makes the account, so the path starts at Start and is counted without the sign-up dialog.
 * With `E2E_SHOTS=<dir>` every stop is saved as a picture at 1280 and at 390.
 */

const expect = baseExpect.configure({ timeout: 20_000 });
test.describe.configure({ mode: "serial", retries: 0 });
test.afterAll(closeBrowsers);

const RUN = Date.now().toString(36).slice(-5);
const FOUNDER_NAME = `Sol ${RUN}`;
const PROJECT = `Lantern ${RUN}`;
const GOAL = "A first page three people read";
const WORK = `Wrote the first page ${RUN}`;
const PROMISE = "Publish the first page";
const QUIET = "Quiet week. Still working on it.";
const WIDE = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const path = new PressCounter();

let page: Page;
let ownerPage: Page | null = null;
let founder: Account;
/** Someone who reads the server for the checks (a member, on an invite-only server). */
const reader = newAccount(`Reader ${RUN}`);
let slug = "";
let projectPath = "";
let cardPath = "";
let coord = "";

/** Pictures of the stop at both widths, when asked for with E2E_SHOTS. The width goes back to the wide one. */
async function stopOf(who: Page, name: string) {
  if (!process.env.E2E_SHOTS) return;
  await who.setViewportSize(WIDE);
  await who.waitForTimeout(500);
  await shot(who, `${name}-1280`);
  await who.setViewportSize(PHONE);
  await who.waitForTimeout(500);
  await shot(who, `${name}-390`);
  await who.setViewportSize(WIDE);
  await who.waitForTimeout(300);
}
const stop = (name: string) => stopOf(page, name);

const projectRecords = async (tagName: string) =>
  (await readAs(reader, { kinds: [47003], "#a": [coord], limit: 500 })).filter(
    (e) => e.tags.some((t) => t[0] === tagName),
  );
const taskSteps = async (part: string) =>
  (await projectRecords("task-part")).filter(
    (e) => tagOf(e, "task-part") === part,
  );

function psql(sql: string): Promise<string> {
  const database = process.env.BUZZ_REAL_DATABASE_URL;
  if (!database)
    throw new Error("BUZZ_REAL_DATABASE_URL is not set (the script sets it)");
  return new Promise((resolve, reject) => {
    execFile(
      "psql",
      [database, "-v", "ON_ERROR_STOP=1", "-Atqc", sql],
      { timeout: 30_000 },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(stderr || String(error)))
          : resolve(stdout.trim()),
    );
  });
}

/** The two boxes of the sign-up dialog, when the server asks for them: the age box and the terms box. */
async function tickTerms(who: Page, counted: boolean) {
  const policy = who.getByTestId("onboarding-policy");
  await expect(policy).toBeVisible();
  const age = who.getByTestId("onboarding-policy-age");
  const agree = who.getByTestId("onboarding-policy-agree");
  if (counted) {
    await path.tick(age, "age");
    await path.tick(agree, "terms");
  } else {
    await age.check();
    await agree.check();
  }
}

/**
 * A key that never signed up on this server is asked for its terms before it can act (the pilot's terms are on): it
 * agrees, as a person would. Nothing happens when the server asks for nothing.
 */
async function agreeIfAsked(who: Page) {
  const again = who.getByTestId("terms-again-dialog");
  try {
    await again.waitFor({ timeout: 10_000 });
  } catch {
    return;
  }
  await tickTerms(who, false);
  await who.getByTestId("terms-again-agree").click();
  await expect(again).toHaveCount(0);
}

/** One invite link for one person, made in the owner's People page (an invite-only server). */
async function makeInvite(): Promise<string> {
  if (!ownerPage) throw new Error("the owner's browser is not open");
  const host = new URL(ownerPage.url()).host;
  await ownerPage.goto(`/c/${host}`);
  await ownerPage.getByTestId("people-toggle").click();
  await ownerPage.getByTestId("invite-make").click();
  return await ownerPage.getByTestId("invite-link").inputValue();
}

test("1. alone, with no account: the goal typed on Home, the project named, the account made without a passkey, and the project is live", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  if (INVITE_ONLY) await addMembers([reader.pubkey]);
  page = await ownBrowserPage(browser);
  await page.setViewportSize(WIDE);

  if (INVITE_ONLY) {
    // Nobody can sign up here without a link: the owner makes one, and the link makes the account.
    ownerPage = await ownBrowserPage(browser);
    await ownerPage.addInitScript((key) => {
      if (!window.localStorage.getItem("buzz.identity.nsec")) {
        window.localStorage.setItem("buzz.identity.nsec", key);
        window.localStorage.setItem("buzz.identity.backedUp", "1");
      }
    }, OWNER_KEY);
    await ownerPage.goto("/");
    await expect(ownerPage.getByTestId("user-chip")).toBeVisible();
    await agreeIfAsked(ownerPage);
    await page.goto(await makeInvite());
    await page.getByTestId("invite-name").fill(FOUNDER_NAME);
    // The invite page asks for the pilot's terms and age box itself, before it makes the account.
    const notice = page.getByTestId("invite-join-policy-notice");
    await expect(notice).toBeVisible();
    // The boxes are drawn by their labels and the input itself is hidden from the eye: from the keyboard, Space ticks it.
    for (const box of await notice.getByRole("checkbox").all()) {
      await box.focus();
      await page.keyboard.press("Space");
      await expect(box).toBeChecked();
    }
    await page.getByTestId("invite-create-and-join").click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    await expect(page.getByTestId("user-chip")).toBeVisible();
    await page.goto("/start");
    await expect(page.getByTestId("quick-start")).toBeVisible();
    await stop("01-start");
    const form = page.getByTestId("quick-start");
    await path.type(form.getByLabel("What is the goal?"), GOAL, "goal");
    await path.type(form.getByLabel("Project name"), PROJECT, "Project name");
  } else {
    await page.goto("/");
    // Home's goal box, for a person with no account: one box and one green button, no passkey, address or key asked.
    const hero = page.getByTestId("home-welcome");
    await expect(hero).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(hero.locator("button.bg-primary, a.bg-primary")).toHaveCount(
      1,
    );
    await path.read(page, "Home", hero);
    await stop("01-home");
    await path.type(
      hero.getByLabel("What are you making?"),
      GOAL,
      "What are you making?",
    );
    await path.press(hero.getByTestId("home-welcome-start"), "Start a project");
    await expect(page).toHaveURL(/\/start$/);
    const form = page.getByTestId("quick-start");
    await expect(form.getByLabel("What is the goal?")).toHaveValue(GOAL);
    await expect(form.getByLabel("Project name")).toBeFocused();
    await path.read(page, "Start", form);
    await stop("02-start");
    await path.type(form.getByLabel("Project name"), PROJECT, "Project name");
  }

  const form = page.getByTestId("quick-start");
  // One example fills "How will people know it worked?"; the person edits it or keeps it.
  await path.press(form.getByTestId("quick-how-number"), "an example");
  await expect(
    form.getByLabel("How will people know it worked?"),
  ).not.toHaveValue("");
  await stop("03-start-filled");
  await path.press(form.getByTestId("quick-start-go"), "Start the project");

  if (!INVITE_ONLY) {
    // The account: the pilot's terms and age box, unchanged, and one green button for the way this device supports.
    const dialog = page.getByTestId("onboarding-dialog");
    await expect(dialog).toBeVisible();
    const policy = page.getByTestId("onboarding-policy");
    await expect(policy).toContainText("I am 18 years of age or older.");
    await expect(policy).toContainText(
      "I agree to the Terms of use and have read the Privacy note. Posts and votes are public.",
    );
    await path.read(page, "Create your account");
    await path.type(page.getByTestId("onboarding-name"), FOUNDER_NAME, "Name");
    await stop("04-sign-up");
    await tickTerms(page, true);
    // Nothing asks for a key, an address or a passkey: the one green button makes the account without one on a device
    // that has none, and the passkey button is the quiet one.
    await expect(dialog.locator("button.bg-primary:visible")).toHaveText(
      /Create without a passkey|Create with a passkey/,
    );
    await stop("05-sign-up-filled");
    await path.press(
      page.getByTestId("onboarding-create"),
      "Create without a passkey",
    );
  }

  // The project is made about two seconds later, with no further press, and its page opens on one first-week card.
  await expect(page).toHaveURL(/\/launchpad\/[^/?]+\?.*started=1/, {
    timeout: 60_000,
  });
  const url = new URL(page.url());
  slug = url.pathname.split("/").pop() ?? "";
  const author = url.searchParams.get("author") ?? "";
  expect(author).toMatch(/^[0-9a-f]{64}$/);
  projectPath = `/launchpad/${slug}?author=${author}`;
  cardPath = `/p/${slug}-${author.slice(0, 16)}`;
  coord = `37001:${author}:${slug}`;
  const card = page.getByTestId("first-week");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator("button.bg-primary")).toHaveText(
    "Add what you did",
  );
  await path.read(page, "the project page", card);
  await stop("06-project-first-seen");

  // Whose account it is: read from the browser's own sealed key, to act as them on a socket.
  const [sealed, wrap] = await page.evaluate(() => [
    window.localStorage.getItem("buzz.identity.nsec") ?? "",
    window.localStorage.getItem("buzz.identity.wrap") ?? "",
  ]);
  founder = accountFromKey(nip49Decrypt(sealed, wrap), FOUNDER_NAME);
  expect(founder.pubkey).toBe(author);

  // What the server holds: the project, theirs alone, and the goal they typed.
  const [record] = await readAs(reader, { kinds: [37001], authors: [author] });
  expect(record, "the project record").toBeTruthy();
  expect(
    record.tags.filter((t) => t[0] === "team" && t[1] !== author),
    "nobody else is on the new project's team",
  ).toEqual([]);
  const goals = await projectRecords("goal");
  expect(goals).toHaveLength(1);
  expect(goals[0].tags).toContainEqual(["goal-text", GOAL]);
  console.log(path.summary("to a live project"));
});

test("2. the first piece of work done: Add what you did, one line, Done", async () => {
  test.setTimeout(120_000);
  await path.press(page.getByTestId("first-week-add"), "Add what you did");
  const win = page.getByRole("dialog", { name: "What did you get done?" });
  await expect(win).toBeVisible();
  await path.read(page, "What did you get done?");
  await stop("07-what-did-you-get-done");
  await path.type(win.getByLabel("What did you finish?"), WORK, "What you did");
  await path.press(win.getByRole("button", { name: "Done" }), "Done");

  const done = page.getByTestId("first-week-work-done");
  await expect(done).toContainText("First piece of work done");
  await path.read(
    page,
    "the first-week card after Done",
    page.getByTestId("first-week"),
  );
  await stop("08-first-work-done");

  // The server holds one task, one hand-in and one check, all the founder's, and the check is of that hand-in.
  await expect.poll(async () => (await taskSteps("confirm")).length).toBe(1);
  const [task] = await taskSteps("task");
  const [evidence] = await taskSteps("evidence");
  const [check] = await taskSteps("confirm");
  expect(await taskSteps("task")).toHaveLength(1);
  expect(await taskSteps("evidence")).toHaveLength(1);
  for (const step of [task, evidence, check])
    expect(step.pubkey, "the founder signed every step").toBe(founder.pubkey);
  expect(tagOf(check, "task-evidence")).toBe(evidence.id);
  expect(tagOf(task, "task-what")).toBe(WORK);

  const counts = path.counts();
  console.log(path.summary("from Home to the first piece of work done"));
  for (const line of counts.log) console.log(`[path]   ${line}`);
  if (!INVITE_ONLY) {
    // The budget: a press or a field added anywhere on the path fails here, with the log above to say where.
    expect(counts.presses).toBeLessThanOrEqual(SOLO_PATH_BUDGET.presses);
    expect(counts.fields).toBeLessThanOrEqual(SOLO_PATH_BUDGET.fields);
  }
});

test("3. the record, the scorecard and the picture say done, checked by the founder, and never accepted", async () => {
  test.setTimeout(120_000);
  await page.goto(projectPath);
  const line = page.getByTestId("record-line");
  // The founder reads their own page in the second person; everyone else reads "the founder".
  await expect(line.getByTestId("record-line-done-alone")).toHaveText(
    /^1 piece of work done, checked by (you|the founder)$/,
  );
  await expect(line.getByTestId("record-line-accepted")).toHaveCount(0);
  await expect(page.getByTestId("first-week-work-done")).toBeVisible();
  await stop("09-project-after");

  // The scorecard at the project's shared address.
  await page.goto(cardPath);
  const scorecard = page.getByTestId("scorecard");
  await expect(scorecard).toBeVisible();
  await expect(scorecard.getByTestId("record-line-done-alone")).toContainText(
    /1 piece of work done, checked by (you|the founder)/,
  );
  await expect(scorecard.getByTestId("record-line-accepted")).toHaveCount(0);
  await expect(scorecard).toContainText(WORK);
  await stop("10-scorecard");

  // The picture says the same, in words and in the file. A brand-new record offers the choice between "started" and
  // "done"; the done one is the one that names the work.
  const share = page.getByTestId("scorecard-share");
  await expect(share).toBeVisible();
  const choose = share.getByTestId("scorecard-share-done");
  if ((await choose.count()) > 0) await choose.click();
  const image = share.getByTestId("share-card-image");
  await expect(image).toHaveAttribute(
    "alt",
    /1 piece of work done, checked by the founder/,
    { timeout: 30_000 },
  );
  await expect(image).not.toHaveAttribute("alt", /accepted/);
  await expect(image).not.toHaveAttribute("alt", /price|return|Shares/i);
  const downloading = page.waitForEvent("download");
  await share.getByTestId("share-card-download").click();
  const file = await downloading;
  expect(file.suggestedFilename()).toMatch(/\.png$/);
  await stop("11-scorecard-share");

  // Home's record says it in the same words, and never as "working alone".
  await page.goto("/");
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  const feed = page.getByTestId("record-feed");
  await expect(feed).toContainText(/Done by .+\. Checked by the founder\./, {
    timeout: 40_000,
  });
  await expect(feed).not.toContainText("working alone");
  await expect(feed).not.toContainText(/accepted/i);
});

test("4. the first update, with a quiet-week note: the next update is dated, and the reminder is offered", async () => {
  test.setTimeout(120_000);
  await page.goto(projectPath);
  await expect(page.getByTestId("first-week-work-done")).toBeVisible();
  // After the first piece of work the one green button is the update.
  await expect(
    page.getByTestId("first-week").locator("button.bg-primary"),
  ).toHaveText("Post this week's update");
  await page.getByTestId("first-week-post").click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("What happened this week")).toBeFocused();
  await stop("12-update-dialog");
  await dialog.getByTestId("update-quiet-week").click();
  await expect(dialog.getByLabel("What happened this week")).toHaveValue(QUIET);
  await dialog.getByLabel("What's next").fill(PROMISE);
  await stop("13-update-quiet-week");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);
  const posted = page.getByTestId("update-posted");
  await expect(posted).toBeVisible();
  await expect(posted.getByTestId("update-posted-next")).toContainText(
    /^Next update: \w{3}, \w{3} \d{1,2}/,
  );
  await expect(posted.getByTestId("update-posted-reminder")).toBeVisible();
  await stop("14-update-posted");

  // The server holds the note, and the promise as a promise, by the founder.
  await expect
    .poll(async () => (await projectRecords("update-part")).length)
    .toBeGreaterThan(0);
  const parts = await projectRecords("update-part");
  expect(
    parts.some(
      (e) => e.content.includes(QUIET) || e.tags.some((t) => t.includes(QUIET)),
    ),
    "the quiet-week note was published",
  ).toBe(true);
  const promised = await projectRecords("promise");
  expect(promised.map((e) => e.pubkey)).toContain(founder.pubkey);
});

test("5. a week later Home shows one reminder for the project, with one green button", async () => {
  test.setTimeout(120_000);
  // Every project record on this scratch server moved seven days back: the update is due.
  const moved = await psql(
    "with moved as (update events set created_at = created_at - interval '7 days' where kind in (37001, 47003) returning 1) select count(*) from moved",
  );
  console.log(`[solo-path] moved ${moved} project records seven days back`);
  expect(Number(moved)).toBeGreaterThan(0);
  await page.goto("/");
  const next = page.getByTestId("home-next-step");
  await expect(next).toBeVisible({ timeout: 40_000 });
  await expect(next.locator("button.bg-primary, a.bg-primary")).toHaveCount(1);
  await expect(next).toContainText(PROJECT);
  // One reminder, not two: the update-day rail does not post its own button for a project this card covers.
  await expect(page.getByTestId("home-next-step")).toHaveCount(1);
  await stop("15-home-a-week-later");
});

test("6. Add a person says what it does, and that once someone else is on the project they check work", async () => {
  test.setTimeout(120_000);
  await page.goto(projectPath);
  const team = page.getByTestId("project-team");
  await expect(team).toBeVisible();
  await team.getByTestId("team-add").first().click();
  const dialog = page.getByRole("dialog", { name: "Add a person to the team" });
  await expect(dialog.getByTestId("team-add-warning")).toContainText(
    "They can post updates and check work. Goals and promises stay yours.",
  );
  await expect(dialog.getByTestId("team-add-alone")).toHaveText(
    "Once someone else is on the project, they check work instead of you.",
  );
  await stop("16-add-a-person");
  await page.keyboard.press("Escape");
  // Looking is not adding: the project is still theirs alone.
  const [record] = await readAs(reader, {
    kinds: [37001],
    authors: [founder.pubkey],
  });
  expect(
    record.tags.filter((t) => t[0] === "team" && t[1] !== founder.pubkey),
  ).toEqual([]);
});

test("7. an agent-labelled account sees no solo box and cannot confirm; the server says so", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // An agent account, run by the founder: its profile names itself an agent and carries the founder's signature.
  const agent = newAccount(`Scout ${RUN}`);
  if (INVITE_ONLY) await addMembers([agent.pubkey]);
  const conditions = "kind=0";
  const sig = bytesToHex(
    schnorr.sign(
      sha256(
        new TextEncoder().encode(
          `nostr:agent-auth:${agent.pubkey}:${conditions}`,
        ),
      ),
      founder.key,
    ),
  );
  // The server puts the account on record as run by the founder and may drop the connection that sent the label before
  // it says OK (seen on this server). So the proof that it was taken is the profile read back, not the answer.
  const labelled = await publishAs(agent, {
    kind: 0,
    content: JSON.stringify({ name: agent.name, display_name: agent.name }),
    tags: [
      ["agent", agent.pubkey],
      ["auth", founder.pubkey, conditions, sig],
    ],
  }).catch((error: Error) => ({ accepted: null, reason: error.message }));
  if (labelled.accepted === false) expect(labelled.reason).toBe("");
  await expect
    .poll(async () => {
      const [profile] = await readAs(reader, {
        kinds: [0],
        authors: [agent.pubkey],
      });
      return profile?.tags.some((t) => t[0] === "agent") ?? false;
    })
    .toBe(true);

  // The agent's own browser, signed in with its key.
  const agentPage = await ownBrowserPage(browser);
  await agentPage.setViewportSize(WIDE);
  await agentPage.addInitScript((key) => {
    window.localStorage.setItem("buzz.identity.nsec", key);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, agent.hexKey);
  await agentPage.goto(`/u/${agent.pubkey}`);
  await expect(agentPage.getByTestId("user-chip")).toBeVisible();
  await agreeIfAsked(agentPage);
  await agentPage.getByRole("tab", { name: "Record" }).click();
  // The label names who runs it, because the founder's signature on it was checked.
  await expect(agentPage.getByTestId("account-agent-badge")).toHaveText(
    `Agent, run by ${FOUNDER_NAME}`,
  );

  // The agent starts a project of its own, the same three answers a person gives. The server holds it to a helper's
  // powers: it may not sign the goal, so the project has none, and the page says so instead of offering it.
  await agentPage.goto("/start");
  const form = agentPage.getByTestId("quick-start");
  await form.getByLabel("What is the goal?").fill("Read every new page twice");
  await form.getByLabel("Project name").fill(`Scout notes ${RUN}`);
  await form.getByTestId("quick-how-number").click();
  await form.getByTestId("quick-start-go").click();
  // The project is made; the goal is the one thing the server will not take from an agent, and the form says so. It
  // offers the project's own page to go on from, which is where a person would set the goal.
  await expect(form.getByRole("alert")).toContainText(
    "Your project was made, but its goal was not saved.",
    { timeout: 60_000 },
  );
  await stopOf(agentPage, "17-agent-start-goal-refused");
  const open = form.getByRole("link", { name: "Open your project" });
  const href = (await open.getAttribute("href")) ?? "";
  const agentSlug = new URL(href, "http://x").pathname.split("/").pop() ?? "";
  expect(agentSlug).not.toBe("");
  const agentCoord = `37001:${agent.pubkey}:${agentSlug}`;
  await open.click();
  await expect(agentPage.getByTestId("launch-hero")).toBeVisible();
  await stopOf(agentPage, "18-agent-project");
  // No solo box for an agent: nothing here lets it say "I did it" and check itself.
  await expect(agentPage.getByTestId("first-week-add")).toHaveCount(0);
  await expect(agentPage.getByTestId("first-week-did-it")).toHaveCount(0);
  await expect(agentPage.getByTestId("solo-win-dialog")).toHaveCount(0);
  await expect(agentPage.getByTestId("task-did-it")).toHaveCount(0);

  // The server: an agent's task, its hand-in, and its own check of it, which is refused for being an agent's.
  const step = (tags: string[][], body: object) =>
    publishAs(agent, {
      kind: 47003,
      content: JSON.stringify(body),
      tags: [["a", agentCoord], ["l", "creaton-task"], ...tags],
    });
  const made = await step(
    [
      ["task-part", "task"],
      ["p", agent.pubkey],
      ["task-helper", agent.pubkey],
      ["task-what", `Read the first page ${RUN}.`],
      ["task-done", "A note on what is unclear."],
      ["task-size", "small"],
    ],
    { title: "Task", body: "Read the first page." },
  );
  expect(made.reason).toBe("");
  const handed = await step(
    [
      ["task-part", "evidence"],
      ["e", made.event.id],
      ["task", made.event.id],
    ],
    { title: "Work handed in", body: "Read it.", note: "Read it." },
  );
  expect(handed.reason).toBe("");
  const confirm = await step(
    [
      ["task-part", "confirm"],
      ["e", made.event.id],
      ["task", made.event.id],
      ["task-evidence", handed.event.id],
    ],
    { title: "Work confirmed", body: "" },
  );
  expect(confirm.accepted).toBe(false);
  expect(confirm.reason).toMatch(/agent account cannot check work/);
});
