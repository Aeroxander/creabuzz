import assert from "node:assert/strict";
import test from "node:test";

import {
  CARD_HEIGHT,
  CARD_WIDTH,
  cardAlt,
  cardFact,
  cardFileName,
  cardVariantsFor,
  drawShareCard,
  FORBIDDEN_ON_CARD,
  FOLLOW_FACT,
  STARTED_FACT,
  wrapLines,
} from "./share-card.ts";

const base = {
  name: "Nebula",
  goal: "A metronome anyone can fork.",
  app: "Creaton",
  streak: null,
  kept: null,
  answered: null,
};

test("a project that just started claims nothing", () => {
  assert.equal(cardFact({ ...base, variant: "started" }), STARTED_FACT);
  // Even with a record, the started card says only that it started.
  assert.equal(
    cardFact({ ...base, variant: "started", streak: 5, kept: 4, answered: 4 }),
    STARTED_FACT,
  );
});

test("a kept-promise card states kept of answered, and the streak only from two answered promises", () => {
  assert.equal(
    cardFact({ ...base, variant: "kept", streak: 4, kept: 3, answered: 4 }),
    "3 of 4 promises kept, 4 weeks in a row",
  );
  // One answered promise: no streak line, however long the run of updates.
  assert.equal(
    cardFact({ ...base, variant: "kept", streak: 6, kept: 1, answered: 1 }),
    "1 of 1 promise kept",
  );
  // Two answered promises is enough; a run of one week is not a streak.
  assert.equal(
    cardFact({ ...base, variant: "kept", streak: 2, kept: 2, answered: 2 }),
    "2 of 2 promises kept, 2 weeks in a row",
  );
  assert.equal(
    cardFact({ ...base, variant: "kept", streak: 1, kept: 2, answered: 2 }),
    "2 of 2 promises kept",
  );
});

test("a kept card with nothing answered says only to follow along, not even that it is new", () => {
  assert.equal(cardFact({ ...base, variant: "kept" }), FOLLOW_FACT);
  assert.equal(
    cardFact({ ...base, variant: "kept", streak: 4, kept: 0, answered: 0 }),
    FOLLOW_FACT,
  );
});

test("an accepted-work card names the piece, else counts them, else falls back", () => {
  assert.equal(
    cardFact({ ...base, variant: "accepted", workTitle: "Write the guide" }),
    "Work accepted: Write the guide",
  );
  assert.equal(
    cardFact({ ...base, variant: "accepted", accepted: 1 }),
    "1 piece of work accepted",
  );
  assert.equal(
    cardFact({ ...base, variant: "accepted", accepted: 3 }),
    "3 pieces of work accepted",
  );
  assert.equal(
    cardFact({
      ...base,
      variant: "accepted",
      accepted: 0,
      kept: 2,
      answered: 3,
    }),
    "2 of 3 promises kept",
  );
  assert.equal(cardFact({ ...base, variant: "accepted" }), FOLLOW_FACT);
  const long = cardFact({
    ...base,
    variant: "accepted",
    workTitle: "x".repeat(300),
  });
  assert.ok([...long].length <= "Work accepted: ".length + 80);
  assert.ok(long.endsWith("…"));
});

test("the alt text says the name, the goal and the fact", () => {
  assert.equal(
    cardAlt({ ...base, variant: "kept", kept: 1, answered: 2, streak: 3 }),
    "Nebula on Creaton. Goal: A metronome anyone can fork.. 1 of 2 promises kept, 3 weeks in a row",
  );
});

test("the downloaded file has a plain name", () => {
  assert.equal(
    cardFileName("Nebula Rising!", "Creaton"),
    "nebula-rising-creaton.png",
  );
  assert.equal(cardFileName("日本", ""), "project.png");
});

test("text is wrapped to the width, cut with an ellipsis, and long words are broken", () => {
  const measure = (line) => [...line].length * 10;
  assert.deepEqual(wrapLines("aaa bbb ccc ddd", 70, measure, 3), [
    "aaa bbb",
    "ccc ddd",
  ]);
  const cut = wrapLines("one two three four five six", 70, measure, 2);
  assert.equal(cut.length, 2);
  assert.ok(cut[1].endsWith("…"));
  assert.ok(cut.every((line) => measure(line) <= 70));
  const broken = wrapLines("x".repeat(25), 100, measure, 5);
  assert.deepEqual(broken, ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  assert.deepEqual(wrapLines("", 100, measure, 3), []);
});

/** A canvas context that records what is drawn. */
function recorder() {
  const texts = [];
  const calls = [];
  const ctx = {
    fillStyle: "",
    font: "",
    textBaseline: "alphabetic",
    textAlign: "left",
    measureText: (text) => ({ width: [...text].length * 20 }),
    fillText: (text, x, y) => texts.push({ text, x, y, font: ctx.font }),
    fillRect: (...a) => calls.push(["fillRect", ...a]),
    beginPath: () => calls.push(["beginPath"]),
    moveTo: () => {},
    arcTo: () => {},
    closePath: () => {},
    fill: () => calls.push(["fill"]),
    save: () => {},
    restore: () => {},
    clip: () => calls.push(["clip"]),
    drawImage: (...a) => calls.push(["drawImage", ...a.slice(1)]),
  };
  return { ctx, texts, calls };
}

test("the card is drawn at 1200 by 630 with the name, the goal and one fact line, and no price words", () => {
  assert.equal(CARD_WIDTH, 1200);
  assert.equal(CARD_HEIGHT, 630);
  const { ctx, texts, calls } = recorder();
  drawShareCard(
    ctx,
    { ...base, variant: "kept", streak: 4, kept: 3, answered: 4 },
    null,
  );
  assert.deepEqual(calls[0], ["fillRect", 0, 0, 1200, 630]);
  const words = texts.map((t) => t.text);
  assert.ok(words.includes("Nebula"));
  assert.ok(
    words.includes("N"),
    "the mark is the first letter without a picture",
  );
  assert.ok(words.includes("A metronome anyone can fork."));
  assert.ok(words.includes("3 of 4 promises kept, 4 weeks in a row"));
  assert.ok(words.includes("Creaton · public scorecard"));
  // Nothing drawn is a price, returns or a market value.
  for (const word of words) assert.doesNotMatch(word, FORBIDDEN_ON_CARD);
  // Everything is inside the card.
  for (const t of texts) {
    assert.ok(t.x >= 0 && t.x <= CARD_WIDTH && t.y > 0 && t.y <= CARD_HEIGHT);
  }
});

test("each variant draws its own fact and never a price word, whatever the record holds", () => {
  for (const variant of ["started", "kept", "accepted"]) {
    const { ctx, texts } = recorder();
    drawShareCard(
      ctx,
      {
        ...base,
        variant,
        streak: 9,
        kept: 9,
        answered: 9,
        accepted: 4,
        workTitle: "Ship it",
      },
      null,
    );
    for (const { text } of texts) assert.doesNotMatch(text, FORBIDDEN_ON_CARD);
    assert.equal(texts.filter((t) => t.font.startsWith("700")).length, 1);
  }
});

test("a loaded picture is drawn as the mark; a long goal is cut to three lines", () => {
  const { ctx, texts, calls } = recorder();
  const picture = { tag: "picture" };
  drawShareCard(
    ctx,
    { ...base, variant: "started", goal: "word ".repeat(200) },
    picture,
  );
  assert.ok(calls.some((c) => c[0] === "drawImage" && c[1] === 72));
  assert.ok(!texts.some((t) => t.text === "N"));
  const goalLines = texts.filter((t) => t.font.startsWith("500"));
  assert.equal(goalLines.length, 3);
  assert.ok(goalLines[2].text.endsWith("…"));
});

test("only the pictures the record can back are offered", () => {
  const none = { answered: null, accepted: null, fresh: false };
  assert.deepEqual(cardVariantsFor({ ...none, answered: 3, accepted: 2 }), [
    "kept",
    "accepted",
  ]);
  assert.deepEqual(cardVariantsFor({ ...none, answered: 0, accepted: 2 }), [
    "accepted",
  ]);
  assert.deepEqual(cardVariantsFor({ ...none, answered: 1 }), ["kept"]);
  // "Started" is for a project with nothing posted yet; an older one with nothing answered is not called new.
  assert.deepEqual(cardVariantsFor({ ...none, fresh: true }), ["started"]);
  assert.deepEqual(cardVariantsFor(none), ["kept"]);
  // A fresh flag never hides a record that exists.
  assert.deepEqual(cardVariantsFor({ ...none, answered: 1, fresh: true }), [
    "kept",
  ]);
});
