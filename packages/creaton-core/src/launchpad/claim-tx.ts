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
 * 1. `encodeSubmitClaim[WithSchedule](...)` -- the claimant stakes their claim.
 * 2. `encodeFund(claimId, amount)` -- the treasury approves the token, then
 *    reserves this one claim's payout. The claim must exist first: `fund`
 *    reverts `UnknownClaim` for a claim that was never submitted.
 * 3. Verifiers `attest`; anyone `settle`s once a quorum is reached.
 * 4. The contributor calls `payout` to withdraw the tranche plus their stake.
 */

// submitClaim(bytes32,uint256,uint256,bytes32)
export const SELECTOR_SUBMIT_CLAIM = "0x26d3f6d4";
// submitClaimWithSchedule(bytes32,uint256,uint256,bytes32,uint32,uint64,uint8,uint128)
export const SELECTOR_SUBMIT_CLAIM_WITH_SCHEDULE = "0x55e9ad90";
// fund(bytes32,uint256)
export const SELECTOR_FUND = "0xe46bbc9e";
// settle(bytes32)
export const SELECTOR_SETTLE = "0x987757dd";
// payout(bytes32)
export const SELECTOR_PAYOUT = "0xcfefb3d5";
// attest(bytes32,bool) on VerifierSet — the verdict half of the join
export const SELECTOR_ATTEST = "0x5747a6b1";

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function bytes32Word(value: string, name: string): string {
  if (!BYTES32_RE.test(value)) {
    throw new Error(`${name} must be 0x + 64 hex: ${JSON.stringify(value)}`);
  }
  return value.slice(2).toLowerCase();
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
 * `fund(bytes32,uint256)` -- the treasury reserves `amount` for ONE claim's
 * payout. Only the treasury may call it, the claim must already be submitted,
 * and the treasury must first `approve` the token to the ClaimStake.
 */
export function encodeFund(
  claimIdWord: string,
  amount: bigint | string,
): string {
  return (
    SELECTOR_FUND +
    bytes32Word(claimIdWord, "claimIdWord") +
    uintWord(amount, "amount")
  );
}

/**
 * `settle(bytes32)` -- anyone may call once the verifiers reach a quorum:
 * approval releases the claim, objection slashes the stake to the treasury.
 */
export function encodeSettle(claimIdWord: string): string {
  return SELECTOR_SETTLE + bytes32Word(claimIdWord, "claimIdWord");
}

/**
 * `payout(bytes32)` -- the contributor withdraws an approved, fully funded
 * claim's tranche plus their stake. One-shot.
 */
export function encodePayout(claimIdWord: string): string {
  return SELECTOR_PAYOUT + bytes32Word(claimIdWord, "claimIdWord");
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
