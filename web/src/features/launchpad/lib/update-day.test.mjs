import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultUpdateDay,
  dueOnDay,
  dueOnDayWords,
  parseUpdateDays,
  readUpdateDays,
  UPDATE_DAY_KEY,
  updateDayLabel,
  updateDayOf,
  withUpdateDay,
  writeUpdateDay,
} from "./update-day.ts";

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime() / 1000;
// Wednesday 18 November 2026.
const WED = at(2026, 11, 18);

test("the update day starts as the weekday the project started on", () => {
  assert.equal(defaultUpdateDay(at(2026, 11, 17)), 2);
  assert.equal(defaultUpdateDay(at(2026, 11, 15)), 0);
  assert.deepEqual(updateDayOf({}, "a", at(2026, 11, 17)), {
    weekday: 2,
    off: false,
  });
});

test("a chosen day wins, and 'off' stays off without losing the day", () => {
  const chosen = withUpdateDay({}, "a", 5);
  assert.deepEqual(updateDayOf(chosen, "a", at(2026, 11, 17)), {
    weekday: 5,
    off: false,
  });
  const off = withUpdateDay(chosen, "a", "off");
  assert.deepEqual(updateDayOf(off, "a", at(2026, 11, 17)), {
    weekday: 2,
    off: true,
  });
  // Another project is not touched.
  assert.deepEqual(updateDayOf(off, "b", at(2026, 11, 15)), {
    weekday: 0,
    off: false,
  });
  // A choice that is not a weekday is ignored.
  assert.equal(withUpdateDay(chosen, "a", 9), chosen);
  assert.equal(withUpdateDay(chosen, "a", 1.5), chosen);
});

test("due on the day: it comes round, and stays due until an update is posted", () => {
  // Update day Tuesday. Last update the Friday before (Nov 13): on Wednesday the 18th, Tuesday the 17th has passed.
  assert.equal(dueOnDay(2, at(2026, 11, 13), WED), true);
  // Posted on the day itself, or after it: settled for the week.
  assert.equal(dueOnDay(2, at(2026, 11, 17, 8), WED), false);
  assert.equal(dueOnDay(2, at(2026, 11, 18, 9), WED), false);
  // Update day Thursday: last Thursday (the 12th) is the one that counts. Posted Friday the 13th: not due yet.
  assert.equal(dueOnDay(4, at(2026, 11, 13), WED), false);
  // Posted the Wednesday before that: due.
  assert.equal(dueOnDay(4, at(2026, 11, 11), WED), true);
  // Today is the update day, nothing posted today: due.
  assert.equal(dueOnDay(3, at(2026, 11, 14), WED), true);
  assert.equal(dueOnDay(3, at(2026, 11, 18, 11), WED), false);
  // Never posted.
  assert.equal(dueOnDay(2, null, WED), true);
});

test("the words say what is due and never that anything was missed", () => {
  for (let day = 0; day < 7; day += 1) {
    const words = dueOnDayWords(day);
    assert.match(
      words,
      /^Your weekly update is due\. \w+day is your update day\.$/,
    );
    assert.doesNotMatch(words, /haven't|have not|late|missed|forgot/i);
  }
  assert.equal(updateDayLabel({ weekday: 2, off: false }), "Every Tuesday");
  assert.equal(updateDayLabel({ weekday: 2, off: true }), "No reminder");
});

test("what the browser remembers is read carefully and bounded", () => {
  assert.deepEqual(parseUpdateDays(null), {});
  assert.deepEqual(parseUpdateDays("nonsense"), {});
  assert.deepEqual(parseUpdateDays("[1,2]"), {});
  assert.deepEqual(parseUpdateDays('{"a":2,"b":"x","c":9,"d":-1,"e":1.5}'), {
    a: 2,
    d: -1,
  });
  let many = {};
  for (let i = 0; i < 80; i += 1) many = withUpdateDay(many, `p${i}`, 1);
  assert.equal(Object.keys(many).length, 50);
  assert.ok("p79" in many && !("p0" in many));
});

test("saving a choice writes it, and a browser that cannot save says so", () => {
  const data = new Map();
  const storage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
  };
  assert.equal(writeUpdateDay(storage, "a", 4), true);
  assert.equal(writeUpdateDay(storage, "b", "off"), true);
  assert.deepEqual(JSON.parse(data.get(UPDATE_DAY_KEY)), { a: 4, b: -1 });
  assert.deepEqual(readUpdateDays(storage), { a: 4, b: -1 });
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(writeUpdateDay(broken, "a", 4), false);
  assert.deepEqual(readUpdateDays(broken), {});
  assert.equal(writeUpdateDay(null, "a", 4), false);
  assert.deepEqual(readUpdateDays(null), {});
});
