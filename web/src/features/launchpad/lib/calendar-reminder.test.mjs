import assert from "node:assert/strict";
import test from "node:test";

import {
  projectPageUrl,
  weeklyReminderFileName,
  weeklyReminderIcs,
} from "./calendar-reminder.ts";

const project = {
  id: "nebula-os",
  name: "Nebula OS",
  url: "https://example.org/launchpad/nebula-os?author=abc",
};
// Wednesday 18 November 2026, 10:30 in the local calendar.
const NOW = new Date(2026, 10, 18, 10, 30, 0);

/** The content lines, unfolded. */
function unfold(ics) {
  return ics.replace(/\r\n /g, "").split("\r\n");
}

test("a weekly event with CRLF line ends, the update day's RRULE and a link to the project", () => {
  const ics = weeklyReminderIcs(project, { weekday: 2, now: NOW });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "every line break is CRLF");
  const lines = unfold(ics);
  assert.ok(lines.includes("RRULE:FREQ=WEEKLY;BYDAY=TU"));
  assert.ok(
    lines.includes("URL:https://example.org/launchpad/nebula-os?author=abc"),
  );
  assert.ok(lines.includes("SUMMARY:Weekly update due: Nebula OS"));
  assert.ok(lines.includes("DTSTART:20261124T090000"));
  assert.ok(lines.includes("DURATION:PT15M"));
  assert.ok(lines.includes("UID:weekly-update-nebula-os@creaton"));
  assert.ok(
    lines.includes(
      "DTSTAMP:" + lines.find((l) => l.startsWith("DTSTAMP:")).slice(8),
    ),
  );
  assert.match(
    lines.find((l) => l.startsWith("DESCRIPTION:")),
    /is due\. Post it here: https:\/\/example\.org\//,
  );
});

test("the first event is the next time the weekday comes round, today included", () => {
  const start = (weekday) =>
    unfold(weeklyReminderIcs(project, { weekday, now: NOW })).find((l) =>
      l.startsWith("DTSTART:"),
    );
  // NOW is a Wednesday (3).
  assert.equal(start(3), "DTSTART:20261118T090000");
  assert.equal(start(4), "DTSTART:20261119T090000");
  assert.equal(start(0), "DTSTART:20261122T090000");
  assert.equal(start(1), "DTSTART:20261123T090000");
  assert.equal(start(2), "DTSTART:20261124T090000");
});

test("each weekday has its own code, and a missing or wrong weekday is Monday", () => {
  const by = (weekday) =>
    unfold(weeklyReminderIcs(project, { weekday, now: NOW })).find((l) =>
      l.startsWith("RRULE:"),
    );
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map(by),
    ["SU", "MO", "TU", "WE", "TH", "FR", "SA"].map(
      (d) => `RRULE:FREQ=WEEKLY;BYDAY=${d}`,
    ),
  );
  for (const bad of [undefined, -1, 7, 1.5, Number.NaN, "2"])
    assert.equal(by(bad), "RRULE:FREQ=WEEKLY;BYDAY=MO");
  assert.match(weeklyReminderIcs(project), /RRULE:FREQ=WEEKLY;BYDAY=MO\r\n/);
});

test("text is escaped, long lines are folded at 75 octets without splitting a character", () => {
  const ics = weeklyReminderIcs(
    {
      id: "x",
      name: "Café; Bar, Inc.\\ one\ntwo " + "é".repeat(80),
      url: project.url,
    },
    { now: NOW },
  );
  for (const physical of ics.split("\r\n"))
    assert.ok(new TextEncoder().encode(physical).length <= 75, physical);
  const summary = unfold(ics).find((l) => l.startsWith("SUMMARY:"));
  assert.ok(
    summary.startsWith(
      "SUMMARY:Weekly update due: Café\\; Bar\\, Inc.\\\\ one\\ntwo ééé",
    ),
  );
  // Folding then unfolding gives back every character.
  assert.ok(summary.endsWith("é".repeat(80)));
});

test("only an http or https link is put in the file", () => {
  for (const url of [
    "javascript:alert(1)",
    "not a url",
    "",
    "file:///etc/passwd",
  ]) {
    const ics = weeklyReminderIcs({ ...project, url }, { now: NOW });
    assert.ok(!/^URL:/m.test(ics), url);
    assert.ok(!ics.includes("Post it here"), url);
  }
  // A project with no name still reads.
  assert.match(
    weeklyReminderIcs({ ...project, name: "  " }, { now: NOW }),
    /SUMMARY:Weekly update due: your project/,
  );
});

test("the same project always gets the same event id, so adding it twice replaces it", () => {
  const uid = (id) =>
    unfold(weeklyReminderIcs({ ...project, id }, { now: NOW })).find((l) =>
      l.startsWith("UID:"),
    );
  assert.equal(uid("nebula-os"), uid("nebula-os"));
  assert.notEqual(uid("nebula-os"), uid("other"));
  assert.equal(
    uid("a b\r\nEND:VEVENT"),
    "UID:weekly-update-a-b--END-VEVENT@creaton",
  );
});

test("the file name is plain letters and dashes", () => {
  assert.equal(weeklyReminderFileName(project), "weekly-update-nebula-os.ics");
  assert.equal(
    weeklyReminderFileName({ name: "Café Ünï / ../x" }),
    "weekly-update-cafe-uni-x.ics",
  );
  assert.equal(
    weeklyReminderFileName({ name: "!!!" }),
    "weekly-update-project.ics",
  );
  assert.ok(weeklyReminderFileName({ name: "a".repeat(200) }).length < 70);
});

test("a project's page address names the project and its founder, and opens the update form", () => {
  assert.equal(
    projectPageUrl("https://example.org", { id: "nebula os", author: "ab12" }),
    "https://example.org/launchpad/nebula%20os?author=ab12&action=update",
  );
});
