import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  hasExtras,
  isPlainNumber,
  meetsThreshold,
  readHandInExtras,
  readResults,
  readResultTag,
  RESULT_LIMITS,
  resultTag,
} from "./task-results.ts";

const here = new URL(".", import.meta.url);
const RUST = readFileSync(
  new URL("../../../../../crates/buzz-core/src/task_result.rs", here),
  "utf8",
);
const DOCS = readFileSync(
  new URL("../../../../../docs/agents/WORKER-LOOP.md", here),
  "utf8",
);

const tag = (...parts) => parts;
const result = (name, value, unit = "", baseline = "", n = "", by = "") =>
  tag("task-result", name, value, unit, baseline, n, by);
const R = (name, value, unit = "") => ({
  name,
  value,
  unit,
  baseline: "",
  sampleSize: "",
  producedBy: "",
});

// ---- the bounds are the documented ones ------------------------------------------------------

/** `pub const NAME: usize = 60;` out of the Rust module. */
function rustConst(name) {
  const found = new RegExp(`pub const ${name}: usize = (\\d+);`).exec(RUST);
  assert.ok(found, `${name} is in task_result.rs`);
  return Number(found[1]);
}

test("the web bounds are the bounds fixed in task_result.rs", () => {
  assert.deepEqual(
    {
      results: RESULT_LIMITS.results,
      name: RESULT_LIMITS.name,
      number: RESULT_LIMITS.number,
      unit: RESULT_LIMITS.unit,
      sampleDigits: RESULT_LIMITS.sampleDigits,
      producedBy: RESULT_LIMITS.producedBy,
      logName: RESULT_LIMITS.logName,
    },
    {
      results: rustConst("MAX_RESULTS"),
      name: rustConst("MAX_NAME"),
      number: rustConst("MAX_NUMBER"),
      unit: rustConst("MAX_UNIT"),
      sampleDigits: rustConst("MAX_SAMPLE_DIGITS"),
      producedBy: rustConst("MAX_PRODUCED_BY"),
      logName: rustConst("MAX_LOG_NAME"),
    },
  );
});

test("the web bounds are the ones the agent guide documents, and the tag names match", () => {
  const row = DOCS.split("\n").find((line) => line.startsWith("| `task-result`"));
  assert.ok(row, "the guide documents the task-result tag");
  const claims = {
    results: /at most (\d+) per hand-in/.exec(row),
    name: /`name` 1 to (\d+) characters/.exec(row),
    number: /plain decimals of at most (\d+) characters/.exec(row),
    unit: /`unit` at most (\d+)/.exec(row),
    producedBy: /`produced_by` at most (\d+)/.exec(row),
  };
  for (const [key, found] of Object.entries(claims)) {
    assert.ok(found, `the guide states the ${key} bound`);
    assert.equal(Number(found[1]), RESULT_LIMITS[key], key);
  }
  const log = DOCS.split("\n").find((line) => line.startsWith("| `task-run-log`"));
  assert.equal(
    Number(/name at most (\d+)/.exec(log ?? "")?.[1]),
    RESULT_LIMITS.logName,
  );
  for (const [name, constant] of [
    ["task-result", "TAG_RESULT"],
    ["task-run-log", "TAG_RUN_LOG"],
    ["task-run-record", "TAG_RUN_RECORD"],
  ]) {
    assert.match(RUST, new RegExp(`${constant}: &str = "${name}"`));
    assert.match(DOCS, new RegExp(`\`${name}\``));
  }
  // The six fields, in the order the command line writes them.
  assert.deepEqual(
    resultTag({
      name: "n",
      value: "1",
      unit: "u",
      baseline: "b",
      sampleSize: "5",
      producedBy: "p",
    }),
    ["task-result", "n", "1", "u", "b", "5", "p"],
  );
});

// ---- reading one tag --------------------------------------------------------------------------

test("a result tag is read whole or refused in words", () => {
  const read = readResultTag(
    result("pass_rate", "0.82", "ratio", "0.71", "40", "commit abc123"),
  );
  assert.deepEqual(read, {
    result: {
      name: "pass_rate",
      value: "0.82",
      unit: "ratio",
      baseline: "0.71",
      sampleSize: "40",
      producedBy: "commit abc123",
    },
  });
  const bad = [
    tag("task-result", "x", "1"),
    result("", "1"),
    result(" x", "1"),
    result("x ", "1"),
    result("n".repeat(RESULT_LIMITS.name + 1), "1"),
    result("x\n", "1"),
    result("x", "high"),
    result("x", "1e5"),
    result("x", "1,200"),
    result("x", ".5"),
    result("x", "5."),
    result("x", "9".repeat(RESULT_LIMITS.number + 1)),
    result("x", "1", "u".repeat(RESULT_LIMITS.unit + 1)),
    result("x", "1", " ms"),
    result("x", "1", "", "lots"),
    result("x", "1", "", "", "0"),
    result("x", "1", "", "", "4.5"),
    result("x", "1", "", "", "1".repeat(RESULT_LIMITS.sampleDigits + 1)),
    result("x", "1", "", "", "", "p".repeat(RESULT_LIMITS.producedBy + 1)),
    result("x", "1", "", "", "", "a\tb"),
  ];
  for (const fields of bad)
    assert.ok("problem" in readResultTag(fields), JSON.stringify(fields));
  // The edges that are allowed.
  for (const ok of [
    result("n".repeat(RESULT_LIMITS.name), "-3"),
    result("x", "9".repeat(RESULT_LIMITS.number)),
    result("x", "0.5", "u".repeat(RESULT_LIMITS.unit)),
    result("x", "1", "", "", "007"),
    result("x", "1", "", "", "9".repeat(RESULT_LIMITS.sampleDigits)),
    result("x", "1", "", "", "", "p".repeat(RESULT_LIMITS.producedBy)),
  ])
    assert.ok("result" in readResultTag(ok), JSON.stringify(ok));
  assert.equal(isPlainNumber("-0.5"), true);
  assert.equal(isPlainNumber("0x10"), false);
});

// ---- reading a hand-in's tags -----------------------------------------------------------------

test("a hand-in's extras are read together; one broken bound shows none of them", () => {
  const hash = "a".repeat(64);
  const ok = readHandInExtras([
    ["task-link", "https://example.org"],
    result("pass_rate", "0.82", "", "0.71", "40"),
    result("latency", "120", "ms"),
    tag("task-run-log", hash, "run.log"),
    tag("task-run-record", "b".repeat(64)),
  ]);
  assert.equal(ok.broken, false);
  assert.deepEqual(
    ok.results.map((r) => r.name),
    ["pass_rate", "latency"],
  );
  assert.deepEqual(ok.runLog, { sha256: hash, name: "run.log" });
  assert.equal(ok.runRecord, "b".repeat(64));
  assert.equal(hasExtras(ok), true);
  assert.equal(hasExtras(readHandInExtras([["task-link", "https://x.org"]])), false);

  const many = Array.from({ length: RESULT_LIMITS.results + 1 }, (_, i) =>
    result(`m${i}`, "1"),
  );
  assert.equal(readHandInExtras(many.slice(0, RESULT_LIMITS.results)).broken, false);
  for (const tags of [
    many,
    [result("Score", "1"), result("score", "2")],
    [result("good", "1"), result("bad", "high")],
    [tag("task-run-log", hash, "a.log"), tag("task-run-log", hash, "b.log")],
    [tag("task-run-log", "abc", "run.log")],
    [tag("task-run-log", hash.toUpperCase(), "run.log")],
    [tag("task-run-log", hash, "n".repeat(RESULT_LIMITS.logName + 1))],
    [tag("task-run-record", "b".repeat(64)), tag("task-run-record", hash)],
    [tag("task-run-record", "nope")],
    [result("good", "1"), tag("task-run-record", "nope")],
  ]) {
    const read = readHandInExtras(tags);
    assert.equal(read.broken, true, JSON.stringify(tags));
    assert.deepEqual(read.results, []);
    assert.equal(read.runLog, null);
    assert.equal(read.runRecord, null);
  }
});

// ---- the threshold ----------------------------------------------------------------------------

test("a limit written beside a number's name is held against that number", () => {
  const done = "The pass rate is at least 80% on the held-out set.";
  assert.equal(meetsThreshold(done, [R("pass_rate", "85", "%")]), "yes");
  assert.equal(meetsThreshold(done, [R("pass_rate", "80", "%")]), "yes");
  assert.equal(meetsThreshold(done, [R("pass_rate", "79.9", "%")]), "no");
  const speed = "Median latency under 200 ms.";
  assert.equal(meetsThreshold(speed, [R("median latency", "120", "ms")]), "yes");
  assert.equal(meetsThreshold(speed, [R("Median_Latency", "200", "ms")]), "no");
  assert.equal(meetsThreshold("At most 3 errors in the log", [R("errors", "3")]), "yes");
  assert.equal(meetsThreshold("More than 1,000 users signed up", [R("users", "1200")]), "yes");
  assert.equal(meetsThreshold("Exactly 12 pages", [R("pages", "12", "pages")]), "yes");
  assert.equal(meetsThreshold("Exactly 12 pages", [R("pages", "13", "pages")]), "no");
});

test("when nothing is stated or the units do not fit, it says not stated and never guesses", () => {
  // No number in the words.
  assert.equal(meetsThreshold("It works well on an old phone.", [R("pass_rate", "99", "%")]), "not stated");
  // A percent limit never meets a unit-less number.
  assert.equal(meetsThreshold("Accuracy at least 80%", [R("accuracy", "0.9")]), "not stated");
  // One limit, one number, but another unit.
  assert.equal(meetsThreshold("At least 3 reviewers say yes", [R("latency", "50", "ms")]), "not stated");
  // One limit, one number, no unit on the limit and no name: too loose to call.
  assert.equal(meetsThreshold("Reach at least 3 today", [R("latency", "50", "ms")]), "not stated");
  // Nothing reported.
  assert.equal(meetsThreshold("At least 80% pass rate", []), "not stated");
  // A word that only ends in an operator is not one.
  assert.equal(meetsThreshold("We recover 5 files", [R("files", "5")]), "not stated");
});

test("one limit left without a number keeps a yes from being said; a miss is still a no", () => {
  const done = "The pass rate is at least 80% and latency under 200 ms.";
  assert.equal(meetsThreshold(done, [R("pass rate", "90", "%")]), "not stated");
  assert.equal(
    meetsThreshold(done, [R("pass rate", "90", "%"), R("latency", "150", "ms")]),
    "yes",
  );
  assert.equal(
    meetsThreshold(done, [R("pass rate", "90", "%"), R("latency", "250", "ms")]),
    "no",
  );
  assert.equal(meetsThreshold(done, [R("pass rate", "50", "%")]), "no");
  const reading = readResults(done, [
    R("pass rate", "90", "%"),
    R("latency", "250", "ms"),
  ]);
  assert.deepEqual(
    reading.readings.map((r) => [r.name, r.verdict]),
    [
      ["pass rate", "yes"],
      ["latency", "no"],
    ],
  );
  assert.equal(reading.unmatched, 0);
});
