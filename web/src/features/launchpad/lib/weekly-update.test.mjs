import assert from "node:assert/strict";
import test from "node:test";

process.env.TZ = "UTC";

import { UPDATE_DRAFT_LIMITS } from "@creaton/core/launchpad/updateAi.ts";

import {
  daysSince,
  firstSentence,
  founderNudge,
  freshnessLine,
  inARowLine,
  isWeeklyUpdateTags,
  nudgeDismissed,
  oneLineFromTags,
  oneLineOf,
  partsFromTags,
  updateEvent,
  updateFacts,
  updateLayout,
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
  assert.deepEqual(
    updateLayout(event.content.body, partsFromTags(event.tags)),
    { free: "", showParts: true },
  );
});

test("a free-form update writes no part tags and keeps its body whole", () => {
  const event = updateEvent(
    draft({ done: "", next: "", body: "  We moved studios.\n\nMore soon.  " }),
  );
  // No prompts answered: only the mark that says it is a weekly update all the same.
  assert.deepEqual(event.tags, [["update-kind", "weekly"]]);
  assert.equal(isWeeklyUpdateTags(event.tags), true);
  assert.equal(isWeeklyUpdateTags([["a", "x"]]), false);
  assert.equal(event.content.body, "We moved studios.\n\nMore soon.");
  assert.equal(partsFromTags(event.tags), null);
  assert.deepEqual(updateLayout(event.content.body, null), {
    free: "We moved studios.\n\nMore soon.",
    showParts: false,
  });
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
  assert.deepEqual(updateLayout(event.content.body, parts), {
    free: "A quiet week.",
    showParts: true,
  });
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
    text: "Your weekly update is due. The last one was 9 days ago.",
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

test("the founder's prompt says 'due' and never that they have not posted", () => {
  for (const at of [null, NOW - 7 * DAY, NOW - 30 * DAY]) {
    const { text } = founderNudge(at, NOW);
    assert.match(text, /is due\./);
    assert.doesNotMatch(text, /haven't|have not|didn't|since your last/i);
  }
  assert.equal(
    founderNudge(null, NOW).text,
    "Your first update is due. A short one each week keeps the people following you close.",
  );
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

test("an answer of several paragraphs is shown once, under its prompt", () => {
  const event = updateEvent(
    draft({
      done: "Shipped sign-up.\n\nAlso fixed the invite email.\n\n\nAnd a third thing.",
      next: "Rest.\n\nThen invites.",
      help: "A tester.\n\nOn an old phone.",
    }),
  );
  const parts = partsFromTags(event.tags);
  assert.equal(
    parts.done,
    "Shipped sign-up.\n\nAlso fixed the invite email.\n\n\nAnd a third thing.",
  );
  // Nothing of any part is left over to be shown a second time as free words.
  assert.deepEqual(updateLayout(event.content.body, parts), {
    free: "",
    showParts: true,
  });
});

test("free words that begin like a prompt are kept, with or without a help request", () => {
  const body =
    "A slow week.\n\nWhat's next is anyone's guess.\n\nHelp needed? Not this time.";
  const plain = updateEvent(draft({ done: "", next: "", body }));
  assert.deepEqual(
    updateLayout(plain.content.body, partsFromTags(plain.tags)),
    { free: body, showParts: false },
  );
  const asking = updateEvent(
    draft({ done: "", next: "", body, help: "A logo." }),
  );
  assert.deepEqual(
    updateLayout(asking.content.body, partsFromTags(asking.tags)),
    { free: body, showParts: true },
  );
});

test("a body something else wrote is shown whole, and the parts are not laid out beside it", () => {
  const parts = partsFromTags([
    ["update-part", "done", "Shipped."],
    ["help-needed", "A tester."],
  ]);
  assert.deepEqual(updateLayout("Shipped. We need a tester.", parts), {
    free: "Shipped. We need a tester.",
    showParts: false,
  });
});

test("what a cut read cannot settle is not said", () => {
  const all = { recordsComplete: true, postsCut: false, oldestPostAt: null };
  // Everything read: both facts stand, including "never posted".
  assert.deepEqual(updateFacts({ ...all, latestAt: null }), {
    freshness: true,
    inARow: true,
  });
  // More update records than the bound: the newest read is still the newest, but the run cannot be counted, and
  // "never posted" cannot be said of a read that found none and did not reach the end.
  assert.deepEqual(
    updateFacts({ ...all, recordsComplete: false, latestAt: 500 }),
    { freshness: true, inARow: false },
  );
  assert.equal(
    updateFacts({ ...all, recordsComplete: false, latestAt: null }).freshness,
    false,
  );
  // The posts were cut: an update older than the oldest post read may be hidden behind them.
  const cut = { recordsComplete: true, postsCut: true, oldestPostAt: 400 };
  assert.deepEqual(updateFacts({ ...cut, latestAt: 300 }), {
    freshness: false,
    inARow: false,
  });
  assert.equal(updateFacts({ ...cut, latestAt: null }).freshness, false);
  // The newest update known is inside what was read: nothing newer can be hidden.
  assert.deepEqual(updateFacts({ ...cut, latestAt: 450 }), {
    freshness: true,
    inARow: false,
  });
});

test("when the next update is due is a date, and how late once a week has passed", async () => {
  const { updateDueWords } = await import("./weekly-update.ts");
  const D = 86_400;
  // Monday 2026-11-16, midday.
  const T = Date.parse("2026-11-16T12:00:00Z") / 1000;
  const words = (lastAt) => updateDueWords(lastAt, T, "en-US");
  assert.equal(words(null), null);
  // Posted on the 11th: the next is due on the 18th.
  assert.deepEqual(words(T - 5 * D), {
    late: false,
    text: "Next update Wed, Nov 18",
  });
  assert.deepEqual(words(T - 6 * D), {
    late: false,
    text: "Next update tomorrow",
  });
  assert.deepEqual(words(T - 7 * D), {
    late: false,
    text: "Next update today",
  });
  assert.deepEqual(words(T - 10 * D), { late: true, text: "Late by 3 days" });
  assert.equal(words(T - 8 * D)?.text, "Late by 1 day");
  // A last update dated ahead of now is a week after that date, never a negative count.
  assert.equal(words(T + 9 * D)?.text, "Next update Wed, Dec 2");
  assert.equal(words(T)?.text, "Next update Mon, Nov 23");
  // The old words are gone.
  for (const lastAt of [T - 5 * D, T - 7 * D, T - 10 * D])
    assert.doesNotMatch(words(lastAt).text, /Update (due|late)/);
});

test("accepted work is offered as the first lines of what happened, without the ones taken off", async () => {
  const { acceptedSince, doneWithAccepted } = await import(
    "./weekly-update.ts"
  );
  const T = 1_800_000_000;
  const task = (id, at) => ({
    id,
    what: `Task  ${id}`,
    accepted: at === null ? null : { confirmedAt: at },
  });
  const tasks = [
    task("a", T - 100),
    task("b", T - 5000),
    task("c", null),
    task("d", T + 999_999),
  ];
  // Since the last update at T-1000: a, and d (dated ahead, counted as now). b is older; c was never accepted.
  assert.deepEqual(
    acceptedSince(tasks, T - 1000, T).map((t) => t.id),
    ["d", "a"],
  );
  // The same record dated ahead is not "new" again once an update was posted at now.
  assert.deepEqual(
    acceptedSince(tasks, T, T).map((t) => t.id),
    [],
  );
  assert.deepEqual(
    acceptedSince(tasks, null, T).map((t) => t.id),
    ["d", "a", "b"],
  );
  const offered = [
    { id: "a", what: "Fix  sign-up" },
    { id: "b", what: "Write docs" },
  ];
  assert.equal(
    doneWithAccepted("We shipped.", offered, new Set(["b"])),
    "Work accepted: Fix sign-up\nWe shipped.",
  );
  assert.equal(doneWithAccepted("", offered, new Set(["a", "b"])), "");
});

test("work only the founder checked is its own line, never worded or mixed as accepted work", async () => {
  const { workSince, doneWithAccepted, workLine, FOUNDER_CHECKED_LINE } =
    await import("./weekly-update.ts");
  const { SELF_CHECKED_LABEL } = await import("./tasks.ts");
  // One constant of words: the line in an update reads exactly as the label on the record.
  assert.equal(FOUNDER_CHECKED_LINE, SELF_CHECKED_LABEL);
  const T = 1_800_000_000;
  const task = (id, at, selfChecked, state = "confirmed") => ({
    id,
    what: `Task  ${id}`,
    state,
    selfChecked,
    accepted: at === null ? null : { confirmedAt: at },
  });
  const tasks = [
    task("a", T - 100, false),
    task("b", T - 200, true),
    task("c", T - 300, true),
    task("old", T - 5000, true),
    // Never confirmed: offered as nothing.
    task("open", null, false, "open"),
  ];
  const offered = workSince(tasks, T - 1000, T);
  assert.deepEqual(
    offered.map((w) => [w.id, w.kind]),
    [
      ["a", "accepted"],
      ["b", "founder"],
      ["c", "founder"],
    ],
  );
  // Both kinds in one update: each under its own words, in the order offered, the founder's own text after.
  assert.equal(
    doneWithAccepted("We shipped.", offered, new Set(["c"])),
    "Work accepted: Task a\nDone, checked by the founder: Task b\nWe shipped.",
  );
  // A founder-checked piece of work is never called accepted, and accepted work is never called checked by the founder.
  for (const w of offered) {
    const text = workLine(w);
    if (w.kind === "founder") assert.doesNotMatch(text, /accepted/i);
    else assert.doesNotMatch(text, /checked by the founder/i);
  }
  // Leaving one kind out leaves the other alone.
  assert.equal(
    doneWithAccepted("", offered, new Set(["a"])),
    "Done, checked by the founder: Task b\nDone, checked by the founder: Task c",
  );
  // Without a kind (older callers) a line reads as accepted work: the safe, unchanged wording.
  assert.equal(
    workLine({ id: "x", what: " Fix  it " }),
    "Work accepted: Fix it",
  );
  // At most five lines are offered, newest first.
  const many = Array.from({ length: 8 }, (_, i) =>
    task(`t${i}`, T - i - 1, i % 2 === 0),
  );
  assert.equal(workSince(many, null, T).length, 5);
});

test("promises that arrive late take the cursor only from a dialog nobody has started on", async () => {
  const { promisesTakeCursor } = await import("./weekly-update.ts");
  const fresh = {
    answers: 2,
    startedAtHelp: false,
    typed: false,
    cursorAtStart: true,
  };
  assert.equal(promisesTakeCursor(fresh), true);
  // Nothing to answer: nothing moves.
  assert.equal(promisesTakeCursor({ ...fresh, answers: 0 }), false);
  // A person already typing, or already somewhere else in the form, is never pulled away.
  assert.equal(promisesTakeCursor({ ...fresh, typed: true }), false);
  assert.equal(promisesTakeCursor({ ...fresh, cursorAtStart: false }), false);
  // A dialog opened at "Ask for help" stays there.
  assert.equal(promisesTakeCursor({ ...fresh, startedAtHelp: true }), false);
});

test("an update with no title is called 'Week of' the Monday of its week", async () => {
  const { defaultUpdateTitle } = await import("./weekly-update.ts");
  const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h);
  // Monday itself, midweek and Sunday are all the same week.
  assert.equal(defaultUpdateTitle(at(2026, 11, 16), "en-US"), "Week of Nov 16");
  assert.equal(defaultUpdateTitle(at(2026, 11, 18), "en-US"), "Week of Nov 16");
  assert.equal(
    defaultUpdateTitle(at(2026, 11, 22, 23), "en-US"),
    "Week of Nov 16",
  );
  // The next Monday starts the next week.
  assert.equal(
    defaultUpdateTitle(at(2026, 11, 23, 0), "en-US"),
    "Week of Nov 23",
  );
  // A week that began in the month before.
  assert.equal(defaultUpdateTitle(at(2026, 12, 2), "en-US"), "Week of Nov 30");
  assert.equal(defaultUpdateTitle(at(2027, 1, 1), "en-US"), "Week of Dec 28");
  // A date, not a count: no number of weeks in it.
  assert.doesNotMatch(
    defaultUpdateTitle(at(2026, 11, 18), "en-US"),
    /#|week \d/i,
  );
});

test("only the first three lines of what's next become promises", async () => {
  const { firstPromises } = await import("./weekly-update.ts");
  assert.deepEqual(firstPromises("one\n\n two \nthree\nfour\nfive"), {
    text: "one\n two \nthree",
    dropped: 2,
  });
  assert.deepEqual(firstPromises("one"), { text: "one", dropped: 0 });
});

test("'In one line' is signed as a part, reads back the same, and the body carries it as a section", () => {
  const event = updateEvent(
    draft({ line: "  Sign-up shipped\n and works.  " }),
  );
  assert.deepEqual(
    event.tags.filter((t) => t[1] === "line"),
    [["update-part", "line", "Sign-up shipped and works."]],
  );
  assert.equal(oneLineFromTags(event.tags), "Sign-up shipped and works.");
  assert.equal(
    event.content.body,
    "In one line\nSign-up shipped and works.\n\nWhat happened this week\nShipped sign-up.\n\nWhat's next\nInvite the first ten people.",
  );
  const parts = partsFromTags(event.tags);
  assert.deepEqual(parts, {
    done: "Shipped sign-up.",
    next: "Invite the first ten people.",
    help: null,
    line: "Sign-up shipped and works.",
  });
  // The page lays the parts out and has nothing of the body left to repeat.
  assert.deepEqual(updateLayout(event.content.body, parts), {
    free: "",
    showParts: true,
  });
});

test("'In one line' is optional: without it no tag is written", () => {
  for (const line of [undefined, "", "   "])
    assert.equal(
      updateEvent(draft({ line })).tags.some((t) => t[1] === "line"),
      false,
    );
});

test("'In one line' is held to its limit, and the limits match the AI draft's", () => {
  assert.equal(UPDATE_LIMITS.line, UPDATE_DRAFT_LIMITS.line);
  assert.equal(UPDATE_LIMITS.part, UPDATE_DRAFT_LIMITS.done);
  assert.equal(UPDATE_LIMITS.help, UPDATE_DRAFT_LIMITS.help);
  const event = updateEvent(draft({ line: "w".repeat(400) }));
  assert.equal(oneLineFromTags(event.tags).length, UPDATE_LIMITS.line);
  // Tags written by something else are cut the same way.
  assert.equal(
    oneLineFromTags([["update-part", "line", "z".repeat(900)]]).length,
    UPDATE_LIMITS.line,
  );
});

test("a record carrying the new part is a weekly update, and one that only looks like it is not", () => {
  assert.equal(
    isWeeklyUpdateTags([["update-part", "line", "A quiet week."]]),
    true,
  );
  // Written freely with a line: the part alone says it is weekly, so no second mark is added.
  const free = updateEvent(
    draft({ done: "", next: "", body: "A quiet week.", line: "Quiet." }),
  );
  assert.deepEqual(free.tags, [["update-part", "line", "Quiet."]]);
  assert.equal(isWeeklyUpdateTags(free.tags), true);
  // A tag of another name, or a part with no kind, does not count.
  assert.equal(isWeeklyUpdateTags([["update-line", "A quiet week."]]), false);
  assert.equal(isWeeklyUpdateTags([["line", "A quiet week."]]), false);
  assert.equal(
    isWeeklyUpdateTags([
      ["a", "37001:x:y"],
      ["help-size", "small"],
    ]),
    false,
  );
  // Its free words stay whole above the line's section.
  const parts = partsFromTags(free.tags);
  assert.deepEqual(parts, { done: "", next: "", help: null, line: "Quiet." });
  assert.deepEqual(updateLayout(free.content.body, parts), {
    free: "A quiet week.",
    showParts: true,
  });
});

test("with no stored line, the first sentence of 'What happened' is the line; a stored line wins", () => {
  const read = (event) =>
    oneLineOf({
      parts: partsFromTags(event.tags),
      body: event.content.body,
    });
  assert.equal(
    read(updateEvent(draft({ line: "Sign-up is live." }))),
    "Sign-up is live.",
  );
  assert.equal(
    read(
      updateEvent(
        draft({
          done: "Work accepted: fix the invite email.\nShipped sign-up. More later.",
        }),
      ),
    ),
    "Work accepted: fix the invite email.",
  );
  // A free-form update: the first sentence of its words, with or without a help request beside them.
  assert.equal(
    read(
      updateEvent(
        draft({ done: "", next: "", body: "We moved studios. More soon." }),
      ),
    ),
    "We moved studios.",
  );
  assert.equal(
    read(
      updateEvent(
        draft({
          done: "",
          next: "",
          body: "A quiet week. Bye.",
          help: "A logo.",
        }),
      ),
    ),
    "A quiet week.",
  );
  // An update from before parts existed: its body.
  assert.equal(
    oneLineOf({ parts: null, body: "Old news. Older news." }),
    "Old news.",
  );
  // The next part and the help are never the line.
  assert.equal(
    read(updateEvent(draft({ done: "", next: "Invite ten people." }))),
    "",
  );
});

test("the first sentence stops at a full stop, not inside a version number, and is cut at a word", () => {
  assert.equal(
    firstSentence("Released v1.2 to testers. Then more."),
    "Released v1.2 to testers.",
  );
  assert.equal(firstSentence("\n\n  Did we ship?  Yes."), "Did we ship?");
  assert.equal(firstSentence("No full stop here"), "No full stop here");
  assert.equal(firstSentence(""), "");
  const long = firstSentence(`${"word ".repeat(80)}end.`);
  assert.ok(long.length <= UPDATE_LIMITS.line);
  assert.ok(long.endsWith("word…"));
});
