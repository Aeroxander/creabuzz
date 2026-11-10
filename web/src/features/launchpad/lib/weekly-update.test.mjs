import assert from "node:assert/strict";
import test from "node:test";

import {
  bodyWithoutParts,
  daysSince,
  founderNudge,
  freshnessLine,
  inARowLine,
  nudgeDismissed,
  partsFromTags,
  updateEvent,
  UPDATE_LIMITS,
  weeksInARow,
} from "./weekly-update.ts";

const DAY = 86_400;
// Wednesday 3 January 2024, noon UTC: the middle of a Monday-to-Sunday week.
const NOW = Date.UTC(2024, 0, 3, 12) / 1000;

const draft = (over = {}) => ({
  title: "Week 12",
  done: "Shipped sign-up.",
  next: "Invite the first ten people.",
  body: "",
  help: "",
  helpSize: "small",
  helpTime: "",
  ...over,
});

test("the three prompts become one readable body and tags that read back the same", () => {
  const event = updateEvent(
    draft({
      help: "Someone to test on an older phone.",
      helpSize: "medium",
      helpTime: "about 3 days",
    }),
  );
  assert.equal(event.content.title, "Week 12");
  assert.equal(
    event.content.body,
    [
      "What happened this week\nShipped sign-up.",
      "What's next\nInvite the first ten people.",
      "Help needed (Medium, about 3 days)\nSomeone to test on an older phone.",
    ].join("\n\n"),
  );
  assert.deepEqual(partsFromTags(event.tags), {
    done: "Shipped sign-up.",
    next: "Invite the first ten people.",
    help: {
      text: "Someone to test on an older phone.",
      size: "medium",
      time: "about 3 days",
    },
  });
  // With the parts laid out separately there is nothing left of the body to repeat.
  assert.equal(
    bodyWithoutParts(event.content.body, partsFromTags(event.tags)),
    "",
  );
});

test("a free-form update writes no part tags and keeps its body whole", () => {
  const event = updateEvent(
    draft({ done: "", next: "", body: "  We moved studios.\n\nMore soon.  " }),
  );
  assert.deepEqual(event.tags, []);
  assert.equal(event.content.body, "We moved studios.\n\nMore soon.");
  assert.equal(partsFromTags(event.tags), null);
  assert.equal(
    bodyWithoutParts(event.content.body, null),
    "We moved studios.\n\nMore soon.",
  );
});

test("free-form words with a help request keep the words and carry only the help", () => {
  const event = updateEvent(
    draft({ done: "", next: "", body: "A quiet week.", help: "A logo." }),
  );
  const parts = partsFromTags(event.tags);
  assert.deepEqual(parts, {
    done: "",
    next: "",
    help: { text: "A logo.", size: "small", time: "" },
  });
  assert.equal(bodyWithoutParts(event.content.body, parts), "A quiet week.");
  assert.match(event.content.body, /Help needed \(Small\)\nA logo\./);
});

test("no help text means no help request, whatever size or time was left in the form", () => {
  const event = updateEvent(
    draft({ help: "   ", helpSize: "large", helpTime: "a month" }),
  );
  assert.equal(partsFromTags(event.tags)?.help, null);
  assert.equal(
    event.tags.some((t) => t[0].startsWith("help")),
    false,
  );
});

test("parts are bounded, and a size nobody offers falls back to Small", () => {
  const event = updateEvent(
    draft({ done: "x".repeat(5000), help: "h".repeat(900) }),
  );
  const parts = partsFromTags(event.tags);
  assert.equal(parts.done.length, UPDATE_LIMITS.part);
  assert.equal(parts.help.text.length, UPDATE_LIMITS.help);
  // Tags written by something else: an unknown size, an oversized part.
  const foreign = partsFromTags([
    ["help-needed", "y".repeat(900)],
    ["help-size", "enormous"],
    ["update-part", "done", "z".repeat(5000)],
  ]);
  assert.equal(foreign.help.size, "small");
  assert.equal(foreign.help.text.length, UPDATE_LIMITS.help);
  assert.equal(foreign.done.length, UPDATE_LIMITS.part);
});

test("an update with none of these tags has no parts", () => {
  assert.equal(partsFromTags([["a", "37001:x:y"]]), null);
});

test("days since counts whole days and never goes negative", () => {
  assert.equal(daysSince(NOW - 2 * DAY - 100, NOW), 2);
  assert.equal(daysSince(NOW - DAY + 1, NOW), 0);
  assert.equal(daysSince(NOW + 500, NOW), 0);
});

test("everyone reads how fresh the news is", () => {
  assert.equal(freshnessLine(null, NOW), "No updates yet");
  assert.equal(freshnessLine(NOW - 60, NOW), "Updated today");
  assert.equal(freshnessLine(NOW - DAY, NOW), "Updated yesterday");
  assert.equal(freshnessLine(NOW - 2 * DAY, NOW), "Updated 2 days ago");
  assert.equal(freshnessLine(NOW - 6 * DAY, NOW), "Updated 6 days ago");
  assert.equal(freshnessLine(NOW - 9 * DAY, NOW), "No update in 9 days");
  assert.equal(freshnessLine(NOW - 36 * DAY, NOW), "No update in 5 weeks");
});

test("the founder is prompted after a week, and told when the next one is due before that", () => {
  assert.deepEqual(founderNudge(NOW - 9 * DAY, NOW), {
    due: true,
    text: "It's been 9 days since your last update.",
  });
  assert.deepEqual(founderNudge(NOW - 7 * DAY, NOW).due, true);
  assert.deepEqual(founderNudge(NOW - DAY, NOW), {
    due: false,
    text: "Next update due in 6 days.",
  });
  assert.deepEqual(founderNudge(NOW - 6 * DAY - 10, NOW), {
    due: false,
    text: "Next update due in 1 day.",
  });
  assert.equal(founderNudge(NOW, NOW).text, "Next update due in 7 days.");
  assert.equal(founderNudge(null, NOW).due, true);
});

test("weeks in a row count Monday-to-Sunday weeks back from this one", () => {
  // This week (Wed), last week, the week before: three in a row.
  const three = [NOW - DAY, NOW - 8 * DAY, NOW - 15 * DAY];
  assert.equal(weeksInARow(three, NOW), 3);
  // Two updates in the same week are one week.
  assert.equal(weeksInARow([NOW - DAY, NOW - 2 * DAY], NOW), 1);
  // Monday of one week and Sunday of the next are 13 days apart and still two weeks in a row.
  const monday = Date.UTC(2023, 11, 18, 1) / 1000;
  const sunday = Date.UTC(2023, 11, 31, 23) / 1000;
  assert.equal(weeksInARow([monday, sunday], NOW), 2);
});

test("a week that has only begun does not break the run, a missed week does", () => {
  // Nothing yet this week; last week and the one before have updates.
  assert.equal(weeksInARow([NOW - 5 * DAY, NOW - 12 * DAY], NOW), 2);
  // Nothing this week or last: the run is over, however long it was.
  assert.equal(
    weeksInARow([NOW - 12 * DAY, NOW - 19 * DAY, NOW - 26 * DAY], NOW),
    0,
  );
  // A gap further back ends the count there.
  assert.equal(weeksInARow([NOW - DAY, NOW - 8 * DAY, NOW - 22 * DAY], NOW), 2);
  assert.equal(weeksInARow([], NOW), 0);
  // An update dated in the future is not counted.
  assert.equal(weeksInARow([NOW + 30 * DAY], NOW), 0);
});

test("the count is shown only from two", () => {
  assert.equal(inARowLine(0), null);
  assert.equal(inARowLine(1), null);
  assert.equal(inARowLine(2), "2 weekly updates in a row");
  assert.equal(inARowLine(7), "7 weekly updates in a row");
});

test("a dismissed prompt stays away for the week and then comes back", () => {
  assert.equal(nudgeDismissed(null, NOW), false);
  assert.equal(nudgeDismissed(NOW - DAY, NOW), true);
  assert.equal(nudgeDismissed(NOW - 7 * DAY, NOW), false);
  // A clock set back: a dismissal "in the future" hides nothing.
  assert.equal(nudgeDismissed(NOW + DAY, NOW), false);
});
