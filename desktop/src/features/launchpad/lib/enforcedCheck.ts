/**
 * The `x-ao.enforced` verification, desktop parity with web's
 * `lib/enforced-check.ts`: the register in `dao.json`'s extensions is a
 * CLAIM; this module makes it CHECKABLE against live DAO config. A claim
 * contradicted by live config shows as contradicted, loudly — the structural
 * answer to auditability-washing (docs/aos/ao-survey.md §4).
 *
 * Pure here; reads go through the `evm_call` seam in the panel (the
 * `daoGovConfig` pattern).
 */

// proposalThreshold() — majeur's "minimum votes to make proposal" (cast sig).
export const SELECTOR_PROPOSAL_THRESHOLD = "0xb58131b0";
// ragequittable() — majeur's exit-right flag (cast sig).
export const SELECTOR_RAGEQUITTABLE = "0x14a6d7de";
// shares() — the Shares token holding the vote checkpoints (cast sig).
export const SELECTOR_SHARES = "0x03314efa";

/** One register entry (OAv2 §4.3's consequential-events shape). */
export interface EnforcedClause {
  action: string;
  authority?: string;
  checkpoint?: { kind?: string; mechanism?: string; approver?: string };
  onViolation?: string;
}

export type ClauseStatus =
  | "verified"
  | "contradicted"
  | "documented"
  | "unverifiable";

export interface CheckedClause {
  clause: EnforcedClause;
  status: ClauseStatus;
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
 * `verified`.
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

/**
 * The dao.json URL for a relay: same origin, http(s) instead of ws(s)
 * (web's `shared/lib/relay-url.ts` semantics).
 */
export function relayHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}

/** Pull the `x-ao.enforced` register out of a served dao.json. */
export function parseEnforcedRegister(body: unknown): EnforcedClause[] | null {
  const register = (body as { extensions?: Record<string, unknown> })
    ?.extensions?.["x-ao.enforced"];
  return Array.isArray(register) ? (register as EnforcedClause[]) : null;
}
