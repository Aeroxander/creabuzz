import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import {
  FAY,
  FAY_KEY,
  READER,
  READER_KEY,
  seedSocial,
} from "./helpers/social-world";
import { event, install, now, projectLink } from "./helpers/world";
import { createMockRelay, PREVIEW_PORT } from "./mock-relay";

/**
 * A project's brain in the app, at phone width (360), in a real browser against a REAL git repository: the notes are fetched
 * by the app's own git library over the smart HTTP protocol (a real `git upload-pack` answers it, behind the page's routes),
 * so what is proved is the browser side end to end: nothing is asked of the server until the notes are opened, the request
 * is signed, the files are drawn as plain text, a long file is cut with a way to read on, and a refusal is told in words.
 * The server's own check of who may read a repository (the room it is attached to) is held by its tests, not here.
 */
test.use({ viewport: { width: 360, height: 740 } });

const REPO_ID = "brain-lantern";
const GIT_PATH = `/git/${FAY}/${REPO_ID}.git`;
const MARKUP = '<img src="x" onerror="window.__brainRan=1"><b>facts</b>';
const LONG = `${"A line of the long file, written in plain words.\n".repeat(200)}THE LAST LINE`;

let dir = "";

/** A bare repository holding a small brain, made with the real git. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "creaton-brain-e2e-"));
  const work = join(root, "work");
  const bare = join(root, "brain.git");
  mkdirSync(join(work, "playbooks"), { recursive: true });
  writeFileSync(
    join(work, "AGENTS.md"),
    "# Read this first\nUse only what is written here.\n",
  );
  writeFileSync(join(work, "facts.md"), `${MARKUP}\n`);
  writeFileSync(join(work, "decisions.md"), LONG);
  writeFileSync(
    join(work, "playbooks", "launch.md"),
    "Steps to launch a lamp.\n",
  );
  writeFileSync(join(work, "notes.bin"), Buffer.from([0, 1, 2, 3]));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd },
    );
  git(root, "init", "--bare", "-b", "main", bare);
  git(work, "init", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-m", "the brain");
  git(work, "push", bare, "main");
  return bare;
}

function run(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args);
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", reject);
    child.on("close", () => resolve(Buffer.concat(out)));
    child.stdin.end(input);
  });
}

interface GitLog {
  requests: { method: string; url: string; auth: string | null }[];
}

/** Answer the repository's smart HTTP address from the real repository (or refuse it, when `refuse` is set). */
async function serveGit(
  page: Page,
  bare: string,
  refuse: { status: number | null },
): Promise<GitLog> {
  const log: GitLog = { requests: [] };
  await page.route(`**${GIT_PATH}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    log.requests.push({
      method: request.method(),
      url: url.pathname + url.search,
      auth: request.headers().authorization ?? null,
    });
    if (refuse.status !== null)
      return route.fulfill({ status: refuse.status, body: "not for you" });
    if (request.method() === "GET" && url.pathname.endsWith("/info/refs")) {
      const advert = await run([
        "upload-pack",
        "--stateless-rpc",
        "--advertise-refs",
        bare,
      ]);
      const head = "# service=git-upload-pack\n";
      const line = `${(head.length + 4).toString(16).padStart(4, "0")}${head}0000`;
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/x-git-upload-pack-advertisement",
        },
        body: Buffer.concat([Buffer.from(line), advert]),
      });
    }
    if (
      request.method() === "POST" &&
      url.pathname.endsWith("/git-upload-pack")
    ) {
      const result = await run(
        ["upload-pack", "--stateless-rpc", bare],
        request.postDataBuffer() ?? Buffer.alloc(0),
      );
      return route.fulfill({
        status: 200,
        headers: { "content-type": "application/x-git-upload-pack-result" },
        body: result,
      });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  return log;
}

function brainRecord(bound: boolean) {
  return event(
    30617,
    FAY,
    "",
    [
      ["d", REPO_ID],
      ["name", "Project brain"],
      ...(bound ? [["buzz-channel", "c".repeat(8)]] : []),
    ],
    now() - 3600,
  );
}

test.beforeAll(() => {
  dir = makeRepo();
});
test.afterAll(() => {
  if (dir) rmSync(join(dir, ".."), { recursive: true, force: true });
});

test("a reader opens the project's notes: nothing is asked until then, then they are drawn as plain words, a long one is cut", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  relay.seed(brainRecord(true));
  const refuse = { status: null as number | null };
  const log = await serveGit(page, dir, refuse);
  await install(page, relay, READER_KEY);
  await page.goto(projectLink(FAY, "lantern"));
  await expect(page.getByTestId("brain-row")).toBeVisible();
  // The line about the notes is on the page, and the server has been asked for none of them.
  await page.waitForTimeout(500);
  expect(log.requests).toEqual([]);
  await expectAccessible(page, "the project page with its notes line");
  await expectNoSidewaysScroll(page, "the project page with its notes line");

  const path = new PressCounter();
  await path.press(page.getByTestId("brain-open"), "Read the project's notes");
  const reader = page.getByTestId("brain-reader");
  await expect(reader).toContainText("Use only what is written here.");
  // Every request was signed as the reader, for this repository's own address.
  expect(log.requests.length).toBeGreaterThanOrEqual(2);
  for (const request of log.requests) {
    expect(request.auth).toMatch(/^Nostr /);
    const signed = JSON.parse(
      Buffer.from((request.auth ?? "").slice(6), "base64").toString(),
    );
    expect(signed.pubkey).toBe(READER);
    expect(signed.kind).toBe(27235);
    expect(signed.tags).toContainEqual([
      "u",
      `http://127.0.0.1:${PREVIEW_PORT}${GIT_PATH}`,
    ]);
  }

  // The files are listed in order: the four at the top that exist, then the playbooks; nothing else of the repository.
  const names = await reader
    .locator('[data-testid^="brain-file-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid")),
    );
  expect(names).toEqual([
    "brain-file-AGENTS.md",
    "brain-file-facts.md",
    "brain-file-decisions.md",
    "brain-file-playbooks/launch.md",
  ]);

  // Markup in a file is words: no element, nothing runs.
  await path.press(
    reader.getByRole("button", { name: /facts\.md/ }),
    "facts.md",
  );
  await expect(reader).toContainText(
    '<img src="x" onerror="window.__brainRan=1"><b>facts</b>',
  );
  expect(await reader.locator("img, b, script").count()).toBe(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __brainRan?: number }).__brainRan,
    ),
  ).toBeUndefined();

  // A long file is cut, and read on a press at a time to its last line.
  await path.press(
    reader.getByRole("button", { name: /decisions\.md/ }),
    "decisions.md",
  );
  await expect(
    reader
      .getByTestId("brain-text")
      .filter({ hasText: "A line of the long file" }),
  ).toBeVisible();
  await expect(reader).not.toContainText("THE LAST LINE");
  const readOn = reader.getByRole("button", { name: "Read on: decisions.md" });
  for (let i = 0; i < 6 && (await readOn.count()) > 0; i++)
    await readOn.click();
  await expect(reader).toContainText("THE LAST LINE");
  await expect(readOn).toHaveCount(0);
  expect(path.fields).toBe(0);
  await expectAccessible(page, "the notes, open");
  await expectNoSidewaysScroll(page, "the notes, open");
});

test("a refusal is told in plain words with Try again, and a second try can read", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  relay.seed(brainRecord(true));
  const refuse = { status: 404 as number | null };
  const log = await serveGit(page, dir, refuse);
  await install(page, relay, READER_KEY);
  await page.goto(projectLink(FAY, "lantern"));
  await page.getByTestId("brain-open").click();
  const failure = page.getByTestId("brain-failure");
  await expect(failure).toContainText("not open to you");
  await expect(failure).not.toContainText(/404|HTTP|git/);
  await expectAccessible(page, "the notes, refused");
  refuse.status = null;
  await failure.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("brain-reader")).toContainText(
    "Use only what is written here.",
  );
  expect(log.requests.length).toBeGreaterThan(1);
});

test("a founder with no brain sees how to keep one; a reader sees nothing", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  await install(page, relay, FAY_KEY);
  await page.goto(projectLink(FAY, "lantern"));
  const row = page.getByTestId("brain-row");
  await expect(row).toContainText("Keep a project brain");
  await page.getByTestId("brain-setup-open").click();
  await expect(page.getByTestId("brain-steps")).toContainText(
    `--id ${REPO_ID} `,
  );
  await expectAccessible(page, "the set-up steps");
  await expectNoSidewaysScroll(page, "the set-up steps");
  await page.evaluate(() => localStorage.setItem("e2e.key", "e1".repeat(32)));
  await page.goto(projectLink(FAY, "lantern"));
  await expect(page.getByTestId("project-name")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("brain-row")).toHaveCount(0);
});

test("Start offers the brain in one optional line: a yes costs one press and opens the steps, a skip costs nothing", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/start");
  const path = new PressCounter();
  await path.type(page.getByTestId("start-name"), "Night Sky Maps", "Name");
  await path.type(
    page.getByTestId("start-goal"),
    "A map of the night sky that ten people use.",
    "Goal",
  );
  await path.type(
    page.getByTestId("start-how"),
    "Ten people use it every week.",
    "How",
  );
  await expectAccessible(page, "Start with the brain line");
  await expectNoSidewaysScroll(page, "Start with the brain line");
  await path.press(page.getByTestId("start-brain"), "Keep a project brain");
  await path.press(page.getByTestId("start-submit"), "Start");
  await expect(page.getByTestId("project-name")).toHaveText("Night Sky Maps", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("brain-steps")).toContainText(
    "--id brain-night-sky-maps ",
  );
  // Within the plan's budget for Start with the tab press included by the other spec: the yes is one more press than a skip.
  expect(path.presses).toBeLessThanOrEqual(PLAN_V2_BUDGETS.start.presses);
  expect(path.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.start.fields);
  expect(
    relay.events.some((e) => e.kind === 37001 && e.pubkey === READER),
  ).toBe(true);
});
