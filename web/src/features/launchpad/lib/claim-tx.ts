/**
 * Unsigned `ClaimStake` calldata for tranche claims (the onchain enforcer
 * `unlock-plans.ts` says was missing).
 *
 * Same seam as `bid-tx.ts`: bytes the contract will accept, nothing signed.
 * Mirrors `contracts/src/ClaimStake.sol`; selectors keccak-derived and
 * cross-checked with `cast sig` (goldens pinned in `claim-tx.test.mjs`).
 * All arguments are static words, so the encoding is head words only.
 *
 * Launch wiring (the escrow is the project token):
 * 1. `encodeFund(treasury, escrowRequired)` -- treasury approves the token
 *    and funds the milestone payouts (from `tranche-claims.ts`).
 * 2. `encodeSubmitClaim[WithSchedule](...)` -- the claimant stakes their claim.
 * 3. Verifiers `attest`; anyone `settle`s at approval quorum -> tranche paid.
 */

// submitClaim(bytes32,uint256,uint256,bytes32)
export const SELECTOR_SUBMIT_CLAIM = "0x26d3f6d4";
// submitClaimWithSchedule(bytes32,uint256,uint256,bytes32,uint32,uint64,uint8,uint128)
export const SELECTOR_SUBMIT_CLAIM_WITH_SCHEDULE = "0x55e9ad90";
// fund(address,uint256)
export const SELECTOR_FUND = "0x7b1837de";
// attest(bytes32,bool) on VerifierSet — the verdict half of the join
export const SELECTOR_ATTEST = "0x5747a6b1";

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function bytes32Word(value: string, name: string): string {
  if (!BYTES32_RE.test(value)) {
    throw new Error(`${name} must be 0x + 64 hex: ${JSON.stringify(value)}`);
  }
  return value.slice(2).toLowerCase();
}

function addressWord(value: string, name: string): string {
  if (!ADDRESS_RE.test(value)) {
    throw new Error(`${name} must be 0x + 40 hex: ${JSON.stringify(value)}`);
  }
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function uintWord(value: bigint | string, name: string): string {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n || n >= 1n << 256n) {
    throw new Error(`${name} must be a uint256: ${value}`);
  }
  return n.toString(16).padStart(64, "0");
}

/**
 * `submitClaim(bytes32,uint256,uint256,bytes32)` -- a plain tranche claim:
 * `amount` is the milestone tranche (project-token units), `stake` is the
 * claimant's skin-in-the-game collateral (0 allowed), `evidenceHashWord` is
 * the kind:47005 receipt's 32-byte evidence hash.
 */
export function encodeSubmitClaim(
  claimIdWord: string,
  amount: bigint | string,
  stake: bigint | string,
  evidenceHashWord: string,
): string {
  return (
    SELECTOR_SUBMIT_CLAIM +
    bytes32Word(claimIdWord, "claimIdWord") +
    uintWord(amount, "amount") +
    uintWord(stake, "stake") +
    bytes32Word(evidenceHashWord, "evidenceHashWord")
  );
}

/**
 * `submitClaimWithSchedule(...)` -- same claim plus the royalty schedule
 * minted at approval quorum (`docs/token-lifecycle-design.md` section 3.1).
 * Band caps (weight/term) are checked in `tranche-claims.ts`; the contract
 * reverts on violations too (`BadSchedule`).
 */
export function encodeSubmitClaimWithSchedule(
  claimIdWord: string,
  amount: bigint | string,
  stake: bigint | string,
  evidenceHashWord: string,
  weight: number,
  term: number,
  band: number,
  allocation: bigint | string,
): string {
  return (
    SELECTOR_SUBMIT_CLAIM_WITH_SCHEDULE +
    bytes32Word(claimIdWord, "claimIdWord") +
    uintWord(amount, "amount") +
    uintWord(stake, "stake") +
    bytes32Word(evidenceHashWord, "evidenceHashWord") +
    uintWord(BigInt(weight), "weight") +
    uintWord(BigInt(term), "term") +
    uintWord(BigInt(band), "band") +
    uintWord(allocation, "allocation")
  );
}

/**
 * `fund(address,uint256)` -- treasury pre-funds the tranche escrow. Callers
 * must `approve` the project token to the ClaimStake first.
 */
export function encodeFund(funder: string, amount: bigint | string): string {
  return (
    SELECTOR_FUND + addressWord(funder, "funder") + uintWord(amount, "amount")
  );
}

/**
 * `attest(bytes32,bool)` on the VerifierSet -- the verdict half of the join:
 * the accepted verifier's approve/objection, which is what `settle` counts to
 * quorum (and what releases the tranche at approval). The caller must be an
 * accepted verifier or the contract reverts (`NotAVerifier`).
 */
export function encodeAttest(claimIdWord: string, approve: boolean): string {
  return (
    SELECTOR_ATTEST +
    bytes32Word(claimIdWord, "claimIdWord") +
    (approve ? "1" : "0").padStart(64, "0")
  );
}
