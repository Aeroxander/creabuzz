import { expect, test } from "@playwright/test";

import {
  createMockRelay,
  isAgentAccount,
  projectRecordRefusal,
} from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  projectPath,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/project-world";

/**
 * Agent accounts and the server's newer rules, in the browser and in the test server that stands in for it.
 *
 * An account that is an agent says so on its own profile, with who runs it; the app shows that beside its name.
 * The server holds such an account to a helper's powers (it may not confirm work, give more time, or sign goals and
 * promises), so the app does not offer it those controls and says why. A record that names a project is taken only
 * from the project's own people unless it is about work that lives on the chain; a yes or no to joining a team only
 * from someone the record names. And a task can carry the limits its helper must stay within.
 */

const FOUNDER_KEY = "a7".repeat(32);
const AGENT_KEY = "a8".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const AGENT = pubkeyOf(AGENT_KEY);
const HELPER = pubkeyOf("a9".repeat(32));
const STRANGER = pubkeyOf("aa".repeat(32));
const COORD = coordOf(FOUNDER, "nebula");
const PROJECT = projectPath(FOUNDER, "nebula");

const profile = (pubkey: string, name: string, tags: string[][] = []) =>
  event(0, pubkey, { name, display_name: name }, tags, now() - 30 * DAY);
/** A profile that says "this account is an agent" and names who runs it. */
const agentProfile = () =>
  profile(AGENT, "Scout", [
    ["agent", AGENT],
    ["auth", FOUNDER, "kind=0", "0".repeat(128)],
  ]);

function seedWorld(relay: Relay) {
  relay.seed(profile(FOUNDER, "Fay Founder"));
  relay.seed(profile(HELPER, "Robin Helper"));
  relay.seed(agentProfile());
  relay.seed(
    projectRecord(FOUNDER, "nebula", "Nebula", now() - 30 * DAY, {
      tags: [
        ["team", AGENT, "member"],
        ["team-invite", AGENT, "inv1"],
        ["p", AGENT],
      ],
    }),
  );
  relay.seed(
    event(
      47003,
      AGENT,
      { title: "Joined the team", body: "" },
      [
        ["a", COORD],
        ["l", "creaton-team"],
        ["team-answer", "yes"],
        ["team-invite", "inv1"],
      ],
      now() - 20 * DAY,
    ),
  );
  const task = event(
    47003,
    FOUNDER,
    { title: "Task", body: "Record sign-up." },
    [
      ["a", COORD],
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["p", HELPER],
      ["task-helper", HELPER],
      ["task-what", "Record sign-up."],
      ["task-done", "A recording."],
      ["task-size", "small"],
    ],
    now() - 5 * DAY,
  );
  relay.seed(task);
  const step = (by: string, part: string, extra: string[][], at: number) =>
    event(
      47003,
      by,
      { title: part, body: "" },
      [
        ["a", COORD],
        ["l", "creaton-task"],
        ["task-part", part],
        ["e", task.id],
        ["task", task.id],
        ...extra,
      ],
      at,
    );
  relay.seed(step(HELPER, "accept", [], now() - 4 * DAY));
  relay.seed(
    step(
      HELPER,
      "evidence",
      [["task-link", "https://example.org/recording"]],
      now() - 3 * DAY,
    ),
  );
  return { task, step };
}

test("the test server follows the real one: who may sign what about a project, and what an agent account may not", () => {
  const relay = createMockRelay();
  const { task, step } = seedWorld(relay);
  const refusal = (e: ReturnType<typeof event>) =>
    projectRecordRefusal(e, relay.events);
  expect(isAgentAccount(AGENT, relay.events)).toBe(true);
  expect(isAgentAccount(FOUNDER, relay.events)).toBe(false);
  const plain = (by: string, content: unknown, tags: string[][] = []) =>
    event(47003, by, content, [["a", COORD], ...tags], now());

  // A plain record that names the project is the team's: a stranger's is refused, the founder's is taken.
  expect(refusal(plain(STRANGER, { title: "Official news", body: "x" }))).toBe(
    "restricted: only this project's team can post this",
  );
  expect(refusal(plain(FOUNDER, { title: "News", body: "x" }))).toBeNull();
  // Unless it is about work that lives on the chain: anyone may write those.
  for (const key of [
    "claim",
    "review",
    "agreement",
    "agreementCorrections",
    "workArea",
    "challenge",
  ])
    expect(
      refusal(plain(STRANGER, { title: "t", [key]: { v: 1 } })),
    ).toBeNull();
  // The word alone is not enough: it has to be an object.
  expect(refusal(plain(STRANGER, { title: "t", claim: "yes" }))).not.toBeNull();
  // A yes to joining the team only from someone the record names.
  const answer = (by: string) =>
    plain(by, { title: "Joined the team", body: "" }, [
      ["l", "creaton-team"],
      ["team-answer", "yes"],
      ["team-invite", "inv1"],
    ]);
  expect(refusal(answer(STRANGER))).toBe(
    "restricted: only this project's team can post this",
  );
  expect(refusal(answer(AGENT))).toBeNull();
  // A record that names no project is not looked at.
  expect(
    projectRecordRefusal(
      event(47003, STRANGER, { title: "t" }, [], now()),
      relay.events,
    ),
  ).toBeNull();

  // An agent account on the team may send work back, and may not confirm it or give more time.
  const limit =
    "restricted: an agent account cannot check work, grant more time, or sign goals and promises; a person on the team must";
  expect(refusal(step(AGENT, "send-back", [], now()))).toBeNull();
  expect(refusal(step(AGENT, "confirm", [], now()))).toBe(limit);
  expect(refusal(step(AGENT, "grant", [], now()))).toBe(limit);
  expect(refusal(step(FOUNDER, "confirm", [], now()))).toBeNull();
  expect(task.id).toHaveLength(64);
});

test("an agent account is labelled on its profile and on the team, and is not offered what the server refuses it", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, AGENT_KEY);
  await page.goto(PROJECT);
  const team = page.getByTestId("project-team");
  await expect(
    team.getByTestId("team-member").getByTestId("account-agent-badge"),
  ).toHaveText("Agent");
  // Handed-in work: the agent may send it back, and is told why it cannot confirm it.
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await expect(row.getByTestId("task-agent-no-confirm")).toContainText(
    "This account is an agent.",
  );
  await expect(
    row.getByRole("button", { name: /Confirm it's done/ }),
  ).toHaveCount(0);
  await expect(row.getByRole("button", { name: /Send back/ })).toBeVisible();
  // Its update makes no promises, and says that is because it is an agent.
  await page.getByTestId("team-post-update").click();
  await expect(page.getByTestId("update-as-team")).toContainText(
    "This account is an agent.",
  );
  await page.keyboard.press("Escape");

  await page.goto(`/u/${AGENT}`);
  await page.getByRole("tab", { name: "Record" }).click();
  await expect(page.getByTestId("account-agent-badge")).toHaveText("Agent");
  // A person's profile carries no such label.
  await page.goto(`/u/${HELPER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  await expect(page.getByTestId("track-record")).toBeVisible();
  await expect(page.getByTestId("account-agent-badge")).toHaveCount(0);
});

test("a person on the team is still offered Confirm on the same task", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await expect(
    row.getByRole("button", { name: /Confirm it's done/ }),
  ).toBeVisible();
  await expect(row.getByTestId("task-agent-no-confirm")).toHaveCount(0);
});

test("an agent account that founded a project is not offered goals, and is told a person must set them", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(agentProfile());
  relay.seed(projectRecord(AGENT, "probe", "Probe", now() - DAY));
  await install(page, relay, AGENT_KEY);
  await page.goto(projectPath(AGENT, "probe"));
  await expect(page.getByTestId("agent-founder-note")).toContainText(
    "setting goals and promises need a person",
  );
  await expect(page.getByTestId("goal-missing")).not.toContainText(
    "Your project has no goal yet",
  );
});

test("a task can say what its helper must stay within, and the task shows it", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(profile(FOUNDER, "Fay Founder"));
  relay.seed(profile(FOUNDER === HELPER ? STRANGER : HELPER, "Robin Helper"));
  relay.seed(projectRecord(FOUNDER, "nebula", "Nebula", now() - 30 * DAY));
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const tasks = page.getByTestId("project-tasks");
  await tasks.getByRole("button", { name: "Give someone a task" }).click();
  const form = tasks.getByRole("form", { name: "Give someone a task" });
  await form.getByTestId("direct-task-person").fill(FOUNDER);
  await form.getByTestId("direct-task-person").fill(HELPER);
  await form.getByTestId("person-search-result").first().click();
  await form.getByLabel("What is the task").fill("Email the first ten users.");
  await form.getByLabel("Done means").fill("Ten replies.");
  await form
    .getByLabel("Limits (optional)")
    .fill("Do not email anyone who has not signed up.");
  await form.getByRole("button", { name: "Make the task" }).click();
  const made = () =>
    relay.events.filter((e) =>
      e.tags.some((t) => t[0] === "task-part" && t[1] === "task"),
    );
  await expect.poll(() => made().length).toBe(1);
  expect(made()[0].tags).toContainEqual([
    "task-limits",
    "Do not email anyone who has not signed up.",
  ]);
  await expect(
    tasks.getByTestId("task").getByTestId("task-limits"),
  ).toContainText("Do not email anyone who has not signed up.");
});
