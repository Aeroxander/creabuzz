import { expect, test } from "@playwright/test";
import { finalizeEvent } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  openAs,
  projectPath,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/project-world";

/**
 * The checkable finish line on a task: how a helper says they checked their work, the numbers they report (shown as
 * the helper's own, with one line that compares them with the words of "Done means"), the run record they signed for a
 * piece, the plain hint and the AI's sharper wording when a task is made, the share picture offered when work is
 * accepted, and the Work page's "Open to agents" filter.
 *
 * One mock server holds every record; a person is swapped by changing whose key the page has and loading again.
 * Seeded records are not signature-checked, except a run record: the page verifies those itself, so they are signed.
 */

const FOUNDER_KEY = "b1".repeat(32);
const MATE_KEY = "b2".repeat(32);
const HELPER_KEY = "b3".repeat(32);
const AGENT_KEY = "b4".repeat(32);
const STRANGER_KEY = "b5".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const MATE = pubkeyOf(MATE_KEY);
const HELPER = pubkeyOf(HELPER_KEY);
const AGENT = pubkeyOf(AGENT_KEY);
const COORD = coordOf(FOUNDER, "nebula");
const PROJECT = projectPath(FOUNDER, "nebula");
const WHAT = "Measure the pass rate of the sign-up tests.";
const DONE = "The pass rate is at least 80% on the held-out set.";
const ZERO_MANDATE = `0x${"0".repeat(40)}`;

const key = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

const profile = (pubkey: string, name: string, tags: string[][] = []) =>
  event(0, pubkey, { name, display_name: name }, tags, now() - 30 * DAY);

/** A project with a founder and a second team member, and a task for `helper` that they have said yes to. */
function seedTask(
  relay: Relay,
  { helper = HELPER, done = DONE }: { helper?: string; done?: string } = {},
) {
  relay.seed(profile(FOUNDER, "Fay Founder"));
  relay.seed(profile(MATE, "Max Mate"));
  relay.seed(profile(HELPER, "Robin Helper"));
  relay.seed(
    projectRecord(FOUNDER, "nebula", "Nebula OS", now() - 40 * DAY, {
      tags: [
        ["team", FOUNDER, "Founder"],
        ["team", MATE, "Reviewer"],
      ],
    }),
  );
  const task = event(
    47003,
    FOUNDER,
    { title: "Task", body: WHAT },
    [
      ["a", COORD],
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["p", helper],
      ["task-helper", helper],
      ["task-what", WHAT],
      ["task-done", done],
      ["task-size", "small"],
    ],
    now() - 5 * DAY,
  );
  relay.seed(task);
  relay.seed(step(helper, task, "accept", [], "", now() - 4 * DAY));
  return task;
}

type Stored = ReturnType<typeof event>;

/** A later step on a task, as the app writes it. */
function step(
  by: string,
  task: Stored,
  part: string,
  extra: string[][],
  note: string,
  at: number,
) {
  return event(
    47003,
    by,
    { title: part, body: note, ...(note ? { note } : {}) },
    [
      ["a", COORD],
      ["l", "creaton-task"],
      ["task-part", part],
      ["e", task.id],
      ["task", task.id],
      ...(by === FOUNDER || by === MATE
        ? [["p", by === FOUNDER ? MATE : FOUNDER]]
        : [
            ["p", FOUNDER],
            ["p", MATE],
          ]),
      ...extra,
    ],
    at,
  );
}

const handed = (relay: Relay) =>
  relay.events.filter((e) =>
    e.tags.some((t) => t[0] === "task-part" && t[1] === "evidence"),
  );

test("a hand-in says how it was checked and carries the numbers it reports; they are shown as the helper's, with one line against the finish line", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  const task = seedTask(relay);
  await install(page, relay, HELPER_KEY);
  await page.goto(PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await row.getByRole("button", { name: "Hand in work" }).click();
  const form = row.getByRole("form", { name: "Hand in work" });

  // A person is not asked about steps, which is an agent helper's own line.
  await expect(form.getByTestId("hand-in-steps")).toHaveCount(0);
  await form.getByLabel("What you did").fill("Ran the suite twice.");
  await form
    .getByLabel("What you checked, and how")
    .fill("Read the log of the second run.");
  await form
    .getByLabel(/What does not meet .Done means. yet/)
    .fill("Not run on Android 8.");

  // A number that is not a plain number is refused in words, and nothing is sent.
  await form.getByTestId("hand-in-add-result").click();
  await form.getByTestId("hand-in-result-name").fill("pass rate");
  await form.getByTestId("hand-in-result-value").fill("high");
  await form.getByRole("button", { name: "Hand in", exact: true }).click();
  await expect(form.getByTestId("task-hand-in-box-problem")).toContainText(
    "needs a plain number",
  );
  expect(handed(relay)).toHaveLength(0);

  await form.getByTestId("hand-in-result-value").fill("85");
  await form.getByTestId("hand-in-result-unit").fill("%");
  await form.getByTestId("hand-in-result-sampleSize").fill("40");
  await form.getByTestId("hand-in-result-producedBy").fill("commit abc123");
  await form.getByRole("button", { name: "Hand in", exact: true }).click();
  await expect(page.getByTestId("tasks-said")).toHaveText(
    "Your work is handed in. The team is told.",
  );
  await expect.poll(() => handed(relay).length).toBe(1);
  const sent = handed(relay)[0];
  // The words carry the check lines under their labels; the number is one tag, six fields in the documented order.
  expect(JSON.parse(sent.content).note).toBe(
    "Ran the suite twice.\n\nHow I checked it: Read the log of the second run.\nNot met yet: Not run on Android 8.",
  );
  expect(sent.tags.filter((t) => t[0] === "task-result")).toEqual([
    ["task-result", "pass rate", "85", "%", "", "40", "commit abc123"],
  ]);

  // The team sees the number as the helper's own, and one line comparing it with the words of "Done means".
  await openAs(page, MATE_KEY, PROJECT);
  const results = row.getByTestId("task-results");
  await expect(results.getByTestId("task-results-label")).toHaveText(
    "Reported by the helper, not run by anyone else",
  );
  const rowOfNumber = results.getByTestId("task-result-row");
  await expect(rowOfNumber).toHaveCount(1);
  await expect(rowOfNumber).toContainText("pass rate");
  await expect(rowOfNumber).toContainText("85 %");
  await expect(rowOfNumber).toContainText("40");
  await expect(rowOfNumber).toContainText("commit abc123");
  await expect(results.getByTestId("task-threshold")).toHaveAttribute(
    "data-verdict",
    "yes",
  );
  await expect(results.getByTestId("task-threshold")).toHaveText(
    "Meets the stated threshold: yes",
  );
  await expect(row.getByTestId("task-run-record")).toHaveCount(0);
  await expect(row.getByTestId("task-evidence")).toContainText(
    "How I checked it: Read the log of the second run.",
  );

  // A second piece that misses the limit says no; the first still says yes.
  relay.seed(
    step(
      HELPER,
      task,
      "evidence",
      [["task-result", "pass rate", "70", "%", "85", "", ""]],
      "Rerun with a smaller set.",
      now() - 60,
    ),
  );
  await page.reload();
  const verdicts = row.getByTestId("task-threshold");
  await expect(verdicts).toHaveCount(2);
  await expect(verdicts.nth(0)).toHaveAttribute("data-verdict", "yes");
  await expect(verdicts.nth(1)).toHaveAttribute("data-verdict", "no");
});

test("a piece that reports a number for words that state no limit says the threshold is not stated, and bad number tags show none", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  const task = seedTask(relay, { done: "A screen recording of sign-up." });
  relay.seed(
    step(
      HELPER,
      task,
      "evidence",
      [["task-result", "latency", "120", "ms", "", "", ""]],
      "Timed it.",
      now() - 120,
    ),
  );
  // Two results with one name break the bounds the server holds a hand-in to: the page shows none of them.
  relay.seed(
    step(
      HELPER,
      task,
      "evidence",
      [
        ["task-result", "Score", "1", "", "", "", ""],
        ["task-result", "score", "2", "", "", "", ""],
      ],
      "Scored it.",
      now() - 60,
    ),
  );
  await install(page, relay, MATE_KEY);
  await page.goto(PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await expect(row.getByTestId("task-threshold")).toHaveAttribute(
    "data-verdict",
    "not stated",
  );
  await expect(row.getByTestId("task-threshold")).toHaveText(
    "Meets the stated threshold: not stated",
  );
  await expect(row.getByTestId("task-results-broken")).toContainText(
    "none of them is shown",
  );
  // The words of the broken piece still show.
  await expect(row.getByTestId("task-evidence").nth(1)).toContainText(
    "Scored it.",
  );
  await expect(row.getByTestId("task-result-row")).toHaveCount(1);
});

test("a labelled agent helper is also asked whether every step was needed, and the answer is written into the hand-in", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(
    profile(AGENT, "Scout", [
      ["agent", AGENT],
      ["auth", FOUNDER, "kind=0", "0".repeat(128)],
    ]),
  );
  seedTask(relay, { helper: AGENT });
  await install(page, relay, AGENT_KEY);
  await page.goto(PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await row.getByRole("button", { name: "Hand in work" }).click();
  const form = row.getByRole("form", { name: "Hand in work" });
  await form.getByLabel("What you did").fill("Wrote the tests.");
  await form
    .getByLabel("Was every step needed? (optional)")
    .fill("Two of five steps could have been skipped.");
  await form.getByRole("button", { name: "Hand in", exact: true }).click();
  await expect.poll(() => handed(relay).length).toBe(1);
  expect(JSON.parse(handed(relay)[0].content).note).toBe(
    "Wrote the tests.\n\nWas every step needed? Two of five steps could have been skipped.",
  );
});

test("the hand-in box offers the AI check of the work against 'Done means': it sees the typed words, shows its answer only to the helper, and posts nothing", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedTask(relay);
  const asked: string[] = [];
  await install(page, relay, HELPER_KEY);
  await installAi(
    page,
    JSON.stringify({ gaps: ["Say which pages the tests covered."] }),
    asked,
  );
  await page.goto(PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await row.getByRole("button", { name: "Hand in work" }).click();
  const form = row.getByRole("form", { name: "Hand in work" });
  const check = form.getByTestId("work-claim-ai-check");
  // Nothing to check until there is something typed.
  await expect(check).toBeDisabled();
  await form.getByLabel("What you did").fill("Ran the suite twice.");
  await form
    .getByLabel("What you checked, and how")
    .fill("Read the log of the second run.");
  const before = relay.events.length;
  await check.click();
  await expect(form.getByTestId("work-claim-ai-gaps")).toContainText(
    "Say which pages the tests covered.",
  );
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain(DONE);
  expect(asked[0]).toContain("Ran the suite twice.");
  expect(asked[0]).toContain("Read the log of the second run.");
  // Nothing was published by asking, and the words typed since make the answer out of date.
  expect(relay.events.length).toBe(before);
  await form.getByLabel("What you did").fill("Ran the suite three times.");
  await expect(form.getByTestId("work-claim-ai-stale")).toBeVisible();
  await expect(form.getByTestId("work-claim-ai-gaps")).toHaveCount(0);
});

/** A run record as `buzz launchpad work-checks --task` signs it, for one piece of a task's work. */
function runRecord(
  signer: string,
  task: Stored,
  piece: Stored,
  over: { claim?: string; mandate?: string } = {},
) {
  const claim = over.claim ?? `0x${task.id}`;
  const mandate = over.mandate ?? ZERO_MANDATE;
  const evidence = `0x${piece.id}`;
  return finalizeEvent(
    {
      kind: 47010,
      created_at: now() - 30,
      tags: [
        ["a", COORD],
        ["c", `${mandate}:${claim}:${evidence}`],
        ["claim", claim],
        ["evidence", evidence],
        ["mandate", mandate],
        ["sandbox", "enforced"],
        ["task", task.id],
        ["task-evidence", piece.id],
      ],
      content: JSON.stringify({
        v: 1,
        type: "work-check-run",
        run: `0x${"1".repeat(64)}`,
        claim: { id: claim, mandate },
        evidenceHash: evidence,
        criteria: { claimCheck: { hash: `0x${"c".repeat(64)}`, words: null } },
        checks: [
          {
            name: "sign-up tests",
            argv: ["pnpm", "test"],
            auxiliary: false,
            criterion: {
              source: "claim-check",
              hash: `0x${"c".repeat(64)}`,
              words: null,
            },
            status: "passed",
            exitStatus: 0,
            stdout: "ok",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            notRunReason: null,
          },
        ],
        summary: { passed: 1, failed: 0, timedOut: 0, notRun: 0, auxiliary: 0 },
        notIndependentVerification: "The helper's own run.",
        limitations: [],
        model: null,
        sandboxEnforced: true,
      }),
    },
    key(signer),
  );
}

test("a run record the helper signed for a piece shows under that piece as the helper's own run; another signer's, a wrong task's and a forged one do not", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  const task = seedTask(relay);
  const piece = step(
    HELPER,
    task,
    "evidence",
    [],
    "Ran the checks.",
    now() - 600,
  );
  relay.seed(piece);
  // The later piece names the record; the record itself belongs to the first piece.
  const mine = runRecord(HELPER_KEY, task, piece);
  const later = step(
    HELPER,
    task,
    "evidence",
    [["task-run-record", mine.id]],
    "Same work, with the run record.",
    now() - 300,
  );
  relay.seed(later);
  relay.seed(mine);
  relay.seed(runRecord(STRANGER_KEY, task, piece));
  // A record whose text was changed after it was signed.
  relay.seed({ ...runRecord(HELPER_KEY, task, piece), content: "{}" });
  await install(page, relay, MATE_KEY);
  await page.goto(PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  const pieces = row.getByTestId("task-evidence-extras");
  await expect(pieces).toHaveCount(2);
  const first = pieces.nth(0);
  const run = first.getByTestId("task-run-record");
  await expect(run).toHaveCount(1);
  await expect(run).toContainText("Run record");
  await expect(run).toContainText("Signed by Robin Helper");
  await expect(run).toContainText("It is not a check by anyone else");
  await expect(run.getByTestId("task-run-record-tally")).toContainText(
    "1 passed · 0 failed · 0 timed out · 0 not run",
  );
  await expect(run).toContainText("sign-up tests: Passed");
  await expect(first.getByTestId("task-run-record-others")).toContainText(
    "One run record for this piece was signed by someone who is not the helper",
  );
  const second = pieces.nth(1);
  await expect(second.getByTestId("task-run-record")).toHaveCount(0);
  await expect(second.getByTestId("task-run-record-named")).toContainText(
    "It is shown under the piece it ran against.",
  );
});

test("a run record bound to another task, or for a chain claim, is never shown under a piece", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  const task = seedTask(relay);
  const piece = step(HELPER, task, "evidence", [], "Ran it.", now() - 600);
  relay.seed(piece);
  // Same piece id, but another mandate (a chain claim's): the `c` value does not match, so it is not even read.
  relay.seed(
    runRecord(HELPER_KEY, task, piece, { mandate: `0x${"3".repeat(40)}` }),
  );
  await install(page, relay, MATE_KEY);
  await page.goto(PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await expect(row.getByTestId("task-evidence-extras")).toHaveCount(1);
  await expect(row.getByTestId("task-run-record")).toHaveCount(0);
  await expect(row.getByTestId("task-run-record-others")).toHaveCount(0);
});

/** The AI service stand-in: the probe (an empty body) is refused as a real server would, a question is answered. */
async function installAi(
  page: import("@playwright/test").Page,
  reply: string,
  asked: string[],
) {
  await page.route("**/llm/chat/completions", async (route) => {
    const body = route.request().postData() ?? "";
    if (body === "{}") {
      await route.fulfill({ status: 401, body: "unauthorized" });
      return;
    }
    asked.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ choices: [{ message: { content: reply } }] }),
    });
  });
}

test("making a task warns, never blocks, when 'Done means' has nothing to count or open; the AI proposes sharper words the team accepts or edits", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedTask(relay);
  const asked: string[] = [];
  await install(page, relay, FOUNDER_KEY);
  await installAi(
    page,
    JSON.stringify({
      done: "A screen recording of sign-up working on Android 9, linked here.",
    }),
    asked,
  );
  await page.goto(PROJECT);
  await page.getByRole("button", { name: "Give someone a task" }).click();
  const form = page.getByRole("form", { name: "Give someone a task" });
  await form.getByRole("button", { name: "I'll do it myself" }).click();
  await form
    .getByLabel("What is the task")
    .fill("Test sign-up on an old phone");
  const done = form.getByLabel("Done means");
  await done.fill("It works well on an old phone");
  const lint = form.getByTestId("done-means-lint");
  await expect(lint).toContainText(
    "A reviewer has nothing to count or open yet",
  );
  await expect(lint).toContainText('"well"');
  await expect(lint).toContainText("You can make the task as it is.");

  // The AI sees the team's words and nothing else, and its answer is a proposal to edit.
  await form.getByTestId("done-means-ai").click();
  const proposal = form.getByTestId("done-means-ai-proposal");
  await expect(proposal).toBeVisible();
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("It works well on an old phone");
  expect(asked[0]).toContain("Test sign-up on an old phone");
  await proposal
    .getByLabel("Suggested words (edit them if you like)")
    .fill("A screen recording of sign-up on Android 9.");
  // Typing more in the real field makes the proposal out of date rather than leaving it standing.
  await done.fill("It works well on an old phone, always");
  await expect(form.getByTestId("done-means-ai-stale")).toBeVisible();
  await expect(proposal).toHaveCount(0);
  await form.getByTestId("done-means-ai").click();
  await expect(form.getByTestId("done-means-ai-proposal")).toBeVisible();
  await form.getByTestId("done-means-ai-use").click();
  await expect(done).toHaveValue(
    "A screen recording of sign-up working on Android 9, linked here.",
  );
  await expect(form.getByTestId("done-means-lint")).toHaveCount(0);
  // Nothing was published by the AI: no task exists until the team presses Make the task.
  expect(
    relay.events.filter((e) =>
      e.tags.some((t) => t[0] === "task-part" && t[1] === "task"),
    ).length,
  ).toBe(1);

  // The hint never blocks: vague words are still a task.
  await done.fill("Make it work better");
  await expect(form.getByTestId("done-means-lint")).toContainText('"better"');
  await form.getByRole("button", { name: "Make the task" }).click();
  await expect(page.getByTestId("tasks-said")).toContainText("Task made.");
  await expect
    .poll(
      () =>
        relay.events.filter((e) =>
          e.tags.some(
            (t) => t[0] === "task-done" && t[1] === "Make it work better",
          ),
        ).length,
    )
    .toBe(1);
});

test("without an AI service there is no suggestion button, and the hint still shows", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedTask(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.route("**/llm/chat/completions", (route) =>
    route.fulfill({ status: 404, body: "not found" }),
  );
  await page.goto(PROJECT);
  await page.getByRole("button", { name: "Give someone a task" }).click();
  const form = page.getByRole("form", { name: "Give someone a task" });
  await form.getByRole("button", { name: "I'll do it myself" }).click();
  await form.getByLabel("Done means").fill("It is all done and good");
  await expect(form.getByTestId("done-means-lint")).toBeVisible();
  await expect(form.getByTestId("done-means-ai")).toHaveCount(0);
});

test("when work is accepted, the person who accepted it is offered its share picture on the record, and can put it away", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const relay = createMockRelay({ applyDeletions: true });
  const task = seedTask(relay);
  relay.seed(step(HELPER, task, "evidence", [], "Ran the suite.", now() - 300));
  await install(page, relay, MATE_KEY);
  await page.goto(PROJECT);
  const tasks = page.getByTestId("project-tasks");
  await expect(page.getByTestId("task-share")).toHaveCount(0);
  await tasks.getByRole("button", { name: "Confirm it's done" }).click();
  await tasks.getByRole("button", { name: "Yes, confirm" }).click();
  // The task leaves the open list at once; the picture is offered where the work now stands, on the record.
  const record = page.getByTestId("project-record");
  const accepted = record.getByTestId("record-work-accepted");
  await expect(accepted).toContainText(WHAT);
  const share = record.getByTestId("task-share");
  await expect(share).toContainText("You accepted this work");
  await expect(share).toContainText(WHAT);
  await expect(
    share.getByRole("button", { name: "Share this accepted work" }),
  ).toBeVisible();
  await expect(share.getByTestId("share-card-download")).toBeVisible();
  // The words it shares say the work was accepted, never a price or Shares.
  await share.getByRole("button", { name: "Share this accepted work" }).click();
  await expect(share.getByTestId("share-record-status")).toHaveText(
    "Copied. Paste it anywhere.",
  );
  const words = await page.evaluate(() => navigator.clipboard.readText());
  expect(words).toContain(`Work accepted: ${WHAT}`);
  expect(words).toContain("/p/");
  expect(words).not.toMatch(/Shares|\$|earn/i);
  await share.getByTestId("task-share-dismiss").click();
  await expect(share).toHaveCount(0);
  // It is for this visit and this person: a reload, or someone else, is not offered it.
  await page.reload();
  await expect(page.getByTestId("task-share")).toHaveCount(0);
  await expect(page.getByTestId("record-work-accepted")).toBeVisible();
});

test("the Work page can be narrowed to projects about AI agents or tools, and says that any agent may still offer elsewhere", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  const A = pubkeyOf("c1".repeat(32));
  const B = pubkeyOf("c2".repeat(32));
  const C = pubkeyOf("c3".repeat(32));
  relay.seed(
    projectRecord(A, "robo", "Robo Helper", now() - 30 * DAY, {
      tags: [["t", "AI agent or tool"]],
    }),
  );
  relay.seed(
    projectRecord(B, "garden", "Garden Notes", now() - 20 * DAY, {
      tags: [["t", "Software"]],
    }),
  );
  relay.seed(
    projectRecord(C, "swarm", "Swarm", now() - 10 * DAY, {
      tags: [["t", "AI agents"]],
    }),
  );
  const ask = (founder: string, id: string, text: string, at: number) =>
    relay.seed(
      event(
        47003,
        founder,
        { title: "This week", body: "" },
        [
          ["a", coordOf(founder, id)],
          ["help-needed", text],
          ["help-size", "small"],
        ],
        at,
      ),
    );
  ask(A, "robo", "Write a prompt test.", now() - 3 * DAY);
  ask(B, "garden", "Weed the beds.", now() - 2 * DAY);
  ask(C, "swarm", "Draw the swarm logo.", now() - DAY);
  await install(page, relay, null);
  await page.goto("/work");
  const open = page.getByTestId("work-open");
  const items = open.getByTestId("work-open-item");
  await expect(items).toHaveCount(3);
  const toggle = open.getByTestId("work-agents-only");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(items).toHaveCount(2);
  await expect(open).toContainText("Robo Helper");
  await expect(open).toContainText("Swarm");
  await expect(open).not.toContainText("Garden Notes");
  await expect(open.getByTestId("work-open-count")).toHaveText(
    "2 open requests",
  );
  await expect(open.getByTestId("work-agents-note")).toContainText(
    "An agent account can offer on any request",
  );
  // It works with the size chips.
  await open.getByTestId("work-size-large").click();
  await expect(items).toHaveCount(0);
  await expect(open.getByTestId("work-open-empty")).toContainText(
    "No AI project is asking for help right now.",
  );
  await open.getByTestId("work-size-all").click();
  await toggle.click();
  await expect(items).toHaveCount(3);
});
