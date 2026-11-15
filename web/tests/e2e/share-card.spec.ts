import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, type Page, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import { waitForAnimations } from "../helpers/animations";
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
import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * The share picture. A project's scorecard offers a 1200 by 630 picture of its mark, name, goal and one line from its
 * signed record, in three variants: just started, promises kept, work accepted. It can be downloaded, handed to the
 * system share sheet where the browser allows files, or posted to Home in one click. It never shows a price, returns
 * or Shares as value, and states weeks in a row only once two promises are answered.
 */

const ME_KEY = "f1".repeat(32);
const ME = pubkeyOf(ME_KEY);
const MATE = pubkeyOf("f2".repeat(32));
const HELPER = pubkeyOf("f3".repeat(32));
const VISITOR_KEY = "f4".repeat(32);
const COORD = coordOf(ME, "rhythm");
const CARD = `/p/rhythm-${ME.slice(0, 16)}`;
const QUIET_CARD = `/p/quill-${ME.slice(0, 16)}`;
const ONE_CARD = `/p/solo-${ME.slice(0, 16)}`;
const PORT = COMMUNITY_HOST.split(":")[1];

const update = (
  by: string,
  coord: string,
  title: string,
  tags: string[][],
  at: number,
) => event(47003, by, { title, body: "" }, [["a", coord], ...tags], at);

function seed(relay: Relay) {
  for (const [key, name] of [
    [ME, "Mia Maker"],
    [MATE, "Max Mate"],
    [HELPER, "Robin Helper"],
  ])
    relay.seed(
      event(0, key, { name, display_name: name }, [], now() - 90 * DAY),
    );
  relay.seed(
    projectRecord(ME, "rhythm", "Rhythm", now() - 60 * DAY, {
      content: { pitch: "A metronome anyone can fork." },
      tags: [
        ["team", MATE, "member"],
        ["p", MATE],
      ],
    }),
  );
  // Three promises, three answers, a run of three weeks.
  const first = update(
    ME,
    COORD,
    "Two weeks ago",
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
    update(
      ME,
      COORD,
      "Sign-up is live",
      [
        ["update-part", "done", "Sign-up shipped on Tuesday."],
        ["promise-mark", `${first.id}:0`, "done", ""],
        ["promise-mark", `${first.id}:1`, "not-done", "Ran out of week."],
        ["promise-mark", `${first.id}:2`, "changed", ""],
      ],
      now() - 7 * DAY,
    ),
  );
  relay.seed(
    update(
      ME,
      COORD,
      "This week",
      [["update-part", "done", "Wrote the guide."]],
      now() - 3600,
    ),
  );
  // Work for the helper, handed in, and accepted by the other team member.
  const task = update(
    ME,
    COORD,
    "Task",
    [
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["p", HELPER],
      ["task-helper", HELPER],
      ["task-what", "Record sign-up on Android 9."],
      ["task-done", "A screen recording."],
      ["task-size", "small"],
    ],
    now() - 5 * DAY,
  );
  relay.seed(task);
  const step = (by: string, part: string, extra: string[][], at: number) =>
    update(
      by,
      COORD,
      part,
      [
        ["l", "creaton-task"],
        ["task-part", part],
        ["e", task.id],
        ["task", task.id],
        ...extra,
      ],
      at,
    );
  relay.seed(step(HELPER, "accept", [], now() - 4 * DAY));
  const evidence = step(
    HELPER,
    "evidence",
    [["task-link", "https://example.org/recording"]],
    now() - 3 * DAY,
  );
  relay.seed(evidence);
  relay.seed(
    step(MATE, "confirm", [["task-evidence", evidence.id]], now() - 2 * DAY),
  );

  // Quill: one promise answered, but three weeks of updates. The picture states no run of weeks.
  const quillCoord = coordOf(ME, "quill");
  relay.seed(
    projectRecord(ME, "quill", "Quill", now() - 40 * DAY, {
      content: { pitch: "A pen for the web." },
    }),
  );
  const quill = update(
    ME,
    quillCoord,
    "Week one",
    [
      ["update-part", "next", "Ship the editor"],
      ["promise", "0", "Ship the editor"],
    ],
    now() - 14 * DAY,
  );
  relay.seed(quill);
  relay.seed(
    update(
      ME,
      quillCoord,
      "Week two",
      [
        ["update-part", "done", "The editor shipped."],
        ["promise-mark", `${quill.id}:0`, "done", ""],
      ],
      now() - 7 * DAY,
    ),
  );
  relay.seed(
    update(
      ME,
      quillCoord,
      "Week three",
      [["update-part", "done", "Still going."]],
      now() - 3600,
    ),
  );

  // Solo: a brand-new project with nothing on its record.
  relay.seed(
    projectRecord(ME, "solo", "Solo", now() - DAY, {
      content: { pitch: "A solo project." },
    }),
  );
}

/** What this browser does when asked to share a file, recorded; and no clipboard, so the words are shown. */
async function withShareSheet(page: Page, supported: boolean) {
  await page.addInitScript((on) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("blocked")) },
    });
    const shared: { files: string[]; types: string[]; text: string }[] = [];
    (window as unknown as { __shared: typeof shared }).__shared = shared;
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: on
        ? (data: { files?: File[]; text?: string }) => {
            shared.push({
              files: (data.files ?? []).map((f) => f.name),
              types: (data.files ?? []).map((f) => f.type),
              text: data.text ?? "",
            });
            return Promise.resolve();
          }
        : undefined,
    });
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: on ? () => true : undefined,
    });
  }, supported);
}

const sha = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** Width and height from a PNG's header. */
function pngSize(path: string) {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const PRICE_WORDS = /\$|price|earn|return|profit|market cap|value|USDC|ETH/i;

test("the scorecard offers a 1200 by 630 picture of the record, three ways, each its own image", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  await withShareSheet(page, false);
  await install(page, relay, null);
  await page.goto(CARD);
  const panel = page.getByTestId("scorecard-share");
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText(
    "Share this scorecard",
  );
  const image = panel.getByTestId("share-card-image");
  // Promises kept is the default: three answered, so the run of weeks is stated.
  await expect(image).toHaveAttribute(
    "alt",
    "Rhythm on Creaton. Goal: A metronome anyone can fork.. 1 of 3 promises kept, 3 weeks in a row",
    { timeout: 30_000 },
  );
  await expect
    .poll(() =>
      image.evaluate((img: HTMLImageElement) => [
        img.naturalWidth,
        img.naturalHeight,
      ]),
    )
    .toEqual([1200, 630]);
  // No system share sheet here: the button is not offered, and Download is.
  await expect(panel.getByTestId("share-card-native")).toHaveCount(0);
  await expect(panel.getByTestId("share-card-download")).toBeEnabled();
  await expect(panel).not.toContainText(PRICE_WORDS);
  await expectAccessible(page, "the scorecard with its share picture");

  const hashes: string[] = [];
  const keep = async (name: string) => {
    const downloading = page.waitForEvent("download");
    await panel.getByTestId("share-card-download").click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("rhythm-creaton.png");
    const path = testInfo.outputPath(`${name}.png`);
    await download.saveAs(path);
    expect(pngSize(path)).toEqual({ width: 1200, height: 630 });
    await expect(panel.getByTestId("share-card-status")).toHaveText(
      "Image downloaded.",
    );
    hashes.push(sha(path));
  };
  await keep("kept");

  // Work accepted: one piece of work was accepted, and the picture says so.
  await panel.getByTestId("scorecard-share-accepted").click();
  await expect(image).toHaveAttribute(
    "alt",
    "Rhythm on Creaton. Goal: A metronome anyone can fork.. 1 piece of work accepted",
  );
  await expect(panel.getByTestId("scorecard-share-accepted")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete))
    .toBe(true);
  await keep("accepted");

  // A brand-new project: started, and nothing else claimed.
  await page.goto(ONE_CARD);
  const solo = page.getByTestId("scorecard-share");
  await expect(solo.getByTestId("share-card-image")).toHaveAttribute(
    "alt",
    "Solo on Creaton. Goal: A solo project.. Just started. Follow along as it gets built.",
    { timeout: 30_000 },
  );
  // Only the one picture the record can back: no choice is offered.
  await expect(solo.getByTestId("scorecard-share-kept")).toHaveCount(0);
  const downloading = page.waitForEvent("download");
  await solo.getByTestId("share-card-download").click();
  const started = testInfo.outputPath("started.png");
  await (await downloading).saveAs(started);
  expect(pngSize(started)).toEqual({ width: 1200, height: 630 });
  hashes.push(sha(started));

  // Three different pictures, not one picture three times.
  expect(new Set(hashes).size).toBe(3);

  // Screenshots scoped to the picture, one per variant, must differ from each other too.
  const shoot = async (name: string, from: Page) => {
    await waitForAnimations(from);
    const path = testInfo.outputPath(`shot-${name}.png`);
    await from.getByTestId("share-card-image").screenshot({ path });
    return sha(path);
  };
  const shots = [await shoot("started", page)];
  await page.goto(CARD);
  await expect(page.getByTestId("share-card-image")).toHaveAttribute(
    "alt",
    /promises kept/,
    { timeout: 30_000 },
  );
  shots.push(await shoot("kept", page));
  await page.getByTestId("scorecard-share-accepted").click();
  await expect(page.getByTestId("share-card-image")).toHaveAttribute(
    "alt",
    /piece of work accepted/,
  );
  shots.push(await shoot("accepted", page));
  expect(new Set(shots).size).toBe(3);
});

test("a streak is stated only once two promises are answered", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  await withShareSheet(page, false);
  await install(page, relay, null);
  await page.goto(QUIET_CARD);
  const panel = page.getByTestId("scorecard-share");
  // The page itself shows the run of weeks; the picture and its words do not, with one answered promise.
  await expect(page.getByTestId("scorecard-streak")).toHaveText(
    "3 weeks in a row",
    { timeout: 30_000 },
  );
  await expect(panel.getByTestId("share-card-image")).toHaveAttribute(
    "alt",
    "Quill on Creaton. Goal: A pen for the web.. 1 of 1 promise kept",
  );
  await page.getByTestId("share-record").click();
  await expect(page.getByTestId("share-record-words")).toHaveValue(
    new RegExp(
      `^Quill on Creaton: 1 of 1 promise kept\\. http\\S+${QUIET_CARD}$`,
    ),
  );
});

test("a brand-new project's Share words say it just started", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  await withShareSheet(page, false);
  await install(page, relay, null);
  await page.goto(ONE_CARD);
  await expect(page.getByTestId("scorecard-share")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("share-record").click();
  await expect(page.getByTestId("share-record-words")).toHaveValue(
    new RegExp(
      `^Solo on Creaton: just started\\. Follow along as it gets built\\. http\\S+${ONE_CARD}$`,
    ),
  );
});

test("where the browser can share a file, the picture goes to the share sheet with the words", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  await withShareSheet(page, true);
  await install(page, relay, null);
  await page.goto(CARD);
  const panel = page.getByTestId("scorecard-share");
  const native = panel.getByTestId("share-card-native");
  await expect(native).toBeEnabled({ timeout: 30_000 });
  await native.click();
  const shared = await page.evaluate(
    () =>
      (window as unknown as { __shared: unknown[] }).__shared as {
        files: string[];
        types: string[];
        text: string;
      }[],
  );
  expect(shared).toHaveLength(1);
  expect(shared[0].files).toEqual(["rhythm-creaton.png"]);
  expect(shared[0].types).toEqual(["image/png"]);
  expect(shared[0].text).toMatch(
    new RegExp(
      `^Rhythm on Creaton: 3 weeks in a row, 1 of 3 promises kept\\. http\\S+${CARD}$`,
    ),
  );
});

test("Post to Home asks a visitor for an account and posts nothing", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  await withShareSheet(page, false);
  await install(page, relay, null);
  await page.goto(CARD);
  const post = page.getByTestId("share-card-post");
  await expect(post).toBeEnabled({ timeout: 30_000 });
  await post.click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  expect(relay.events.filter((e) => e.kind === 1)).toHaveLength(0);
});

test("signed in, one click posts the words, the link and the picture to Home", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  const me = pubkeyOf(VISITOR_KEY);
  const pictureUrl = `http://127.0.0.1:${PORT}/media/${"ab".repeat(32)}.png`;
  const uploads: number[] = [];
  await page.route("**/upload", async (route) => {
    uploads.push(route.request().postDataBuffer()?.length ?? 0);
    await route.fulfill({
      json: {
        url: pictureUrl,
        sha256: "ab".repeat(32),
        size: 1,
        type: "image/png",
        uploaded: 1,
      },
    });
  });
  await withShareSheet(page, false);
  await install(page, relay, VISITOR_KEY);
  await page.goto(CARD);
  const post = page.getByTestId("share-card-post");
  await expect(post).toBeEnabled({ timeout: 30_000 });
  await post.click();
  await expect(page.getByTestId("share-card-status")).toHaveText(
    "Posted to Home.",
  );
  await expect(post).toHaveText("Posted");
  await expect(post).toBeDisabled();
  const note = relay.events.find((e) => e.kind === 1 && e.pubkey === me);
  expect(note, "the post reached the server").toBeTruthy();
  expect(note?.content).toMatch(
    new RegExp(
      `^Rhythm on Creaton: 3 weeks in a row, 1 of 3 promises kept\\. http\\S+${CARD}\\n\\n${pictureUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
  expect(note?.tags).toContainEqual(["a", COORD]);
  expect(note?.content).not.toMatch(PRICE_WORDS);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toBeGreaterThan(1000);
});

test("when the picture will not upload, only the words are posted and it says so", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  const me = pubkeyOf(VISITOR_KEY);
  await page.route("**/upload", (route) =>
    route.fulfill({ status: 500, body: "no" }),
  );
  await withShareSheet(page, false);
  await install(page, relay, VISITOR_KEY);
  await page.goto(CARD);
  const post = page.getByTestId("share-card-post");
  await expect(post).toBeEnabled({ timeout: 30_000 });
  await post.click();
  await expect(page.getByTestId("share-card-status")).toHaveText(
    "Posted to Home. The picture did not upload, so only the words went up.",
  );
  const notes = relay.events.filter((e) => e.kind === 1 && e.pubkey === me);
  expect(notes).toHaveLength(1);
  expect(notes[0].content).not.toContain("/media/");
});
