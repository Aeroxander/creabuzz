/**
 * What a helper reports with a hand-in beside its words: numbers (`task-result`), the fingerprint of a run log
 * (`task-run-log`) and the id of a run record they signed (`task-run-record`).
 *
 * The tag names and every bound are the ones fixed in `crates/buzz-core/src/task_result.rs` and written out in
 * `docs/agents/WORKER-LOOP.md`, which the relay and the command line hold a hand-in to. This reader holds to the same
 * bounds: a hand-in whose tags break any of them shows none of these (`broken`), as the relay would have refused it.
 * `task-results.test.mjs` reads those two files and fails when a bound here drifts from them.
 *
 * Everything here is **reported by the helper**. Nothing in a `task-result` tag was run or checked by anyone else, and
 * the page says so wherever it shows one. "Meets the stated threshold" is this page's own arithmetic on the number
 * the helper reported and the words the team wrote before the work started; it is a reading aid, never a verdict.
 *
 * Pure and alias-free: `task-results.test.mjs` drives it under `node --test`.
 */

export const TAG_RESULT = "task-result";
export const TAG_RUN_LOG = "task-run-log";
export const TAG_RUN_RECORD = "task-run-record";

/** The bounds a hand-in's extra tags are held to. Same names and values as `task_result.rs`. */
export const RESULT_LIMITS = {
  /** `MAX_RESULTS`: most results on one hand-in. */
  results: 10,
  /** `MAX_NAME` characters. */
  name: 60,
  /** `MAX_NUMBER` characters, for a value or a baseline. */
  number: 32,
  /** `MAX_UNIT` characters. */
  unit: 24,
  /** `MAX_SAMPLE_DIGITS` digits. */
  sampleDigits: 12,
  /** `MAX_PRODUCED_BY` characters. */
  producedBy: 200,
  /** `MAX_LOG_NAME` characters. */
  logName: 120,
} as const;

/** One reported result, as a hand-in carries it. Every field is a string; unused ones are empty. */
export interface ReportedResult {
  name: string;
  value: string;
  unit: string;
  baseline: string;
  sampleSize: string;
  producedBy: string;
}

/** The run log's fingerprint and the file's name. The file itself is never uploaded. */
export interface RunLog {
  sha256: string;
  name: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const CONTROL = /\p{Cc}/u;
const chars = (text: string) => [...text].length;

/** Whether `text` is a plain decimal: an optional minus, digits, an optional fraction; no exponent, no marks. */
export function isPlainNumber(text: string): boolean {
  return (
    text.length > 0 &&
    text.length <= RESULT_LIMITS.number &&
    /^-?\d+(\.\d+)?$/.test(text)
  );
}

/**
 * One `task-result` tag (name first) as a result, or the reason in plain words it breaks the bounds.
 * The same rules, in the same order, as `parse_result_tag` in `task_result.rs`.
 */
export function readResultTag(
  fields: readonly string[],
): { result: ReportedResult } | { problem: string } {
  if (fields[0] !== TAG_RESULT || fields.length !== 7)
    return { problem: "A reported number has the wrong shape." };
  const [, name, value, unit, baseline, sample, by] = fields;
  if (
    [name, value, unit, baseline, sample, by].some(
      (field) => typeof field !== "string",
    )
  )
    return { problem: "A reported number has the wrong shape." };
  if (
    name.trim() === "" ||
    name !== name.trim() ||
    chars(name) > RESULT_LIMITS.name ||
    CONTROL.test(name)
  )
    return {
      problem: `A number's name is 1 to ${RESULT_LIMITS.name} characters, with no space at either end.`,
    };
  if (!isPlainNumber(value))
    return {
      problem: `"${name}" needs a plain number as its value, like 0.82 or 1200.`,
    };
  if (
    chars(unit) > RESULT_LIMITS.unit ||
    CONTROL.test(unit) ||
    unit !== unit.trim()
  )
    return {
      problem: `"${name}": the unit is at most ${RESULT_LIMITS.unit} characters.`,
    };
  if (baseline !== "" && !isPlainNumber(baseline))
    return { problem: `"${name}": the baseline is empty or a plain number.` };
  if (
    sample !== "" &&
    (sample.length > RESULT_LIMITS.sampleDigits ||
      !/^\d+$/.test(sample) ||
      Number(sample) === 0)
  )
    return {
      problem: `"${name}": the sample size is empty or a whole number above zero.`,
    };
  if (
    chars(by) > RESULT_LIMITS.producedBy ||
    CONTROL.test(by) ||
    by !== by.trim()
  )
    return {
      problem: `"${name}": what produced it is at most ${RESULT_LIMITS.producedBy} characters.`,
    };
  return {
    result: {
      name,
      value,
      unit,
      baseline,
      sampleSize: sample,
      producedBy: by,
    },
  };
}

/** The tag a hand-in carries for one result, in the order `task_result.rs` writes it. */
export function resultTag(result: ReportedResult): string[] {
  return [
    TAG_RESULT,
    result.name,
    result.value,
    result.unit,
    result.baseline,
    result.sampleSize,
    result.producedBy,
  ];
}

/**
 * What a hand-in's extra tags hold: the results, a run log, a run record's id. `broken` is true when any of them
 * breaks a bound (too many results, a repeated name, a malformed field, a second log or record); nothing is then
 * read from them, because the server would have refused the whole hand-in.
 */
export interface HandInExtras {
  results: ReportedResult[];
  runLog: RunLog | null;
  runRecord: string | null;
  broken: boolean;
}

const NONE: HandInExtras = {
  results: [],
  runLog: null,
  runRecord: null,
  broken: false,
};

/** Check and read every `task-result`, `task-run-log` and `task-run-record` tag of one hand-in (`check_hand_in_tags`). */
export function readHandInExtras(
  tags: readonly (readonly string[])[],
): HandInExtras {
  const results: ReportedResult[] = [];
  const names = new Set<string>();
  let log: RunLog | null = null;
  let logs = 0;
  let record: string | null = null;
  let records = 0;
  const broken: HandInExtras = { ...NONE, broken: true };
  for (const fields of tags) {
    if (fields[0] === TAG_RESULT) {
      if (results.length >= RESULT_LIMITS.results) return broken;
      const read = readResultTag(fields);
      if ("problem" in read) return broken;
      const key = read.result.name.toLowerCase();
      if (names.has(key)) return broken;
      names.add(key);
      results.push(read.result);
    } else if (fields[0] === TAG_RUN_LOG) {
      logs += 1;
      const [, hash = "", name = ""] = fields;
      if (
        logs > 1 ||
        fields.length !== 3 ||
        !HEX64.test(hash) ||
        chars(name) > RESULT_LIMITS.logName ||
        CONTROL.test(name)
      )
        return broken;
      log = { sha256: hash, name };
    } else if (fields[0] === TAG_RUN_RECORD) {
      records += 1;
      const id = fields[1] ?? "";
      if (records > 1 || fields.length !== 2 || !HEX64.test(id)) return broken;
      record = id;
    }
  }
  return { results, runLog: log, runRecord: record, broken: false };
}

/** Whether a hand-in's extras are any: used to leave the block out of a piece that has none. */
export function hasExtras(extras: HandInExtras): boolean {
  return (
    extras.results.length > 0 ||
    extras.runLog !== null ||
    extras.runRecord !== null
  );
}

// ---- "meets the stated threshold" -----------------------------------------------------------

export type ThresholdVerdict = "yes" | "no" | "not stated";

type Op = "ge" | "gt" | "le" | "lt" | "eq";

/** Words and signs that state a limit, longest first so "at least" is read before "at". */
const OPERATORS: readonly (readonly [string, Op])[] = [
  [">=", "ge"],
  ["≥", "ge"],
  ["at least", "ge"],
  ["no less than", "ge"],
  ["not less than", "ge"],
  ["a minimum of", "ge"],
  ["minimum of", "ge"],
  ["<=", "le"],
  ["≤", "le"],
  ["at most", "le"],
  ["no more than", "le"],
  ["not more than", "le"],
  ["a maximum of", "le"],
  ["maximum of", "le"],
  ["up to", "le"],
  ["more than", "gt"],
  ["greater than", "gt"],
  ["higher than", "gt"],
  ["above", "gt"],
  ["over", "gt"],
  ["exceeding", "gt"],
  ["exceeds", "gt"],
  [">", "gt"],
  ["less than", "lt"],
  ["fewer than", "lt"],
  ["lower than", "lt"],
  ["below", "lt"],
  ["under", "lt"],
  ["<", "lt"],
  ["exactly", "eq"],
  ["equal to", "eq"],
  ["==", "eq"],
  ["=", "eq"],
];

/** Words that follow a number without being its unit. */
const FILLER = new Set([
  "on",
  "in",
  "of",
  "for",
  "and",
  "or",
  "with",
  "per",
  "to",
  "the",
  "a",
  "an",
  "when",
  "at",
  "by",
  "from",
  "across",
  "before",
  "after",
  "using",
  "while",
  "if",
  "then",
  "as",
  "is",
  "are",
  "it",
  "that",
  "which",
  "but",
]);

interface Clause {
  op: Op;
  limit: number;
  /** `%`, a lower-case word such as `ms`, or empty when none follows the number. */
  unit: string;
  /** Where the clause starts and ends in the lower-cased words. */
  from: number;
  to: number;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A word operator starts at a word's start ("over 5" but not "recover 5"); a sign may follow anything. */
const operatorPattern = (word: string) =>
  /^[a-z]/.test(word) ? `(?<![a-z])${escape(word)}` : escape(word);
const CLAUSE = new RegExp(
  `(${OPERATORS.map(([word]) => operatorPattern(word)).join("|")})\\s*(-?\\d+(?:\\.\\d+)?)\\s*(%|[a-z]+)?`,
  "g",
);

/** The words the team wrote, lower-cased, with thousands marks removed and `_` and `-` read as spaces. */
function normal(text: string): string {
  let out = text.toLowerCase();
  while (/\d,\d{3}/.test(out)) out = out.replace(/(\d),(\d{3})/g, "$1$2");
  return out.replace(/[_]/g, " ");
}

function clausesOf(text: string): Clause[] {
  const clauses: Clause[] = [];
  for (const match of text.matchAll(CLAUSE)) {
    const op = OPERATORS.find(([word]) => word === match[1])?.[1];
    if (!op || match.index === undefined) continue;
    const word = match[3] ?? "";
    clauses.push({
      op,
      limit: Number(match[2]),
      unit: word === "%" ? "%" : FILLER.has(word) ? "" : word,
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return clauses;
}

const stem = (word: string) => word.replace(/s$/, "");

/** Whether a limit's unit fits the result's: a `%` only meets a `%`; a word must be one of the result's unit words. */
function unitsFit(
  clause: Clause,
  result: { unit: string; name: string },
  named: boolean,
): boolean {
  const unit = result.unit.trim().toLowerCase();
  if (clause.unit === "") return named;
  if (clause.unit === "%") return unit === "%";
  // The word after the number may be the unit, or the name itself ("at most 3 errors" for a result named errors).
  return [unit, normal(result.name)]
    .flatMap((words) => words.split(/[^a-z%]+/))
    .some((word) => word !== "" && stem(word) === stem(clause.unit));
}

function holds(op: Op, value: number, limit: number): boolean {
  switch (op) {
    case "ge":
      return value >= limit;
    case "gt":
      return value > limit;
    case "le":
      return value <= limit;
    case "lt":
      return value < limit;
    default:
      return value === limit;
  }
}

/** How near a clause sits to a result's name in the words: a short gap after it, or just before it. */
function gap(clause: Clause, at: number, end: number): number | null {
  if (at >= clause.from && end <= clause.to) return 0;
  if (clause.from >= end) {
    const after = clause.from - end;
    return after <= 60 ? after : null;
  }
  if (clause.to <= at) {
    const before = at - clause.to;
    return before <= 40 ? before : null;
  }
  return null;
}

export interface ResultReading {
  name: string;
  verdict: ThresholdVerdict;
  /** The limit as the team wrote it, when one was found for this result. */
  stated: string | null;
}

/**
 * Each reported number against the limits the team wrote in "Done means". A limit belongs to a result when it sits
 * near the result's name in those words (`pass rate at least 80%`), or, when the words state one limit and one number
 * was reported, when their units agree. Anything less certain is "not stated": a guess is never shown as a yes.
 */
export function readResults(
  done: string,
  results: readonly ReportedResult[],
): { readings: ResultReading[]; unmatched: number } {
  const words = normal(done);
  const clauses = clausesOf(words);
  const used = new Set<Clause>();
  const readings = results.map((result): ResultReading => {
    const value = Number(result.value);
    const key = normal(result.name).replace(/-/g, " ");
    const at = key === "" ? -1 : words.replace(/-/g, " ").indexOf(key);
    let best: Clause | null = null;
    let named = false;
    if (at >= 0) {
      named = true;
      let nearest = Number.POSITIVE_INFINITY;
      for (const clause of clauses) {
        const away = gap(clause, at, at + key.length);
        if (away !== null && away < nearest) {
          nearest = away;
          best = clause;
        }
      }
    } else if (clauses.length === 1 && results.length === 1) {
      best = clauses[0];
    }
    if (!best || !Number.isFinite(value))
      return { name: result.name, verdict: "not stated", stated: null };
    const fits = unitsFit(best, result, named);
    if (fits === false)
      return { name: result.name, verdict: "not stated", stated: null };
    used.add(best);
    return {
      name: result.name,
      verdict: holds(best.op, value, best.limit) ? "yes" : "no",
      stated: words.slice(best.from, best.to).trim(),
    };
  });
  return { readings, unmatched: clauses.length - used.size };
}

/**
 * The one line: "no" when any reported number misses a limit the team wrote; "yes" only when at least one number was
 * held to a limit, every such number met it and no limit in the words was left without a number; otherwise
 * "not stated". Said as the page's own reading of the helper's numbers.
 */
export function meetsThreshold(
  done: string,
  results: readonly ReportedResult[],
): ThresholdVerdict {
  const { readings, unmatched } = readResults(done, results);
  const read = readings.filter((r) => r.verdict !== "not stated");
  if (read.some((r) => r.verdict === "no")) return "no";
  if (read.length > 0 && unmatched === 0) return "yes";
  return "not stated";
}
