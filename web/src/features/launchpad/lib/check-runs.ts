/**
 * Check-run records, read on the reviewer's side.
 *
 * A `buzz launchpad work-checks` run signs a bounded execution record beside a
 * claim (kind 47010): the run, the claim id and mandate it names, the evidence
 * hash it ran against, the checks it executed, its claimed summary, a sandbox
 * report and declared limitations. This module does four things, in order:
 *
 * - **verifies before attributing.** `parseVerifiedCheckRun` checks the
 *   event's id hash and signature first (`verifySignedEvent` from
 *   `lib/score-root-policy.ts` — the same single signature gate the read
 *   surface uses, never a second private verifier), and only then is the
 *   `author` field read at all: the signature proves the publisher, and
 *   nothing here implies execution or independence.
 * - **binds a record to exactly what the claim commits to.** A record counts
 *   for a claim only when it names that claim id *and* this claim's mandate
 *   *and* runs against the evidence hash the claim committed to on the
 *   chain. A record from another project or market that happens to carry the
 *   same claim id can never pass for this one's (`checkRunsFor`), and a
 *   wrong-context record is counted out, never shown as the latest result.
 * - **parses strictly and capped.** Malformed never crashes nor invents,
 *   and every text is held to a cap with an explicit cut marker, so a page
 *   holds what it holds and says what it dropped. Nothing is guessed into a
 *   missing field.
 * - **keeps the record's claims from reading as facts.** The claimed summary
 *   is compared with what the checks list adds up to and reported as
 *   matching or not; `passed` beside a nonzero exit is flagged as
 *   self-contradicted and taken out of the passed count; the sandbox report
 *   stays the publisher's report. Supplied descriptions (the evidence
 *   packet), these executed results, and `model` commentary remain three
 *   distinct things an interface shows separately — and nothing here is a
 *   verdict: the reviewer decides.
 *
 * Pure. `check-runs.test.mjs` drives both `parseVerifiedCheckRun` and
 * `checkRunsFor` — the production paths — under `node --test`, with real
 * nostr-signed records: forged signatures, tampered fields, wrong mandate
 * and wrong evidence, oversized content and contradictory summaries.
 */

import type {
  NostrEvent,
  NostrFilter,
} from "../../../shared/lib/nostr-client.ts";
import { KIND_WORK_CHECK_RUN } from "../../../shared/constants/kinds.ts";
import { verifySignedEvent } from "./score-root-policy.ts";

const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The statuses a record may carry for one check: a closed vocabulary. */
const CHECK_STATUSES = ["passed", "failed", "timed-out", "not-run"] as const;
const STATUS_WORDS = {
  passed: "Passed",
  failed: "Failed",
  "timed-out": "Timed out: stopped, result unknown",
  "not-run": "Not run",
};

/**
 * The caps the page holds, per the runner's declared limits: most checks
 * (12), most argv entries (8, 512 bytes each), most artifacts (16), most
 * limitation lines (8, 512 bytes each), most recorded criterion words
 * (2,000), a check's name (64 bytes) and note (280 bytes). The excerpts'
 * cap is the page's own added bound on top of the runner's cut.
 */
export const CHECK_RUN_MAX_CHECKS = 12;
const CHECK_RUN_MAX_ARGV = 8;
export const CHECK_RUN_ARGV_ENTRY_CAP = 512;
export const CHECK_RUN_TEXT_CAP = 16_384;
const CHECK_RUN_NAME_CAP = 64;
const CHECK_RUN_NOTE_CAP = 280;
const CHECK_RUN_MAX_LIMITATIONS = 8;
const CHECK_RUN_LIMITATION_CAP = 512;
const CHECK_RUN_MAX_ARTIFACTS = 16;
const CHECK_RUN_WORDS_CAP = 2_000;

/** How many records one claim's read brings back, newest first. */
export const CHECK_RUN_QUERY_LIMIT = 50;

/** The marker a cut answer carries, so no cut text reads as whole. */
const CHECK_RUN_CUT_SUFFIX = "…(cut by this page)";

/** A non-empty string, or null. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A `0x…` word, lower-cased, or null. */
function wordValue(value: unknown): string | null {
  const text = str(value);
  return text && WORD_RE.test(text) ? text.toLowerCase() : null;
}

/**
 * Held to `cap` characters; a press marks it cut, so what this page holds is
 * never presented as all there was.
 */
function capped(value: unknown, cap: number): { text: string; cut: boolean } {
  if (typeof value !== "string") return { text: "", cut: false };
  if (value.length <= cap) return { text: value, cut: false };
  return { text: `${value.slice(0, cap)} ${CHECK_RUN_CUT_SUFFIX}`, cut: true };
}

/** One check the page holds out of the record. */
export interface CheckRunCheck {
  name: string;
  argv: string[];
  /** The argv list was longer than the cap: the tail is not on this page. */
  argvCut: boolean;
  /**
   * As the record says: true only when the check itself says auxiliary *and*
   * carries no criterion the claim binds to. The mapping across what the
   * claim commits to is decided in `criterionOf`.
   */
  auxiliary: boolean;
  /** The record's own mapping: source, hash, words. */
  criterion: { source: string; hash: string; words: string | null } | null;
  status: string;
  exitStatus: number | null;
  /** `passed` beside a nonzero exit: the record contradicts itself. */
  selfContradicted: boolean;
  /** The publisher's note, in its own cap. */
  note: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  notRunReason: string | null;
}

export interface CheckRunRecord {
  eventId: string;
  /** The publisher — only meaningful once the event is verified. */
  author: string;
  createdAt: number;
  run: string;
  claimId: string;
  mandate: string;
  evidenceHash: string;
  /** The launch coordinate the record's `a` tag names, if it carried one. */
  launchCoordinate: string | null;
  /** What the record claims about confinement: `enforced`, `unchecked`, or null when it says nothing. */
  sandboxClaim: "enforced" | "unchecked" | null;
  /** The publisher reports this; the page may not call it a fact. */
  sandboxEnforced: boolean;
  /** The claimed counts — checked against the checks, never trusted. */
  summary: {
    passed: number;
    failed: number;
    timedOut: number;
    notRun: number;
    auxiliary: number;
  };
  checks: CheckRunCheck[];
  artifacts: unknown[];
  /** The record's own sentence about what these are not; shown, never edited. */
  notIndependentVerification: string;
  limitations: string[];
  model: { service: string; summary: string; disclosure: string } | null;
  /** Where the record contradicts itself, in plain words. */
  selfContradictions: string[];
  /** The claimed summary matches what the checks list adds up to. */
  summaryConsistent: boolean;
}

/** The event shape a nostr read hands over. */
export type CheckRunEvent = Pick<
  NostrEvent,
  "id" | "pubkey" | "created_at" | "content" | "sig"
> & { kind: number };

/**
 * Parse, with verification first. The event's id and signature being real is
 * the difference between a record's meaning "the publisher says" and
 * nothing: a tampered or unsigned event is refused whole, without ever
 * reading its author as anyone.
 */
export function parseVerifiedCheckRun(
  event: CheckRunEvent & { tags?: readonly string[][] },
): CheckRunRecord | null {
  if (!verifySignedEvent(event)) return null;
  return parseCheckRun(event);
}

/** One raw event worth of check-run, as far as a reviewer's page reads it. Signature is the caller's job (`parseVerifiedCheckRun`). */
function parseCheckRun(event: {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags?: readonly string[][];
}): CheckRunRecord | null {
  if (event.kind !== KIND_WORK_CHECK_RUN) return null;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const run = wordValue(body.run);
  const claim = claimOf(body.claim);
  const evidenceHash = wordValue(body.evidenceHash);
  const checks = checksOf(body.checks);
  const summary = summaryOf(body.summary);
  if (!run || !claim || !evidenceHash || !checks || !summary) return null;

  // The tag a record carries is the binding others and the server see; the
  // content is the same publisher's fuller statement. When the two
  // disagree, the record is shown with the contradiction named out loud —
  // and the chain values decide what it binds to, not a guessed identity.
  const selfContradictions: string[] = [];
  const tagOf = (name: string): string | null => {
    const tag = (event.tags ?? []).find(
      (t) => t[0] === name && typeof t[1] === "string",
    )?.[1];
    return typeof tag === "string" && tag.length > 0 ? tag : null;
  };
  const bind = (claimed: string, tagName: string, word: string): string => {
    const tag = tagOf(tagName);
    if (tag !== null) {
      // The tag is whatever shape the publisher wrote; the binding holds
      // exactly when it names the same value the content names.
      if (tag.toLowerCase() !== claimed) {
        selfContradictions.push(
          `The record's ${word} label does not match its own text. This page goes by the text.`,
        );
      }
    } else {
      selfContradictions.push(`The record has no ${word} label.`);
    }
    return claimed;
  };
  const claimId = bind(claim.id, "claim", "submission ID");
  const mandate = bind(claim.mandate, "mandate", "work area");
  const evidenceHashBound = bind(
    evidenceHash,
    "evidence",
    "evidence fingerprint",
  );

  // The run's sandbox word: what the record says, from the tag the server
  // can see. With no tag at all the record claims nothing certain — said,
  // never inferred either way.
  const sandboxTag = str(tagOf("sandbox"));
  const sandboxClaim: CheckRunRecord["sandboxClaim"] =
    sandboxTag === "enforced"
      ? "enforced"
      : sandboxTag === "unchecked"
        ? "unchecked"
        : null;
  if (sandboxTag === null) {
    selfContradictions.push(
      "The record does not say whether the checks ran in a protected space.",
    );
  }
  if (
    sandboxClaim &&
    sandboxClaim !== (body.sandboxEnforced === true ? "enforced" : "unchecked")
  ) {
    selfContradictions.push(
      "The record contradicts itself about whether the checks ran in a protected space.",
    );
  }

  const artifacts = Array.isArray(body.artifacts)
    ? (body.artifacts as unknown[]).slice(0, CHECK_RUN_MAX_ARTIFACTS)
    : [];

  const limitations: string[] = [];
  if (Array.isArray(body.limitations)) {
    for (const line of body.limitations.slice(0, CHECK_RUN_MAX_LIMITATIONS)) {
      const kept = capped(line, CHECK_RUN_LIMITATION_CAP);
      if (!kept.text) continue;
      limitations.push(kept.cut ? `${kept.text}` : kept.text);
    }
  }

  let model: CheckRunRecord["model"] = null;
  if (
    body.model !== null &&
    typeof body.model === "object" &&
    !Array.isArray(body.model)
  ) {
    const raw = body.model as Record<string, unknown>;
    const service = str(raw.service);
    const summary = str(raw.summary);
    const disclosure = str(raw.disclosure);
    if (service && summary && disclosure) {
      model = {
        service,
        summary: capped(summary, CHECK_RUN_TEXT_CAP).text,
        disclosure: capped(disclosure, CHECK_RUN_LIMITATION_CAP).text,
      };
    }
  }

  return {
    eventId: event.id,
    author: event.pubkey,
    createdAt: event.created_at,
    run,
    claimId,
    mandate,
    evidenceHash: evidenceHashBound,
    launchCoordinate: typeof tagOf("a") === "string" ? tagOf("a") : null,
    // What the publisher claims about confinement, with the record's own
    // field as backup only when the tag says nothing. It is a claim either
    // way — the page never attests it.
    sandboxClaim,
    sandboxEnforced: sandboxClaim === "enforced",
    summary,
    checks,
    artifacts,
    notIndependentVerification: capped(
      body.notIndependentVerification,
      CHECK_RUN_LIMITATION_CAP,
    ).text,
    limitations,
    model,
    selfContradictions,
    summaryConsistent: summaryConsistent(summary, checks),
  };
}

/**
 * @returns {Object|null} The record's claim identity: an id word and a mandate
 * address, both in the chain's shapes, so the page can match them against the
 * claim it renders.
 */
function claimOf(value: unknown): { id: string; mandate: string } | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    !WORD_RE.test(raw.id) ||
    typeof raw.mandate !== "string" ||
    !ADDRESS_RE.test(raw.mandate)
  ) {
    return null;
  }
  return { id: raw.id.toLowerCase(), mandate: raw.mandate.toLowerCase() };
}

function checksOf(value: unknown): CheckRunCheck[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > CHECK_RUN_MAX_CHECKS
  ) {
    return null;
  }
  const out: CheckRunCheck[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const raw = entry as Record<string, unknown>;
    const status = str(raw.status);
    if (
      !status ||
      !CHECK_STATUSES.includes(status as (typeof CHECK_STATUSES)[number])
    ) {
      return null;
    }
    if (!Array.isArray(raw.argv)) return null;
    const argv: string[] = [];
    let argvCut = false;
    for (const arg of raw.argv.slice(0, CHECK_RUN_MAX_ARGV)) {
      const kept = capped(arg, CHECK_RUN_ARGV_ENTRY_CAP);
      if (!kept.text) continue;
      argv.push(kept.text);
      argvCut = argvCut || kept.cut;
    }
    argvCut = argvCut || raw.argv.length > CHECK_RUN_MAX_ARGV;
    if (argv.length === 0 && raw.argv.length > 0) {
      // Every entry was unrepresentable: refuse whole rather than show a
      // check whose command is not on the page.
      return null;
    }
    const name = capped(raw.name, CHECK_RUN_NAME_CAP).text;
    if (!name) return null;
    let criterion: CheckRunCheck["criterion"] = null;
    if (
      raw.criterion !== null &&
      typeof raw.criterion === "object" &&
      !Array.isArray(raw.criterion)
    ) {
      const c = raw.criterion as Record<string, unknown>;
      const source = str(c.source);
      const hash = wordValue(c.hash);
      if (!source || !hash) return null;
      criterion = {
        source,
        hash,
        words: str(capped(c.words, CHECK_RUN_WORDS_CAP).text) ?? null,
      };
    }
    const exitStatus =
      typeof raw.exitStatus === "number" ? raw.exitStatus : null;
    const selfContradicted =
      status === "passed" && exitStatus !== null && exitStatus > 0;
    const stdout = capped(raw.stdout, CHECK_RUN_TEXT_CAP);
    const stderr = capped(raw.stderr, CHECK_RUN_TEXT_CAP);
    const note = str(capped(raw.note, CHECK_RUN_NOTE_CAP).text);
    out.push({
      name,
      argv,
      argvCut,
      auxiliary: raw.auxiliary === true || criterion === null,
      criterion,
      status,
      exitStatus,
      selfContradicted,
      note,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: raw.stdoutTruncated === true || stdout.cut,
      stderrTruncated: raw.stderrTruncated === true || stderr.cut,
      notRunReason: str(raw.notRunReason),
    });
  }
  return out;
}

function summaryOf(value: unknown): CheckRunRecord["summary"] | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const numbers = ["passed", "failed", "timedOut", "notRun", "auxiliary"].map(
    (key) =>
      typeof raw[key] === "number" && Number.isSafeInteger(raw[key])
        ? (raw[key] as number)
        : null,
  );
  if (numbers.some((n) => n === null || n < 0)) return null;
  const [passed, failed, timedOut, notRun, auxiliary] = numbers as number[];
  return { passed, failed, timedOut, notRun, auxiliary };
}

/**
 * What the bounded checks list adds up to, with the record's own `passed`
 * beside a nonzero exit taken out of the passed count entirely (a passed
 * check with a nonzero exit is self-contradiction, not a pass). The
 * claimed summary is checked against this, never the other way round.
 */
export function derivedCounts(checks: readonly CheckRunCheck[]): {
  passed: number;
  failed: number;
  timedOut: number;
  notRun: number;
  auxiliary: number;
  contradicted: number;
} {
  const counts = {
    passed: 0,
    failed: 0,
    timedOut: 0,
    notRun: 0,
    auxiliary: 0,
    contradicted: 0,
  };
  for (const check of checks) {
    if (check.selfContradicted) {
      counts.contradicted += 1;
      continue;
    }
    if (check.auxiliary) counts.auxiliary += 1;
    if (check.status === "passed") counts.passed += 1;
    else if (check.status === "failed") counts.failed += 1;
    else if (check.status === "timed-out") counts.timedOut += 1;
    else counts.notRun += 1;
  }
  return counts;
}

function summaryConsistent(
  summary: CheckRunRecord["summary"],
  checks: readonly CheckRunCheck[],
): boolean {
  const derived = derivedCounts(checks);
  return (
    summary.passed === derived.passed &&
    summary.failed === derived.failed &&
    summary.timedOut === derived.timedOut &&
    summary.notRun === derived.notRun &&
    summary.auxiliary === derived.auxiliary &&
    derived.contradicted === 0
  );
}

/**
 * One claim check runs are bound by, as the single `#c` value a record
 * carries beside its long display tags: `<mandate>:<claim id>:<evidence
 * hash>`, lower-cased, `0x` prefixes retained. One value, because it is the
 * one binding the relay can push narrowly — three tags (`#m`, `#x`) would be
 * accepted by a serde reader of `nostr::Filter` but push no fan-out, so a
 * read limited to N would still starve a busy server's shelf for the kind.
 */
export function checkRunContextTag(context: {
  claimId: string;
  mandate: string;
  evidenceHash: string;
}): string {
  return [
    context.mandate.toLowerCase(),
    context.claimId.toLowerCase(),
    context.evidenceHash.toLowerCase(),
  ].join(":");
}

/**
 * One claim's check-run read, as the server sees it: only the canonical
 * binding tag (one `#c` value, the exact triplet above) and only the
 * check-run kind, before any limit. A multi-letter tag would be dropped by
 * `nostr::Filter`'s reader; an unpushed spelling would starve the read; this
 * asks for exactly what one mandate, one claim and one evidence commit to.
 */
export function checkRunsQueryFilter(context: {
  claimId: string;
  mandate: string;
  evidenceHash: string;
}): NostrFilter {
  return {
    kinds: [KIND_WORK_CHECK_RUN],
    "#c": [checkRunContextTag(context)],
    limit: CHECK_RUN_QUERY_LIMIT,
  };
}

/**
 * The records for one claim, verified first: newest first and only those
 * that name the claim id **and** the mandate it is actually bound in **and**
 * run against the evidence hash the claim committed to. A record naming a
 * different mandate (another project or market with an id collision) is
 * counted in `misattributed`; a record with other evidence in `stale` —
 * never silently dropped, never shown as the latest result. With no known
 * mandate, nothing can be bound: the read is qualified, not matching.
 */
export function checkRunsFor(
  claim: {
    id: string;
    mandate: string | null;
    record: { evidenceHash: string };
  },
  records: readonly CheckRunRecord[],
): { current: CheckRunRecord[]; stale: number; misattributed: number } {
  const claimId = claim.id.toLowerCase();
  const claimMandate = claim.mandate?.toLowerCase() ?? null;
  const evidenceHash = claim.record.evidenceHash.toLowerCase();
  const current: CheckRunRecord[] = [];
  let stale = 0;
  let misattributed = 0;
  for (const record of records) {
    if (record.claimId === claimId) {
      const mandateKnown = claimMandate !== null;
      const mandatesMatch = mandateKnown && record.mandate === claimMandate;
      if (record.evidenceHash === evidenceHash && mandatesMatch) {
        current.push(record);
      } else if (mandateKnown && !mandatesMatch) {
        misattributed += 1;
      } else {
        stale += 1;
      }
    }
  }
  current.sort(
    (a, b) => b.createdAt - a.createdAt || (a.eventId < b.eventId ? -1 : 1),
  );
  return { current, stale, misattributed };
}

/**
 * Whether a check's record mapping holds against the words the claim
 * commits to: `"bound"` only when the check's criterion is a claim-check
 * hash exactly equal to the claim's own check hash — the words the claim
 * actually says it is judged against. Anything else is `"other"` (a hash
 * this claim does not commit to) or `"none"` (no criterion recorded), both
 * shown as extra checks outside the accepted answer.
 */
export function criterionOf(
  check: CheckRunCheck,
  claim: { record: { checkHash: string } },
): "bound" | "other" | "none" {
  if (!check.criterion) return "none";
  const claimHash = claim.record.checkHash.toLowerCase();
  if (!claimHash || claimHash === `0x${"0".repeat(64)}`) return "other";
  return check.criterion.source === "claim-check" &&
    check.criterion.hash === claimHash
    ? "bound"
    : "other";
}

/** The plain words for a record's thrown-away statuses. */
export function statusLabel(status: string): string {
  return status in STATUS_WORDS
    ? STATUS_WORDS[status as keyof typeof STATUS_WORDS]
    : "Unknown";
}
