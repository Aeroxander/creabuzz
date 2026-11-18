import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { expect, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  projectPath,
  projectRecord,
  pubkeyOf,
} from "./helpers/project-world";

/**
 * The founder checks the work of an agent nobody can prove is theirs, with a second agent on the team that a person
 * vouches for. Nobody but the founder could have checked it, so it is the founder's own check: the project page and
 * Home say so in the same words, and neither calls it accepted.
 */

const FOUNDER_KEY = "e1".repeat(32);
const OPERATOR_KEY = "e2".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const OPERATOR = pubkeyOf(OPERATOR_KEY);
const BOT = pubkeyOf("e3".repeat(32)); // does the work; its records say agent, nothing proves who runs it
const BOT2 = pubkeyOf("e4".repeat(32)); // on the team; its profile carries a person's signed word
const COORD = coordOf(FOUNDER, "nebula");

const about = (by: string, title: string, tags: string[][], at: number) =>
  event(47003, by, { title, body: "" }, [["a", COORD], ...tags], at);

test("the founder's check of an agent's work reads the same on the project page and on Home", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(event(0, FOUNDER, { name: "Fay Founder" }, [], now() - 90 * DAY));
  const proof = bytesToHex(
    schnorr.sign(
      sha256(new TextEncoder().encode(`nostr:agent-auth:${BOT2}:kind=0`)),
      hexToBytes(OPERATOR_KEY),
    ),
  );
  relay.seed(
    event(
      0,
      BOT2,
      { name: "Scout" },
      [
        ["agent", BOT2],
        ["auth", OPERATOR, "kind=0", proof],
      ],
      now() - 30 * DAY,
    ),
  );
  relay.seed(
    projectRecord(FOUNDER, "nebula", "Nebula", now() - 60 * DAY, {
      tags: [
        ["team", BOT2, "member"],
        ["p", BOT2],
      ],
    }),
  );
  const task = about(
    FOUNDER,
    "Task",
    [
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["p", BOT],
      ["task-helper", BOT],
      ["task-what", "Draw the north"],
      ["task-done", "The north is drawn"],
      ["task-size", "small"],
    ],
    now() - 5 * DAY,
  );
  relay.seed(task);
  const step = (by: string, part: string, extra: string[][], at: number) =>
    about(
      by,
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
  relay.seed(step(BOT, "accept", [["agent", BOT]], now() - 4 * DAY));
  const evidence = step(
    BOT,
    "evidence",
    [
      ["agent", BOT],
      ["task-link", "https://example.org/north"],
    ],
    now() - 3 * DAY,
  );
  relay.seed(evidence);
  relay.seed(
    step(FOUNDER, "confirm", [["task-evidence", evidence.id]], now() - 2 * DAY),
  );
  await install(page, relay, FOUNDER_KEY);

  await page.goto(projectPath(FOUNDER, "nebula"));
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-work-alone")).toContainText(
    "Draw the north",
    { timeout: 20_000 },
  );
  await expect(record.getByTestId("record-work-alone")).toContainText(
    "Done, checked by you",
  );
  await expect(record.getByTestId("record-work-accepted")).toHaveCount(0);

  await page.goto("/?tab=updates");
  const card = page
    .getByTestId("record-feed")
    .getByTestId("record-card")
    .filter({ hasText: "Draw the north" });
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card.getByTestId("record-card-label")).not.toHaveText(
    "Work accepted",
  );
  await expect(card).not.toContainText("Checked by Scout");
});
