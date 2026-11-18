import {
  coordOf,
  DAY,
  event,
  now,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./project-world";

/**
 * One person's world, for "Your projects" and Home's next step: a project they started (with promises answered, an
 * update that is ten days old, an offer nobody replied to and a helper's work waiting for a check), one they help
 * (a task waiting for their yes, and one they took on that is due tomorrow), one they follow (updated today), and one
 * that added them to its team and waits for their answer.
 */

export const ME_KEY = "e1".repeat(32);
export const NEW_KEY = "e7".repeat(32);
export const ME = pubkeyOf(ME_KEY);
const OTHER = pubkeyOf("e2".repeat(32));
const THIRD = pubkeyOf("e3".repeat(32));
const FOURTH = pubkeyOf("e4".repeat(32));
const HELPER = pubkeyOf("e5".repeat(32));
export const NEBULA = coordOf(ME, "nebula");
const ORBIT = coordOf(OTHER, "orbit");
export const COMET = coordOf(THIRD, "comet");

const record = (
  by: string,
  coord: string,
  title: string,
  tags: string[][],
  at: number,
) => event(47003, by, { title, body: "" }, [["a", coord], ...tags], at);

function task(
  relay: Relay,
  by: string,
  coord: string,
  helper: string,
  what: string,
  at: number,
  due?: string,
) {
  const made = record(
    by,
    coord,
    "Task",
    [
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["p", helper],
      ["task-helper", helper],
      ["task-what", what],
      ["task-done", "It works."],
      ["task-size", "small"],
      ...(due ? [["task-due", due]] : []),
    ],
    at,
  );
  relay.seed(made);
  return made;
}

function step(
  relay: Relay,
  by: string,
  coord: string,
  made: { id: string },
  part: string,
  at: number,
  extra: string[][] = [],
) {
  const signed = record(
    by,
    coord,
    part,
    [
      ["l", "creaton-task"],
      ["task-part", part],
      ["e", made.id],
      ["task", made.id],
      ...extra,
    ],
    at,
  );
  relay.seed(signed);
  return signed;
}

const tomorrow = () =>
  new Date((now() + DAY) * 1000).toISOString().slice(0, 10);

/** Ids of records the specs look for, set by `seedWorld`. */
export const seeded = { checkTaskId: "", askId: "" };

export function seedWorld(relay: Relay) {
  for (const [key, name] of [
    [ME, "Mia Maker"],
    [OTHER, "Otto Other"],
    [HELPER, "Robin Helper"],
  ])
    relay.seed(
      event(0, key, { name, display_name: name }, [], now() - 90 * DAY),
    );

  // Started by me: Nebula. Two updates (the second answers the first's promises and asks for help), the last one
  // ten days ago; an offer nobody replied to; and a helper's work handed in, waiting for a check.
  relay.seed(projectRecord(ME, "nebula", "Nebula", now() - 60 * DAY));
  const first = record(
    ME,
    NEBULA,
    "Week one",
    [
      ["update-part", "next", "Ship sign-up\nWrite the guide"],
      ["promise", "0", "Ship sign-up"],
      ["promise", "1", "Write the guide"],
    ],
    now() - 17 * DAY,
  );
  relay.seed(first);
  const second = record(
    ME,
    NEBULA,
    "Week two",
    [
      ["update-part", "done", "Sign-up shipped."],
      ["promise-mark", `${first.id}:0`, "done", ""],
      ["promise-mark", `${first.id}:1`, "not-done", ""],
      ["help-needed", "Someone to test on an older phone."],
      ["help-size", "small"],
    ],
    now() - 10 * DAY,
  );
  relay.seed(second);
  seeded.askId = second.id;
  relay.seed(
    record(
      HELPER,
      NEBULA,
      "Offer to help",
      [
        ["e", second.id],
        ["p", ME],
        ["help-offer", second.id],
      ],
      now() - 9 * DAY,
    ),
  );
  const check = task(
    relay,
    ME,
    NEBULA,
    HELPER,
    "Record sign-up.",
    now() - 8 * DAY,
  );
  seeded.checkTaskId = check.id;
  step(relay, HELPER, NEBULA, check, "accept", now() - 7 * DAY);
  step(relay, HELPER, NEBULA, check, "evidence", now() - 6 * DAY, [
    ["task-link", "https://example.org/recording"],
  ]);

  // I help Orbit: one task waits for my yes, one I took on and is due tomorrow.
  relay.seed(projectRecord(OTHER, "orbit", "Orbit", now() - 50 * DAY));
  task(relay, OTHER, ORBIT, ME, "Draw the logo.", now() - 2 * DAY);
  const doing = task(
    relay,
    OTHER,
    ORBIT,
    ME,
    "Write the readme.",
    now() - 5 * DAY,
    tomorrow(),
  );
  step(relay, ME, ORBIT, doing, "accept", now() - 4 * DAY);

  // I follow Comet, which posted today.
  relay.seed(projectRecord(THIRD, "comet", "Comet", now() - 40 * DAY));
  relay.seed(
    record(THIRD, COMET, "Fresh news", [["update-kind", "weekly"]], now() - 60),
  );
  relay.seed(event(10003, ME, "", [["a", COMET]], now() - 30 * DAY));

  // Dune added me to its team and waits for my answer.
  relay.seed(
    projectRecord(FOURTH, "dune", "Dune", now() - 30 * DAY, {
      tags: [
        ["team", ME, "member"],
        ["team-invite", ME, "inv1"],
        ["p", ME],
      ],
    }),
  );
}
