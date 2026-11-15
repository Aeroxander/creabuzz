import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EMPTY_QUICK_START, quickStartProblem } from "./quick-start.ts";

/**
 * One number of answers everywhere. Start asks for a name, a goal and how everyone will know; the one-liner and the kind
 * are optional. The number is counted from the form's own rule (`quickStartProblem`), and every screen, test title and
 * comment in the web app that says how many answers Start takes has to say that number.
 */

const WORDS = ["zero", "one", "two", "three", "four", "five", "six"];
const web = fileURLToPath(new URL("../../../../", import.meta.url));

const FILLED = {
  name: "Nebula",
  pitch: "A first version ten people use",
  goal: "A first version ten people use",
  how: "Ten people sign in during one week",
  category: "software",
  kind: "ai-app",
};

/** The answers Start cannot do without: a draft with everything else filled in is refused when one of them is empty. */
function requiredAnswers() {
  assert.equal(quickStartProblem(FILLED), null);
  return Object.keys(EMPTY_QUICK_START).filter(
    (field) => quickStartProblem({ ...FILLED, [field]: "" }) !== null,
  );
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return /\.(tsx?|mjs)$/.test(name) ? [path] : [];
  });
}

test("Start asks for three answers: the name, the goal and how we will know", () => {
  assert.deepEqual(requiredAnswers(), ["name", "goal", "how"]);
});

test("the screens that count Start's answers say the number the form asks", () => {
  const word = WORDS[requiredAnswers().length];
  const says = (file, pattern) =>
    assert.match(readFileSync(join(web, file), "utf8"), pattern, file);
  const cap = word[0].toUpperCase() + word.slice(1);
  says(
    "src/features/start/ui/QuickStartForm.tsx",
    new RegExp(`${cap} answers make a public project page`),
  );
  says(
    "src/features/feed/ui/NewcomerWelcome.tsx",
    new RegExp(`${cap} answers and it's live\\.`),
  );
  says(
    "src/features/feed/ui/HomeNextStep.tsx",
    new RegExp(`Start one with ${word} answers`),
  );
  says(
    "src/features/portfolio/ui/YourProjects.tsx",
    new RegExp(`with ${word} answers\\.`),
  );
});

test("no line about starting a project names another number of answers", () => {
  const right = WORDS[requiredAnswers().length];
  const others = WORDS.filter((w) => w !== right).join("|");
  const wrong = new RegExp(`\\b(${others}|\\d+) answers\\b`, "i");
  const offenders = [];
  for (const dir of [
    "src/features/start",
    "src/features/feed",
    "src/features/portfolio",
    "tests/e2e",
    "tests/e2e-real",
  ]) {
    for (const path of filesUnder(join(web, dir))) {
      // This file lists every number word, and the real-server loop spec belongs to another change.
      if (path.endsWith("start-answers.test.mjs")) continue;
      if (path.endsWith("e2e-real/project-loop.spec.ts")) continue;
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (wrong.test(line) && /start|project|live/i.test(line))
            offenders.push(`${path.slice(web.length)}:${index + 1}`);
        });
    }
  }
  assert.deepEqual(offenders, []);
});
