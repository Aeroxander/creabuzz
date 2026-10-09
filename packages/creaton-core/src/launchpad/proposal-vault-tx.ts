/**
 * Unsigned `ProposalVault` calldata for the backer-directed half of a raise
 * (funding-and-governance-plan.md §4).
 *
 * Same seam as `claim-tx.ts`: bytes the contract will accept, nothing signed.
 * Mirrors `contracts/src/ProposalVault.sol`; selectors keccak-derived and
 * cross-checked with `cast sig` (goldens pinned in `proposal-vault-tx.test.mjs`).
 * All arguments are static words, so the encoding is head words only.
 *
 * Launch wiring:
 * 1. `encodePledge(amount)` -- a backer deposits currency and gets vouchers,
 *    one per unit. Soulbound: there is no transfer function on the contract.
 * 2. `encodeOpenProposal(...)` -- governance opens a proposal with the
 *    milestone check written up front, which can never change afterwards.
 * 3. `encodeBack(proposalId, vouchers)` -- the backer spends vouchers on it.
 *    The tax goes to the treasury, the rest to that proposal's reserve, and
 *    the backer's project tokens are minted at the join price and escrowed in
 *    the vault until the milestone is judged.
 * 4. `encodeVerify` / `encodeFail` -- the outcome. A fail is a refund, never a
 *    slash: `encodeRefundPosition` returns the money and burns the tokens.
 * 5. `encodeClaimTokens` -- a verified milestone's tokens are the backer's.
 * 6. `encodeRefundVouchers` -- unspent vouchers come back at any time. They
 *    carry no votes, ever (docs/token-voting-design.md §3).
 */

// pledge(uint256)
export const SELECTOR_PLEDGE = "0x7326c9c0";
// refundVouchers(uint256)
export const SELECTOR_REFUND_VOUCHERS = "0x4283fa3e";
// openProposal(bytes32,uint256,uint256,uint64,bytes32)
export const SELECTOR_OPEN_PROPOSAL = "0x08842bf9";
// back(bytes32,uint256)
export const SELECTOR_BACK = "0x71459550";
// verify(bytes32)
export const SELECTOR_VERIFY = "0x75e36616";
// fail(bytes32)
export const SELECTOR_FAIL = "0x21d2a07c";
// refundPosition(bytes32)
export const SELECTOR_REFUND_POSITION = "0x9de21cb8";
// claimTokens(bytes32)
export const SELECTOR_CLAIM_TOKENS = "0x6facd1c0";

/** Reads the panel makes. Encoded as `selector + argument` for `eth_call`. */
export const SELECTOR_VOUCHERS = "0x450b9743"; // vouchers(address)
export const SELECTOR_PROPOSALS = "0x32ed5b12"; // proposals(bytes32)
export const SELECTOR_TOKENS_AT_RISK = "0x346b109b"; // tokensAtRisk(address)
export const SELECTOR_BACKING_WEIGHT_AT = "0xa77e5baa"; // backingWeightAt(bytes32,address,uint48)
export const SELECTOR_ESCROWED_OF = "0xb6ae9517"; // escrowedOf(bytes32,address)
export const SELECTOR_TAX_BPS = "0x3eacd2f8"; // taxBps()
export const SELECTOR_MATURATION = "0x25bc6fca"; // maturationBlocks()
export const SELECTOR_PRICING = "0x7ce91411"; // pricing()
export const SELECTOR_JOIN_PRICE = "0xe38b658a"; // joinPrice(address,bytes32)

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

function uintWord(value: bigint | string | number, name: string): string {
  const n =
    typeof value === "bigint"
      ? value
      : BigInt(typeof value === "number" ? Math.trunc(value) : value);
  if (n < 0n || n >= 1n << 256n) {
    throw new Error(`${name} must be a uint256: ${value}`);
  }
  return n.toString(16).padStart(64, "0");
}

/** `pledge(uint256)` -- deposit currency, receive vouchers one per unit. */
export function encodePledge(amount: bigint | string): string {
  return SELECTOR_PLEDGE + uintWord(amount, "amount");
}

/** `refundVouchers(uint256)` -- burn unspent vouchers and take the currency. */
export function encodeRefundVouchers(amount: bigint | string): string {
  return SELECTOR_REFUND_VOUCHERS + uintWord(amount, "amount");
}

/**
 * `openProposal(bytes32,uint256,uint256,uint64,bytes32)` -- governance opens a
 * funding proposal. `checkHash` is the milestone acceptance check (plan G16),
 * written here and never changed afterwards; `deadline` is the block after
 * which nothing more may be committed.
 */
export function encodeOpenProposal(
  proposalIdWord: string,
  minAmount: bigint | string,
  maxAmount: bigint | string,
  deadline: bigint | string,
  checkHashWord: string,
): string {
  return (
    SELECTOR_OPEN_PROPOSAL +
    bytes32Word(proposalIdWord, "proposalIdWord") +
    uintWord(minAmount, "minAmount") +
    uintWord(maxAmount, "maxAmount") +
    uintWord(deadline, "deadline") +
    bytes32Word(checkHashWord, "checkHashWord")
  );
}

/**
 * `back(bytes32,uint256)` -- spend vouchers on a proposal. The tax goes to the
 * treasury, the rest to the proposal's reserve, and the backer's tokens are
 * minted at the join price and escrowed in the vault.
 */
export function encodeBack(
  proposalIdWord: string,
  voucherAmount: bigint | string,
): string {
  return (
    SELECTOR_BACK +
    bytes32Word(proposalIdWord, "proposalIdWord") +
    uintWord(voucherAmount, "voucherAmount")
  );
}

/** `verify(bytes32)` -- the milestone check passed; backers may claim tokens. */
export function encodeVerify(proposalIdWord: string): string {
  return SELECTOR_VERIFY + bytes32Word(proposalIdWord, "proposalIdWord");
}

/** `fail(bytes32)` -- rejected, or expired below its minimum. A refund path. */
export function encodeFail(proposalIdWord: string): string {
  return SELECTOR_FAIL + bytes32Word(proposalIdWord, "proposalIdWord");
}

/** `refundPosition(bytes32)` -- take back a failed proposal's backing. */
export function encodeRefundPosition(proposalIdWord: string): string {
  return (
    SELECTOR_REFUND_POSITION + bytes32Word(proposalIdWord, "proposalIdWord")
  );
}

/** `claimTokens(bytes32)` -- a verified milestone's tokens are the backer's. */
export function encodeClaimTokens(proposalIdWord: string): string {
  return SELECTOR_CLAIM_TOKENS + bytes32Word(proposalIdWord, "proposalIdWord");
}

// ---- reads ----

/** `vouchers(address)` -- a backer's unspent vouchers. */
export function encodeVouchersOf(account: string): string {
  return SELECTOR_VOUCHERS + addressWord(account, "account");
}

/** `proposals(bytes32)` -- a proposal's whole record, as static words. */
export function encodeProposalOf(proposalIdWord: string): string {
  return SELECTOR_PROPOSALS + bytes32Word(proposalIdWord, "proposalIdWord");
}

/** `tokensAtRisk(address)` -- what the exit gate reads. */
export function encodeTokensAtRisk(account: string): string {
  return SELECTOR_TOKENS_AT_RISK + addressWord(account, "account");
}

/** `backingWeightAt(bytes32,address,uint48)` -- the `backing` weight term. */
export function encodeBackingWeightAt(
  proposalIdWord: string,
  account: string,
  atBlock: number,
): string {
  return (
    SELECTOR_BACKING_WEIGHT_AT +
    bytes32Word(proposalIdWord, "proposalIdWord") +
    addressWord(account, "account") +
    uintWord(atBlock, "atBlock")
  );
}

/** `escrowedOf(bytes32,address)` — tokens escrowed for one backer. */
export function encodeEscrowedOf(
  proposalIdWord: string,
  account: string,
): string {
  return (
    SELECTOR_ESCROWED_OF +
    bytes32Word(proposalIdWord, "proposalIdWord") +
    addressWord(account, "account")
  );
}

/** `taxBps()` — the tax on backing, in basis points. */
export function encodeTaxBps(): string {
  return SELECTOR_TAX_BPS;
}

/** `maturationBlocks()` — the window a commitment matures over. */
export function encodeMaturationBlocks(): string {
  return SELECTOR_MATURATION;
}

/** `pricing()` — the join-price source behind the vault. */
export function encodePricing(): string {
  return SELECTOR_PRICING;
}

/** `joinPrice(address,bytes32)` — the price now, and the floor it may not fall under. */
export function encodeJoinPrice(
  account: string,
  proposalIdWord: string,
): string {
  return (
    SELECTOR_JOIN_PRICE +
    addressWord(account, "account") +
    bytes32Word(proposalIdWord, "proposalIdWord")
  );
}
