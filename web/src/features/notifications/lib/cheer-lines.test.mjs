import assert from "node:assert/strict";
import { test } from "node:test";

import { cheerLines } from "./cheer-lines.ts";

const ME = "a".repeat(64);
const P1 = "b".repeat(64);
const P2 = "c".repeat(64);
const P3 = "d".repeat(64);
const NEBULA = `37001:${ME}:nebula`;
const ORBIT = `37001:${ME}:orbit`;
// Wednesday noon local time: today and yesterday are whole calendar days in any time zone.
const NOW = Math.floor(new Date(2026, 10, 18, 12).getTime() / 1000);
const TODAY = Math.floor(new Date(2026, 10, 18, 9).getTime() / 1000);
const YESTERDAY = Math.floor(new Date(2026, 10, 17, 15).getTime() / 1000);
const names = new Map([
  [NEBULA, "Nebula"],
  [ORBIT, "Orbit"],
]);
let n = 0;
const cheer = (by, at, project = NEBULA, over = {}) => {
  n += 1;
  return {
    id: `c${n}`,
    kind: 7,
    pubkey: by,
    content: "+",
    created_at: at,
    tags: [
      ["e", `rec${n}`],
      ["p", ME],
      ["k", "47003"],
      ...(project ? [["a", project]] : []),
    ],
    ...over,
  };
};
const lines = (reactions, extra = {}) =>
  cheerLines({ reactions, me: ME, now: NOW, names, ...extra }).map(
    (l) => l.text,
  );

test("cheers are one line per project and day, counted by person", () => {
  assert.deepEqual(
    lines([
      cheer(P1, TODAY),
      cheer(P2, TODAY + 60),
      cheer(P1, TODAY + 120),
      cheer(P3, TODAY, ORBIT),
      cheer(P1, YESTERDAY),
    ]),
    [
      // Newest first: Nebula's last cheer came after Orbit's.
      "2 people cheered Nebula today.",
      "1 person cheered Orbit today.",
      "1 person cheered Nebula yesterday.",
    ],
  );
});

test("a cheer that names no project, or one with no name known, is about your work", () => {
  assert.deepEqual(lines([cheer(P1, TODAY, null)]), [
    "1 person cheered your work today.",
  ]);
  assert.deepEqual(lines([cheer(P1, TODAY, `37001:${P2}:other`)]), [
    "1 person cheered your work today.",
  ]);
});

test("only up votes on project records, to the reader, from someone else, and nobody the reader muted", () => {
  const down = cheer(P1, TODAY, NEBULA, { content: "-" });
  const note = cheer(P1, TODAY, NEBULA, {
    tags: [
      ["e", "x"],
      ["p", ME],
      ["k", "1"],
      ["a", NEBULA],
    ],
  });
  const toSomeone = cheer(P1, TODAY, NEBULA, {
    tags: [
      ["e", "x"],
      ["p", P2],
      ["k", "47003"],
    ],
  });
  const own = cheer(ME, TODAY);
  const wrongKind = cheer(P1, TODAY, NEBULA, { kind: 6 });
  const muted = cheer(P3, TODAY);
  assert.deepEqual(
    lines([down, note, toSomeone, own, wrongKind, muted], {
      muted: new Set([P3]),
    }),
    [],
  );
});

test("older than yesterday, or dated ahead, is not shown", () => {
  const old = Math.floor(new Date(2026, 10, 16, 12).getTime() / 1000);
  assert.deepEqual(lines([cheer(P1, old), cheer(P2, NOW + 3600)]), []);
});

test("a line never mentions Shares, a price or money", () => {
  const all = lines([cheer(P1, TODAY), cheer(P2, YESTERDAY, null)]).join(" ");
  assert.doesNotMatch(all, /share|price|return|profit|earn|money|pay/i);
});
