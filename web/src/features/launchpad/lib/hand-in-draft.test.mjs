import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKED_LABEL,
  EMPTY_RESULT,
  handInNote,
  handInWordsProblem,
  NOT_MET_LABEL,
  readResultDrafts,
  STEPS_LABEL,
} from "./hand-in-draft.ts";
import { TASK_LIMITS } from "./tasks.ts";

const words = (over = {}) => ({
  did: "Recorded sign-up on Android 9.",
  checked: "",
  notMet: "",
  stepsNeeded: "",
  ...over,
});
const row = (over = {}) => ({ ...EMPTY_RESULT, ...over });

test("the extra lines go into the hand-in's words under their labels, and only the ones that were filled in", () => {
  assert.equal(handInNote(words()), "Recorded sign-up on Android 9.");
  assert.equal(
    handInNote(
      words({
        checked: " Played the recording back. ",
        notMet: "Not tried on Android 8.",
      }),
    ),
    `Recorded sign-up on Android 9.\n\n${CHECKED_LABEL} Played the recording back.\n${NOT_MET_LABEL} Not tried on Android 8.`,
  );
  assert.equal(
    handInNote(
      words({ did: "", stepsNeeded: "Two of five steps were not needed." }),
    ),
    `${STEPS_LABEL} Two of five steps were not needed.`,
  );
});

test("the words together are held to the hand-in's limit, and the problem says by how much", () => {
  assert.equal(handInWordsProblem(words()), null);
  const long = words({
    did: "d".repeat(TASK_LIMITS.note - 20),
    checked: "c".repeat(60),
  });
  const problem = handInWordsProblem(long);
  assert.match(problem, /over the 1000 a hand-in holds/);
  assert.equal(handInNote(long).length > TASK_LIMITS.note, true);
});

test("typed numbers are read for sending; an empty row is skipped, a broken one says why", () => {
  assert.deepEqual(readResultDrafts([row(), row()]), { results: [] });
  assert.deepEqual(
    readResultDrafts([
      row({
        name: " pass rate ",
        value: "0.82",
        unit: "ratio",
        sampleSize: "40",
      }),
      row(),
    ]),
    {
      results: [
        {
          name: "pass rate",
          value: "0.82",
          unit: "ratio",
          baseline: "",
          sampleSize: "40",
          producedBy: "",
        },
      ],
    },
  );
  assert.match(
    readResultDrafts([row({ value: "3" })]).problem,
    /Give each number a name/,
  );
  assert.match(readResultDrafts([row({ name: "x" })]).problem, /plain number/);
  assert.match(
    readResultDrafts([row({ name: "x", value: "1e5" })]).problem,
    /plain number/,
  );
  assert.match(
    readResultDrafts([row({ name: "x", value: "1", sampleSize: "0" })]).problem,
    /sample size/,
  );
  assert.match(
    readResultDrafts([
      row({ name: "A", value: "1" }),
      row({ name: "a", value: "2" }),
    ]).problem,
    /given twice/,
  );
  const eleven = Array.from({ length: 11 }, (_, i) =>
    row({ name: `n${i}`, value: "1" }),
  );
  assert.match(readResultDrafts(eleven).problem, /at most 10/);
});
