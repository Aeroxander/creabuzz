/**
 * The `x-ao.enforced` verification (OA.md/OAv2 Phase 3's third bullet:
 * "verify the enforceable subset against live DAO config, the way S1 already
 * verifies quorum"). The register in `dao.json`'s extensions is a CLAIM;
 * this module makes it CHECKABLE — and a claim contradicted by live config is
 * shown as contradicted, loudly. That is the structural answer to
 * auditability-washing (ao-survey §4).
 *
 * The sharpest case: `ragequittable == false` while the register claims an
 * exit right — a visible lie, not a soft note.
 */

// Extension included on purpose: this module is driven by
// `enforced-check.test.mjs`, which does not resolve extensionless specifiers.
import { ethCall } from "../chain.ts";

// proposalThreshold() — majeur's "minimum votes to make proposal" (cast sig).
export const SELECTOR_PROPOSAL_THRESHOLD = "0xb58131b0";
// ragequittable() — majeur's exit-right flag (cast sig).
export const SELECTOR_RAGEQUITTABLE = "0x14a6d7de";

/** One register entry (OAv2 §4.3's consequential-events shape). */
export interface EnforcedClause {
  action: string;
  authority?: string;
  checkpoint?: { kind?: string; mechanism?: string; approver?: string };
  onViolation?: string;
}

export type ClauseStatus =
  | "verified" // the named mechanism exists in live config and is on
  | "contradicted" // live config says the mechanism is OFF (a visible lie)
  | "documented" // policy checkpoint (e.g. HITL approvals) — named, not chain-readable
  | "unverifiable"; // mechanism unknown to this checker

export interface CheckedClause {
  clause: EnforcedClause;
  status: ClauseStatus;
  /** The plain-language verdict line (the panel renders this verbatim). */
  detail: string;
}

/** Live config readings — each fails independently (null = unknown). */
export interface MechanismState {
  proposalThreshold: bigint | null;
  ragequittable: boolean | null;
}

/**
 * Pure verification: register + live config -> per-clause verdicts. Never
 * green by default — an unreadable mechanism is `unverifiable`, never
 * `verified` (the honesty rule the whole section exists for).
 */
export function verifyEnforced(
  register: readonly EnforcedClause[],
  state: MechanismState,
): CheckedClause[] {
  return register.map((clause) => {
    const mechanism = clause.checkpoint?.mechanism ?? "";
    switch (mechanism) {
      case "proposalThreshold": {
        if (state.proposalThreshold === null) {
          return {
            clause,
            status: "unverifiable",
            detail: `${clause.action}: proposalThreshold unreadable — claim stands unverified`,
          };
        }
        if (state.proposalThreshold > 0n) {
          return {
            clause,
            status: "verified",
            detail: `${clause.action}: backed by proposalThreshold = ${state.proposalThreshold} (live)`,
          };
        }
        return {
          clause,
          status: "contradicted",
          detail: `${clause.action}: claimed, but proposalThreshold = 0 — anyone may propose`,
        };
      }
      case "ragequit": {
        if (state.ragequittable === null) {
          return {
            clause,
            status: "unverifiable",
            detail: `${clause.action}: ragequittable unreadable — claim stands unverified`,
          };
        }
        if (state.ragequittable) {
          return {
            clause,
            status: "verified",
            detail: `${clause.action}: backed by ragequittable = true (live)`,
          };
        }
        // The sharp case: an exit right with the door welded shut.
        return {
          clause,
          status: "contradicted",
          detail: `${clause.action}: claimed, but ragequittable = false — the exit right does not exist`,
        };
      }
      default: {
        if (clause.checkpoint?.kind === "human-approval") {
          return {
            clause,
            status: "documented",
            detail: `${clause.action}: gated by ${clause.checkpoint.approver ?? "human approval"} (documented policy — the approval cards)`,
          };
        }
        return {
          clause,
          status: "unverifiable",
          detail: `${clause.action}: mechanism "${mechanism || "none"}" not checked here`,
        };
      }
    }
  });
}

async function readU256(
  endpoint: string,
  dao: string,
  data: string,
): Promise<bigint | null> {
  try {
    return BigInt(await ethCall(endpoint, dao, data));
  } catch {
    return null;
  }
}

/** Read the two chain-checkable mechanisms (each fails independently). */
export async function fetchMechanismState(
  endpoint: string,
  dao: string,
): Promise<MechanismState> {
  const [threshold, ragequittableWord] = await Promise.all([
    readU256(endpoint, dao, SELECTOR_PROPOSAL_THRESHOLD),
    readU256(endpoint, dao, SELECTOR_RAGEQUITTABLE),
  ]);
  return {
    proposalThreshold: threshold,
    // A bool word: 1 = on, 0 = off, anything else = unreadable.
    ragequittable:
      ragequittableWord === null
        ? null
        : ragequittableWord === 1n
          ? true
          : ragequittableWord === 0n
            ? false
            : null,
  };
}
