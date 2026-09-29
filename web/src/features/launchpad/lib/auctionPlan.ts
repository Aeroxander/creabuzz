/**
 * Pure founder money-loop logic — PLAN half (effect ports, constants, the
 * parameter gate, the auction config and the factory calls). The deploy state
 * machine and orchestrator live in `auctionFlow.ts`, which re-exports this
 * module so importers keep one entry point. Split only to stay under the web
 * file-size ceiling; the original text follows.
 *
 * Pure founder money-loop logic: DEPLOY THE AUCTION (the launch's `auction`
 * tag stops being a pasted address) and EXECUTE GRADUATION
 * (`GraduationExecutor` moves the money) — plan gaps G1 deploy-side / G3,
 * `docs/next-gen-launchpad-plan.md` §6 Phase A2.
 *
 * No network, clock, or DOM access: every chain effect goes through the
 * injected {@link AuctionEffects} ports (wired to the `evm_*` Tauri IPC
 * commands and chainRpc in `../auctionHooks.ts`), and the visible state is the
 * pure reducers below — so `auctionFlow.test.mjs` binds this exact production
 * seam with `cast`-generated calldata goldens and scripted fakes.
 *
 * Sources of truth (trusted over plan prose):
 * - `contracts/lib/continuous-clearing-auction/src/ContinuousClearingAuctionFactory.sol`
 *   — the deploy path: `create(address token, uint256 amount, bytes
 *   configData, bytes32 salt)` deploys the auction via CREATE2 at
 *   `keccak256(abi.encode(msg.sender, salt))` (:25-46); `getAddress(...,sender)`
 *   (:49-69) precomputes it. `amount > type(uint128).max` reverts
 *   (:29). Factory pinned at `0x000000001F26a0044BaA66024e7b6599c61963F8`
 *   (`contracts/test/LaunchpadFork.t.sol:16`).
 * - `contracts/lib/continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol:16-28`
 *   — `AuctionParameters` field order (the `configData` tuple).
 * - `contracts/lib/continuous-clearing-auction/src/libraries/StepLib.sol:21-25` +
 *   `ConstantsLib.sol:8` — `auctionStepsData` is packed `bytes8` steps
 *   (`uint24 mps` high 3 bytes | `uint40 blockDelta` low 5) whose
 *   `sum(mps * delta) == 1e7` and whose deltas sum to `endBlock - startBlock`.
 * - `contracts/src/GraduationExecutor.sol` — constructor `(address,uint16)`
 *   (:68-73), `executeGraduation(address)` (:77-129, callable by anyone), and
 *   its requirement that the executor BE the auction's `fundsRecipient` AND
 *   `tokensRecipient` at deploy time (:86-91) — so it is deployed BEFORE the
 *   auction and passed as both recipients.
 * - `contracts/src/AuctionLauncher.sol:39-47` — the parameter gate. NOTE:
 *   `registerLaunch` (the params commitment, :39-64) is **OPTIONAL** for this
 *   flow — "The CCA factory remains the deployment path" (:5-9) and nothing on
 *   the deploy path consults `paramsHash`; we enforce its gates in preflight
 *   and defer the onchain registration (no launcher address is pinned in the
 *   record).
 * - `contracts/lib/continuous-clearing-auction/src/ContinuousClearingAuction.sol`
 *   — graduation gating: `lbpInitializationParams()` reverts unless the end
 *   block is checkpointed AND the auction graduated (:134-141);
 *   `isGraduated()` (:161-170); the sweeps are recipient-only, over-only, and
 *   self-checkpoint the end block (:663-700, `ensureEndBlockIsCheckpointed`
 *   :91-95).
 * - `crates/buzz-relay/src/handlers/ingest.rs:2075-2116` — a 47005 receipt
 *   envelope needs exactly one `a` tag and exactly one well-formed `tx` tag;
 *   the `kind` tag vocabulary (`sweep`/`lock`) is unconstrained.
 */

import {
  encodeFunctionData,
  encodeParameters,
  selectorOf,
  ZERO_ADDRESS,
  type AbiType,
} from "./evmCalls.ts";
import { isEvmAddress } from "../models.ts";

// ---------------------------------------------------------------------------
// Effect ports (the Tauri IPC surface + chainRpc reads, injected)
// ---------------------------------------------------------------------------

/** Receipt shape of `evm_send_transaction` (the IPC contract). */
export interface AuctionTxReceipt {
  txHash: string;
  status: "success" | "reverted";
  blockNumber: number;
  gasUsed: string;
  /** Created address — populated only for contract-creation sends. */
  contractAddress: string | null;
}

/** One unsigned send. `to` omitted = contract creation (the IPC contract). */
export interface AuctionSendCall {
  to?: string;
  data: string;
  /** Hex quantity ("0x0" when the call moves no native value). */
  value?: string;
}

/**
 * The chain effects the flows need. A mined `status: "reverted"` is DATA (a
 * failed step), not an exception; a rejected `send` means the outcome is
 * unknown (possibly never broadcast) and is reported as such.
 */
export interface AuctionEffects {
  /** `evm_call` — raw hex return data (reverts reject). */
  call(target: { to: string; data: string }): Promise<string>;
  /** `evm_send_transaction` — resolves once the transaction is mined. */
  send(call: AuctionSendCall): Promise<AuctionTxReceipt>;
  /** True when the address holds code (`chainRpc.isContractDeployed`). */
  codeAt(address: string): Promise<boolean>;
  /** `eth_getTransactionCount` for the signing wallet (CREATE prediction). */
  transactionCount(): Promise<bigint>;
  /** `eth_blockNumber` (graduation readiness: is the auction over?). */
  blockNumber(): Promise<bigint>;
}

/** Human-safe message for a thrown unknown. */
export function auctionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Wei of the sale token that StandardPool locks in the TokenMaster router at
 * mint (StandardPool.sol:127-128), and therefore can never be sold or funded.
 */
export const STANDARD_POOL_ROUTER_LOCK_WEI = 1n;

/** Canonical CCA factory v2.1.0 (LaunchpadFork.t.sol:16). */
export const DEFAULT_CCA_FACTORY = "0x000000001F26a0044BaA66024e7b6599c61963F8";

/** CREATE2 salt for `factory.create` (DeployAppToken.s.sol salt-1 precedent;
 * the factory mixes in `msg.sender`, so identical params from the same wallet
 * intentionally resolve to the same idempotent address). */
export const DEFAULT_AUCTION_SALT = 1n;

/**
 * `GraduationExecutor` reserve share in basis points (4000 = 40% → the
 * TokenMaster floor) — the value `contracts/test/GraduationExecutor.t.sol:82`
 * and `contracts/test/Launchpad.t.sol:192` pin ("40% reserve"; plan §7.2
 * locks the apptoken destination).
 */
export const DEFAULT_RESERVE_BPS = 4000;

/** `ConstantsLib.MPS` — ten-millionths of the sale supply released per block
 * across the whole issuance schedule (`StepStorage` rejects any other sum). */
const MPS = 10_000_000n;

// ---------------------------------------------------------------------------
// View + call signatures (selectors cross-checked with `cast sig`)
// ---------------------------------------------------------------------------

/** `create(address,uint256,bytes,bytes32)` on the CCA factory (`cast` → `0x4aaa5b37`). */
export const SIGNATURE_FACTORY_CREATE = "create(address,uint256,bytes,bytes32)";
/** `getAddress(address,uint256,bytes,bytes32,address)` (`cast` → `0x1bfb751b`). */
export const SIGNATURE_FACTORY_GET_ADDRESS =
  "getAddress(address,uint256,bytes,bytes32,address)";
/** `graduations(address)` on GraduationExecutor (`cast` → `0x62e3857f`). */
export const SIGNATURE_GRADUATIONS = "graduations(address)";
/** `fundsRecipient()` on the auction (`cast` → `0x3b6fd2cf`). */
export const SIGNATURE_FUNDS_RECIPIENT = "fundsRecipient()";
/** `tokensRecipient()` on the auction (`cast` → `0xfd637557`). */
export const SIGNATURE_TOKENS_RECIPIENT = "tokensRecipient()";
/** `lbpInitializationParams()` (`cast` → `0xe1d97d1f`; CCA.sol:17). */
export const SIGNATURE_LBP_INITIALIZATION_PARAMS = "lbpInitializationParams()";

export const SELECTOR_FACTORY_CREATE = selectorOf(SIGNATURE_FACTORY_CREATE);
export const SELECTOR_FACTORY_GET_ADDRESS = selectorOf(
  SIGNATURE_FACTORY_GET_ADDRESS,
);
export const SELECTOR_GRADUATIONS = selectorOf(SIGNATURE_GRADUATIONS);
export const SELECTOR_FUNDS_RECIPIENT = selectorOf(SIGNATURE_FUNDS_RECIPIENT);
export const SELECTOR_TOKENS_RECIPIENT = selectorOf(SIGNATURE_TOKENS_RECIPIENT);
export const SELECTOR_LBP_INITIALIZATION_PARAMS = selectorOf(
  SIGNATURE_LBP_INITIALIZATION_PARAMS,
);

/** `isGraduated()` selector — same pin as `chainRpc.SELECTOR_IS_GRADUATED` (`0x9e5f2602`). */
export const SIGNATURE_IS_GRADUATED = "isGraduated()";
export const SIGNATURE_CURRENCY_RAISED = "currencyRaised()";
export const SELECTOR_IS_GRADUATED = selectorOf(SIGNATURE_IS_GRADUATED);
export const SELECTOR_CURRENCY_RAISED = selectorOf(SIGNATURE_CURRENCY_RAISED);

/** Decode a single 32-byte return word as an address (left-padded, 20 bytes). */
export function addressWordValue(returnData: string): string {
  const word = returnData.replace(/^0x/, "").toLowerCase();
  if (word.length !== 64 || !/^[0-9a-f]*$/.test(word)) {
    throw new Error("expected a 32-byte return word");
  }
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) {
    throw new Error("expected a 32-byte address word");
  }
  return `0x${word.slice(24)}`;
}

/** Split a whole-word hex return into bare 64-char words. */
export function words(returnData: string): string[] {
  const hex = returnData.replace(/^0x/, "").toLowerCase();
  if (hex.length === 0 || hex.length % 64 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error("expected a whole-word hex return");
  }
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += 64) out.push(hex.slice(i, i + 64));
  return out;
}

/** Numeric value of one bare 64-char ABI word. */
export function wordValue(word: string): bigint {
  return BigInt(`0x${word}`);
}

// ---------------------------------------------------------------------------
// Issuance schedule (auctionStepsData)
// ---------------------------------------------------------------------------

function packStep(mps: bigint, blockDelta: bigint): string {
  if (mps <= 0n || mps >= 1n << 24n) {
    throw new Error(`step mps out of uint24 range: ${mps}`);
  }
  if (blockDelta <= 0n || blockDelta >= 1n << 40n) {
    throw new Error(`step block delta out of uint40 range: ${blockDelta}`);
  }
  return (
    mps.toString(16).padStart(6, "0") +
    blockDelta.toString(16).padStart(10, "0")
  );
}

/**
 * The v1 issuance schedule: tokens release uniformly across the sale window,
 * packed exactly as `StepLib.parse` reads it (StepLib.sol:21-25 — `uint24 mps`
 * in the high 3 bytes, `uint40 blockDelta` in the low 5 of each `bytes8`).
 *
 * The launch record has no `steps` field (a schema gap, noted in the flow
 * report) — a uniform schedule is the neutral default: two steps, the first
 * running `mps = floor(1e7 / n)` per block for `n - 1` blocks and the last
 * block releasing the remainder, so `sum(mps * delta) == ConstantsLib.MPS`
 * exactly and `sum(delta) == endBlock - startBlock` (`StepStorage`'s
 * `InvalidStepDataMps` / `InvalidEndBlockGivenStepData` gates).
 */
export function uniformAuctionSteps(
  startBlock: number,
  endBlock: number,
): string {
  const n = endBlock - startBlock;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `sale window must be at least one block: startBlock=${startBlock} endBlock=${endBlock}`,
    );
  }
  if (n === 1) return `0x${packStep(MPS, 1n)}`;
  const mps = MPS / BigInt(n);
  if (mps === 0n) {
    throw new Error(
      `sale window of ${n} blocks is too long for the issuance schedule (mps would be 0)`,
    );
  }
  const lastMps = MPS - mps * BigInt(n - 1);
  return `0x${packStep(mps, BigInt(n - 1))}${packStep(lastMps, 1n)}`;
}

// ---------------------------------------------------------------------------
// Plan inputs -> deploy plan (pure; the AuctionLauncher parameter gate)
// ---------------------------------------------------------------------------

/** The launch record's sale fields (lib/launchRecord.ts + launchpadModels). */
export interface AuctionPlanInputs {
  /** `token` tag — the sale token (must already be deployed). */
  token: string;
  /** `tokenPlan.supply` — whole tokens; the auction sells all of it except the router's 1-wei lock (18 decimals). */
  tokenSupply: string;
  /** `currency` content field; null/"" = native (the zero address). */
  currency: string | null;
  /** `floorPrice` content field — Q96 floor. */
  floorPrice: string;
  /** `tickSpacing` content field. */
  tickSpacing: string;
  /** `requiredRaised` content field — graduation threshold, currency units. */
  requiredRaised: string;
  /** `startBlock` content field. */
  startBlock: number | null;
  /** `endBlock` content field. */
  endBlock: number | null;
  /** `claimBlock` content field. */
  claimBlock: number | null;
  /** `treasury` tag — GraduationExecutor's immutable treasury + hook owner. */
  treasury: string;
  /** `admission` tag — curated deploys the AllowlistHook bid gate. */
  admission: "curated" | "community";
}

/** Everything the deploy runner needs, validated and re-derivable on retry. */
export interface AuctionDeployParams {
  token: string;
  /** Sale inventory in base units (uint128-bounded, factory `create`). */
  amount: bigint;
  /** Resolved currency address (zero address = native). */
  currency: string;
  floorPrice: bigint;
  tickSpacing: bigint;
  requiredRaised: bigint;
  startBlock: number;
  endBlock: number;
  claimBlock: number;
  /** Packed issuance schedule (uniform across the sale window). */
  auctionStepsData: string;
  treasury: string;
  /** Curated track: the AllowlistHook's per-wallet bid cap (uint128). */
  hookPerWalletCap: bigint | null;
}

/** Which preflight check produced a blocking failure. */
export type AuctionPreflightStage = "plan" | "auction-address";

/** A preflight failure that names the exact check that failed. */
export class AuctionPrepareError extends Error {
  readonly stage: AuctionPreflightStage;

  constructor(stage: AuctionPreflightStage, message: string) {
    super(message);
    this.name = "AuctionPrepareError";
    this.stage = stage;
  }
}

function decimalField(value: string, label: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a whole number: ${value}`);
  }
  return BigInt(trimmed);
}

function blockField(value: number | null, label: string): number {
  if (value === null || !Number.isSafeInteger(value)) {
    throw new Error(`${label} is missing from the launch record`);
  }
  return value;
}

/**
 * Map the launch record's sale fields to the factory's `AuctionParameters`,
 * enforcing `AuctionLauncher.registerLaunch`'s parameter gate (AuctionLauncher.sol:39-47)
 * up front so a misconfigured sale blocks before any transaction instead of
 * reverting deep inside the factory. Throws `AuctionPrepareError("plan")`
 * naming the exact field.
 */
export function deriveAuctionDeployParams(
  inputs: AuctionPlanInputs,
): AuctionDeployParams {
  const fail = (message: string): never => {
    throw new AuctionPrepareError("plan", message);
  };
  const orFail = <T>(label: string, fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      return fail(`${label}: ${auctionErrorMessage(error)}`);
    }
  };
  const token = inputs.token.trim();
  if (!isEvmAddress(token))
    fail(`the launch's token address is missing or invalid: ${inputs.token}`);
  const treasury = inputs.treasury.trim();
  if (!isEvmAddress(treasury)) {
    fail(`the launch's treasury is missing or invalid: ${inputs.treasury}`);
  }
  const supply = orFail("token plan supply", () =>
    decimalField(inputs.tokenSupply, "token plan supply"),
  );
  if (supply === 0n) fail("token plan supply must be positive");
  // TokenMaster's StandardPool mints 1 wei of every apptoken to its router as
  // a permanent lock, so the treasury (the deployer) can never hold the whole
  // supply. The CCA's `onTokensReceived()` reverts unless the auction holds at
  // least its `TOTAL_SUPPLY`, so the sale is one wei short of the supply —
  // selling exactly the supply would make every launch unfundable.
  const amount = supply * 10n ** 18n - STANDARD_POOL_ROUTER_LOCK_WEI;
  // Factory gate (ContinuousClearingAuctionFactory.sol:29).
  if (amount > (1n << 128n) - 1n) {
    fail(`sale supply ${supply} exceeds the factory's uint128 inventory cap`);
  }
  const currencyInput = (inputs.currency ?? "").trim();
  const currency =
    currencyInput === ""
      ? ZERO_ADDRESS
      : isEvmAddress(currencyInput)
        ? currencyInput.toLowerCase()
        : fail(`the launch's currency is not an address: ${inputs.currency}`);
  // GraduationExecutor.bindAuction reverts NativeCurrencyUnsupported for a
  // native-currency auction, and this flow's executor is the auction's funds
  // recipient — so a native sale could be deployed and funded (the whole supply
  // moved into it) but never bound, and could never graduate. Refuse it here,
  // before the first transaction, not at the last step.
  if (currency === ZERO_ADDRESS) {
    fail(
      "the sale currency must be an ERC-20 token such as USDC: the graduation executor cannot settle a native-currency (ETH) sale",
    );
  }
  const floorPrice = orFail("floorPrice", () =>
    decimalField(inputs.floorPrice, "floorPrice"),
  );
  // AuctionLauncher.sol:41 — a Q96 price must clear 2^32 to price anything.
  if (floorPrice < (1n << 32n) + 1n) {
    fail(
      `floorPrice must be at least 2^32 + 1 Q96 (AuctionLauncher.BadFloorPrice): ${inputs.floorPrice}`,
    );
  }
  const tickSpacing = orFail("tickSpacing", () =>
    decimalField(inputs.tickSpacing, "tickSpacing"),
  );
  if (tickSpacing < 2n) {
    fail(
      `tickSpacing must be at least 2 (AuctionLauncher.BadTickSpacing): ${inputs.tickSpacing}`,
    );
  }
  const requiredRaised = orFail("requiredRaised", () =>
    decimalField(inputs.requiredRaised, "requiredRaised"),
  );
  if (requiredRaised === 0n) {
    fail("requiredRaised must be positive (AuctionLauncher.BadThreshold)");
  }
  if (requiredRaised > (1n << 128n) - 1n) {
    fail(`requiredRaised exceeds uint128: ${inputs.requiredRaised}`);
  }
  const startBlock = orFail("startBlock", () =>
    blockField(inputs.startBlock, "startBlock"),
  );
  const endBlock = orFail("endBlock", () =>
    blockField(inputs.endBlock, "endBlock"),
  );
  const claimBlock = orFail("claimBlock", () =>
    blockField(inputs.claimBlock, "claimBlock"),
  );
  // AuctionLauncher.sol:44-46 — `BadBlocks`.
  if (startBlock === 0 || endBlock <= startBlock || claimBlock <= endBlock) {
    fail(
      `blocks must satisfy 0 < startBlock < endBlock < claimBlock (AuctionLauncher.BadBlocks): ${startBlock}, ${endBlock}, ${claimBlock}`,
    );
  }
  const auctionStepsData = orFail("issuance schedule", () =>
    uniformAuctionSteps(startBlock, endBlock),
  );
  // v1 gating: AllowlistHook only (curated track). The per-wallet cap defaults
  // to the graduation threshold — no wallet can bid past the whole raise.
  const hookPerWalletCap =
    inputs.admission === "curated" ? requiredRaised : null;
  return {
    token,
    amount,
    currency,
    floorPrice,
    tickSpacing,
    requiredRaised,
    startBlock,
    endBlock,
    claimBlock,
    auctionStepsData,
    treasury,
    hookPerWalletCap,
  };
}

// ---------------------------------------------------------------------------
// Auction config + factory calls
// ---------------------------------------------------------------------------

/**
 * `AuctionParameters` tuple — field order from the vendored upstream
 * interface (`IContinuousClearingAuction.sol:16-28`).
 */
const AUCTION_PARAMETERS_TYPE: AbiType = {
  tuple: [
    "address", // currency
    "address", // tokensRecipient
    "address", // fundsRecipient
    "uint64", // startBlock
    "uint64", // endBlock
    "uint64", // claimBlock
    "uint256", // tickSpacing
    "address", // validationHook
    "uint256", // floorPrice
    "uint128", // requiredCurrencyRaised
    "bytes", // auctionStepsData
  ],
};

/**
 * `configData` for `factory.create` = `abi.encode(AuctionParameters{...})`.
 * Both recipients are the GraduationExecutor — the deploy-time requirement
 * `executeGraduation` later enforces (GraduationExecutor.sol:86-91). The
 * factory only rewrites `address(1)` recipients to the sender
 * (ContinuousClearingAuctionFactory.sol:32-35), so an explicit executor
 * address passes through untouched.
 */
export function encodeAuctionConfigData(input: {
  params: AuctionDeployParams;
  executor: string;
  hook: string | null;
}): string {
  const { params, executor, hook } = input;
  if (!isEvmAddress(executor)) {
    throw new Error(`executor address is invalid: ${executor}`);
  }
  const validationHook = hook ?? ZERO_ADDRESS;
  if (!isEvmAddress(validationHook)) {
    throw new Error(`validation hook address is invalid: ${validationHook}`);
  }
  return encodeParameters(
    [AUCTION_PARAMETERS_TYPE],
    [
      [
        params.currency,
        executor, // tokensRecipient
        executor, // fundsRecipient
        BigInt(params.startBlock),
        BigInt(params.endBlock),
        BigInt(params.claimBlock),
        params.tickSpacing,
        validationHook,
        params.floorPrice,
        params.requiredRaised,
        params.auctionStepsData,
      ],
    ],
  );
}

/** The `factory.getAddress(token, amount, configData, salt, sender)` view
 * (CREATE2 precompute; ContinuousClearingAuctionFactory.sol:49-69). */
export function buildFactoryGetAddressView(input: {
  factory: string;
  params: AuctionDeployParams;
  configData: string;
  salt: bigint;
  sender: string;
}): { to: string; data: string } {
  return {
    to: input.factory,
    data: encodeFunctionData(
      SIGNATURE_FACTORY_GET_ADDRESS,
      ["address", "uint256", "bytes", "bytes32", "address"],
      [
        input.params.token,
        input.params.amount,
        input.configData,
        `0x${input.salt.toString(16).padStart(64, "0")}`,
        input.sender,
      ],
    ),
  };
}

/** The `factory.create(token, amount, configData, salt)` call. */
export function buildFactoryCreateCall(input: {
  factory: string;
  params: AuctionDeployParams;
  configData: string;
  salt: bigint;
}): AuctionSendCall {
  return {
    to: input.factory,
    data: encodeFunctionData(
      SIGNATURE_FACTORY_CREATE,
      ["address", "uint256", "bytes", "bytes32"],
      [
        input.params.token,
        input.params.amount,
        input.configData,
        `0x${input.salt.toString(16).padStart(64, "0")}`,
      ],
    ),
    value: "0x0",
  };
}
