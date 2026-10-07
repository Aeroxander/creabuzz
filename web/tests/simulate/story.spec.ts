import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { FOUNDER_NSEC, mockLaunchRelay } from "../helpers/funding-fixture";
import { CAST } from "./cast";
import { checkAll, type Check } from "./invariants";
import { STORY } from "./scenes";
import { renderReport, reportHolds, runStory, storyIssues } from "./story";

/**
 * The story, played in the app (`just simulate`).
 *
 * This is the simulation's skeleton (plan §9): one command, a real browser
 * walking the scenes in order, and a timeline report with a screenshot per
 * step. The story itself is `./scenes.ts`, the runner `./story.ts`, and the
 * cast `./cast.ts` — none of them know about Playwright, so a scene can later
 * be played against a real relay and Anvil instead of this world.
 *
 * Each step is bound twice: the story says what the step must prove, and this
 * file plays it and asserts exactly that. Rewording a step's `does` without
 * updating its play here fails the run rather than silently proving nothing
 * (Review-Proven Rule 3).
 *
 * The four invariants are money invariants and this world has no chain, so
 * their readings say so in words — "no money in this scene" — rather than
 * claiming a treasury was checked. The detail travels into the report.
 */

const OUT_DIR = "test-results/simulate";

const card = (page: Page, name: string) =>
  page.locator('[data-testid="launch-card"]').filter({ hasText: name });

/** A world with no money in it: honest readings, not hollow ticks. */
const noMoneyReadings = (): Check[] =>
  checkAll(() => ({
    holds: true,
    detail: "no money in this scene — nothing to violate",
  }));

/**
 * The play, scene by scene, in the order `runStory` walks them. Each entry is
 * what one step does in the browser, and the screenshot it leaves behind.
 */
const PLAYS: Array<(page: Page) => Promise<string>> = [
  // ---- funding-status ----
  async (page) => {
    await page.goto("/launchpad");
    await expect(
      card(page, "Aurora").getByTestId("launch-funding-badge"),
    ).toHaveText("Planning a raise · looking for backers");
    return "01-declaration";
  },
  async (page) => {
    await expect(page.getByTestId("funding-chip-planning-count")).toHaveText(
      "1",
    );
    await expect(page.getByTestId("seeking-chip-backers-count")).toHaveText(
      "1",
    );
    await expect(page.getByTestId("funding-chip-raising-count")).toHaveText(
      "1",
    );
    return "02-directory";
  },
  async (page) => {
    await expect(
      card(page, "Cygnus").getByTestId("launch-funding-badge"),
    ).toHaveText("Raising now");
    await expect(
      card(page, "Draco").getByTestId("launch-funding-badge"),
    ).toHaveText("Rolling round");
    return "03-records-beat-words";
  },
  async (page) => {
    await expect(
      card(page, "Draco").getByTestId("launch-funding-badge"),
    ).toHaveText("Rolling round");
    return "04-rolling-round";
  },
  async (page) => {
    const badges = page.getByTestId("launch-funding-badge");
    await expect(badges.filter({ hasText: "Raising now" })).toHaveCount(1);
    return "05-no-contradiction-survives";
  },
  // ---- proposal-funding ----
  async (page) => {
    await card(page, "Aurora").getByTestId("launch-card-title").click();
    const vault = page.getByTestId("proposal-vault");
    await expect(vault).toBeVisible();
    await expect(vault).toContainText(
      "let its backers decide what gets funded",
    );
    return "06-the-vault-is-offered";
  },
  async (page) => {
    const vault = page.getByTestId("proposal-vault");
    await expect(vault).toContainText("not deployed yet");
    await expect(
      vault.getByRole("button"),
      "a control that cannot act must not be rendered",
    ).toHaveCount(0);
    return "07-nothing-can-be-pledged-yet";
  },
  async (page) => {
    // There is no pledge box either: the affordance, not just the button.
    await expect(page.getByTestId("pledge-amount")).toHaveCount(0);
    await expect(page.getByTestId("back-proposal")).toHaveCount(0);
    return "08-no-affordance-without-a-vault";
  },
];

test("the story, played in the app", async ({ page }) => {
  // A story that cannot be trusted is not worth playing.
  expect(storyIssues(STORY, CAST), "the story has structural issues").toEqual(
    [],
  );
  // This run covers the client world only; the chain scenes are played by
  // `story-anvil.spec.ts`, and the report says which world it covered.
  expect(
    STORY.scenes.filter((s) => s.world === "client").flatMap((s) => s.steps)
      .length,
    "this spec plays the client-world steps",
  ).toEqual(PLAYS.length);
  const expected = STORY.scenes
    .filter((scene) => scene.world === "client")
    .flatMap((scene) => scene.steps.map((step) => step.does));
  expect(
    PLAYS.length,
    "the plays below are bound to these exact steps",
  ).toEqual(expected.length);

  await mockLaunchRelay(page);
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  mkdirSync(OUT_DIR, { recursive: true });

  const shots: string[] = [];
  for (const play of PLAYS) {
    const name = await play(page);
    await page.screenshot({
      path: join(OUT_DIR, `${name}.png`),
      fullPage: true,
    });
    shots.push(name);
  }

  const report = await runStory(STORY, noMoneyReadings, "client");
  report.entries.forEach((entry, index) => {
    entry.artifact = `${shots[index]}.png`;
  });
  writeFileSync(join(OUT_DIR, "timeline.md"), `${renderReport(report)}\n`);
  expect(reportHolds(report), "the timeline reports a failure").toBe(true);
});
