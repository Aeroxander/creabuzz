/**
 * The unlock plan: what the project's own allocation releases against.
 *
 * Conviction markets release capital against **attested delivery**, not
 * against time alone (`docs/dao-launchpad-plan.md` §9: "capital flows against
 * attested delivery, not upfront bets"). The wizard offers three shapes and
 * this module is where each becomes an artifact — no new machinery, only the
 * pieces the record and the receipt vocabulary already have:
 *
 * - **Milestone rows** land on the launch record as `unlocks`, keyed by the
 *   `claim` id of the kind:47005 receipt that settles them. The vocabulary is
 *   `lib/milestone-receipt.ts` (`claimReceiptParts` / `verdictReceiptParts`,
 *   tag `claim`, closed word `approve|reject`); the feed already pairs them
 *   into a per-milestone timeline (`lib/trust-signals.ts`,
 *   `aggregateLaunchTrustSignals().timeline`), and the founder's
 *   `record-claim` / `record-verdict` actions in `ManagePanel` are the write
 *   side. So the *tracking* half — "did the verifier approve milestone 2?" —
 *   needs no new event: {@link joinUnlockPlan} is the join.
 * - **Short vesting** is a dated commitment (`months`), and **no vesting** is
 *   the explicit absence of one. Both are record-level, like the existing
 *   performance ladder (`models.ts`'s `vesting`, whose own comment records
 *   that the onchain enforcer is deferred).
 *
 * Enforcement status, stated once and reused in the dialog: the enforcer now
 * EXISTS — `ClaimStake` is currency-agnostic, so a launch that escrows its
 * milestone tranches in the PROJECT TOKEN and submits each row as a claim
 * gets tranche release on the VerifierSet's approval quorum
 * (`contracts/src/ClaimStake.sol`; the join is `tranche-claims.ts` +
 * `claim-tx.ts`). It is opt-in per launch (the NIP-LP section 7.4 enforcer
 * wiring): a launch that has not escrowed its tranches still releases
 * through the treasury acting on the recorded verdict. This module encodes
 * and tracks; it never claims to enforce by itself.
 *
 * Alias-free on purpose: `unlock-plans.test.mjs` drives it under `node --test`.
 */

export type UnlockMode = "milestones" | "time" | "none";

/**
 * Who attests a row. Closed on purpose: the verifier-set picker is a later
 * piece (`docs/next-gen-launchpad-plan.md` Phase C — "Finish the milestone
 * verifier set"), so today the founder is the attestor and the record says so.
 */
export type UnlockVerifier = "founder";

export interface UnlockMilestone {
  /** The kind:47005 `claim` id this row is tracked under. */
  claim: string;
  /** One line the founder wrote, e.g. "Testnet live". */
  label: string;
  /** Share of the milestone allocation, percent. Rows sum to 100. */
  percent: number;
  verifier: UnlockVerifier;
}

export interface UnlockPlan {
  mode: UnlockMode;
  /** Percent of total supply this plan governs (the `milestones` split). */
  allocationPct: number;
  /** `mode: "milestones"` rows, in release order. 2–4 of them. */
  milestones: UnlockMilestone[];
  /** `mode: "time"`: months from close until everything releases. */
  months: number | null;
}

/** The exact wording the dialog prints, so copy and report cannot drift. */
export const UNLOCK_ENFORCEMENT_GAP =
  "Milestone payouts can be enforced onchain: each milestone becomes a claim whose payout is held in escrow and released only when enough verifiers approve it. It is optional per launch; until a milestone is escrowed and claimed, releasing it is a treasury decision recorded on the launch.";

export const MIN_MILESTONES = 2;
export const MAX_MILESTONES = 4;
export const SHORT_VESTING_MONTHS: readonly number[] = [3, 6];

/** `m1…m4` — stable, short, and exactly what `record-claim` asks the founder to type. */
export function milestoneClaimId(index: number): string {
  return `m${index + 1}`;
}

/** Equal splits for `count` rows (4 → 25/25/25/25, 3 → …, remainder on the last). */
export function equalMilestoneSplit(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(100 / count);
  const rows = Array.from({ length: count }, () => base);
  rows[count - 1] += 100 - base * count;
  return rows;
}

export interface MilestoneTemplate {
  key: string;
  label: string;
  /** For which kind of project this reading of "results" is written. */
  kind: "media" | "crypto" | "product";
  milestones: readonly string[];
}

/** One-tap starting points; every row stays editable afterwards. */
export const MILESTONE_TEMPLATES: readonly MilestoneTemplate[] = [
  {
    key: "media",
    label: "Media project",
    kind: "media",
    milestones: ["Pilot shipped", "First episode live", "Season wrapped"],
  },
  {
    key: "crypto",
    label: "Crypto project",
    kind: "crypto",
    milestones: ["Testnet live", "Audit passed", "Mainnet"],
  },
  {
    key: "product",
    label: "Product project",
    kind: "product",
    milestones: ["Beta shipped", "First paying users", "Release 1.0"],
  },
];

/** Build editable rows from a template: equal splits, founder attestor. */
export function milestonesFromTemplate(
  template: MilestoneTemplate,
): UnlockMilestone[] {
  const percents = equalMilestoneSplit(template.milestones.length);
  return template.milestones.map((label, index) => ({
    claim: milestoneClaimId(index),
    label,
    percent: percents[index],
    verifier: "founder" as const,
  }));
}

export interface UnlockIssue {
  severity: "error" | "warning";
  message: string;
}

/** Everything that would make the plan unreadable or unenforceable-in-record. */
export function unlockPlanIssues(plan: UnlockPlan): UnlockIssue[] {
  const issues: UnlockIssue[] = [];
  if (plan.mode === "none") return issues;
  if (plan.mode === "time") {
    if (!SHORT_VESTING_MONTHS.includes(plan.months ?? 0)) {
      issues.push({
        severity: "error",
        message: "Short vesting is 3 or 6 months.",
      });
    }
    return issues;
  }
  const rows = plan.milestones;
  if (rows.length < MIN_MILESTONES || rows.length > MAX_MILESTONES) {
    issues.push({
      severity: "error",
      message: `A milestone plan needs ${MIN_MILESTONES}–${MAX_MILESTONES} rows.`,
    });
  }
  if (rows.some((row) => row.label.trim().length === 0)) {
    issues.push({
      severity: "error",
      message: "Every milestone needs a one-line description.",
    });
  }
  if (new Set(rows.map((row) => row.claim)).size !== rows.length) {
    issues.push({
      severity: "error",
      message: "Milestone claim ids must be unique.",
    });
  }
  const total = rows.reduce((sum, row) => sum + row.percent, 0);
  if (total !== 100) {
    issues.push({
      severity: "error",
      message: `Milestone tranches must add up to 100% of the milestone allocation (they add up to ${total}%).`,
    });
  }
  if (rows.some((row) => row.percent <= 0)) {
    issues.push({
      severity: "error",
      message: "Every milestone releases something.",
    });
  }
  return issues;
}

/** The plan as the record's content field, or null when it says nothing. */
export function encodeUnlockPlan(plan: UnlockPlan): UnlockPlan | null {
  if (unlockPlanIssues(plan).some((issue) => issue.severity === "error")) {
    return null;
  }
  if (plan.mode === "none") {
    return {
      mode: "none",
      allocationPct: plan.allocationPct,
      milestones: [],
      months: null,
    };
  }
  return {
    mode: plan.mode,
    allocationPct: plan.allocationPct,
    milestones: plan.milestones.map((row) => ({ ...row })),
    months: plan.mode === "time" ? plan.months : null,
  };
}

/** Parse a stored `unlocks` field. Malformed plans are refused, not guessed. */
export function parseUnlockPlan(value: unknown): UnlockPlan | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const mode = raw.mode;
  if (mode !== "milestones" && mode !== "time" && mode !== "none") return null;
  const allocationPct =
    typeof raw.allocationPct === "number" && raw.allocationPct >= 0
      ? raw.allocationPct
      : 0;
  const months =
    typeof raw.months === "number" && Number.isInteger(raw.months)
      ? raw.months
      : null;
  const milestones: UnlockMilestone[] = [];
  if (Array.isArray(raw.milestones)) {
    for (const entry of raw.milestones) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const row = entry as Record<string, unknown>;
      if (
        typeof row.claim !== "string" ||
        typeof row.label !== "string" ||
        typeof row.percent !== "number"
      ) {
        return null;
      }
      milestones.push({
        claim: row.claim,
        label: row.label,
        percent: row.percent,
        // The verifier set is not on the record yet (Phase C), so anything a
        // stored plan claims reads back as the founder — no silent widening.
        verifier: "founder",
      });
    }
  }
  const plan: UnlockPlan = { mode, allocationPct, milestones, months };
  return unlockPlanIssues(plan).some((issue) => issue.severity === "error")
    ? null
    : plan;
}

// ---------------------------------------------------------------------------
// Track layer: the plan joined to the receipts the feed already records
// ---------------------------------------------------------------------------

/** The subset of `trust-signals.ts`'s `MilestoneTimelineEntry` this join needs. */
export interface MilestoneTimelineLike {
  claimId: string;
  claim: { evidenceOk: boolean } | null;
  verdicts: ReadonlyArray<{ verdict: "approve" | "reject"; txOk: boolean }>;
  settled: boolean;
}

export type MilestoneStatus =
  | "awaiting-claim"
  | "awaiting-verdict"
  | "approved"
  | "rejected";

export interface MilestoneStatusRow extends UnlockMilestone {
  status: MilestoneStatus;
  /** True when the claim and verdict mirrors name well-formed txs. */
  settled: boolean;
}

export interface UnlockStatus {
  rows: MilestoneStatusRow[];
  /** Percent of the milestone allocation with an approving verdict. */
  approvedPercent: number;
  /** True when every row has an approving verdict. */
  complete: boolean;
}

/**
 * Where each milestone actually stands, from the record's plan and the
 * kind:47005 timeline. A row nobody has claimed yet says exactly that; a plan
 * the feed has never seen is not "unlocked".
 */
export function joinUnlockPlan(
  plan: UnlockPlan | null,
  timeline: readonly MilestoneTimelineLike[],
): UnlockStatus {
  if (plan?.mode !== "milestones") {
    return { rows: [], approvedPercent: 0, complete: false };
  }
  const byClaim = new Map(timeline.map((entry) => [entry.claimId, entry]));
  const rows: MilestoneStatusRow[] = plan.milestones.map((row) => {
    const entry = byClaim.get(row.claim);
    const latest = entry?.verdicts[entry.verdicts.length - 1];
    const status: MilestoneStatus = !entry?.claim
      ? "awaiting-claim"
      : !latest
        ? "awaiting-verdict"
        : latest.verdict === "approve"
          ? "approved"
          : "rejected";
    return { ...row, status, settled: entry?.settled ?? false };
  });
  const approvedPercent = rows
    .filter((row) => row.status === "approved")
    .reduce((sum, row) => sum + row.percent, 0);
  return {
    rows,
    approvedPercent,
    complete: rows.length > 0 && rows.every((row) => row.status === "approved"),
  };
}
