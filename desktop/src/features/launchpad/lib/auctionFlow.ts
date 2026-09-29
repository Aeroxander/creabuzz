/**
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
  buildBindAuctionCall,
  buildFundAuctionCall,
  buildOnTokensReceivedCall,
  buildSetHookAuctionCall,
  encodeErc20BalanceOf,
  encodeFunctionData,
  encodeParameters,
  selectorOf,
  SELECTOR_BOUND_AUCTION,
  SELECTOR_HOOK_AUCTION,
  ZERO_ADDRESS,
  type AbiType,
} from "@/features/launchpad/lib/evmCalls";
import {
  encodeAllowlistHookDeploy,
  encodeGraduationExecutorDeploy,
  predictCreateAddress,
} from "@/features/launchpad/lib/graduationArtifact";
import { isEvmAddress } from "@/features/launchpad/lib/launchRecord";

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

// ---------------------------------------------------------------------------
// Deploy flow state machine (pure reducer)
// ---------------------------------------------------------------------------

/**
 * The onchain steps in hard order: the GraduationExecutor MUST precede the
 * auction (it is the auction's `fundsRecipient`/`tokensRecipient` at deploy
 * time — GraduationExecutor.sol:77-91). The hook (curated track) deploys first
 * because the auction constructor bakes its address in as `validationHook`.
 *
 * `AuctionLauncher.registerLaunch` is deliberately absent: OPTIONAL (its own
 * contract says the factory remains the deploy path, AuctionLauncher.sol:5-9)
 * and no launcher address is pinned in the record — deferred, reported.
 */
export const AUCTION_DEPLOY_STEPS = [
  {
    id: "hook",
    label: "Bid gate",
    detail: "Deploys the AllowlistHook (curated track only).",
  },
  {
    id: "executor",
    label: "Graduation executor",
    detail:
      "Deploys GraduationExecutor — the auction's funds/tokens recipient.",
  },
  {
    id: "auction",
    label: "Auction",
    detail: "Deploys the CCA auction via the factory (CREATE2).",
  },
  {
    id: "hookAuction",
    label: "Lock bid gate to the auction",
    detail:
      "Tells the AllowlistHook which auction may call it, so nobody else can burn a bidder's cap (curated track only).",
  },
  {
    id: "fund",
    label: "Fund the auction",
    detail:
      "Transfers the whole sale supply from the deploying wallet to the auction.",
  },
  {
    id: "received",
    label: "Open bidding",
    detail:
      "Calls onTokensReceived() so the auction accepts bids. Safe to repeat.",
  },
  {
    id: "bind",
    label: "Bind the executor",
    detail:
      "Binds the graduation executor to this one auction — it refuses every other address.",
  },
] as const;

export type AuctionDeployStepId = (typeof AUCTION_DEPLOY_STEPS)[number]["id"];

export type AuctionDeployStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

export interface AuctionDeployStepState {
  status: AuctionDeployStepStatus;
  /** Confirmed tx hash; null when satisfied by pre-existing code. */
  txHash: string | null;
  /** Created (CREATE) or precomputed (CREATE2) address. */
  address: string | null;
  /** Satisfied by code already onchain (an earlier attempt). */
  alreadyDeployed: boolean;
}

export type AuctionDeployPhase =
  | "idle"
  | "preparing"
  | "running"
  | "linking"
  | "success"
  | "paused"
  | "blocked";

export interface AuctionDeployFailure {
  /** Which part of the flow failed: preflight, an onchain step, the record update. */
  stage: "prepare" | "step" | "link";
  /** `stage: "prepare"` — which check. */
  check: AuctionPreflightStage | null;
  /** `stage: "step"` — which step. */
  step: AuctionDeployStepId | null;
  /** Mined tx hash (also present for a mined revert); null without a receipt. */
  txHash: string | null;
  /**
   * "reverted" — mined with status reverted; "unknown" — no receipt (the tx
   * may or may not have been broadcast); null — failed before broadcast.
   */
  outcome: "reverted" | "unknown" | null;
  reason: string;
}

export interface AuctionDeployState {
  phase: AuctionDeployPhase;
  steps: Record<AuctionDeployStepId, AuctionDeployStepState>;
  /** The CREATE2 auction address (known before the factory tx mines). */
  auctionAddress: string | null;
  failure: AuctionDeployFailure | null;
}

export type AuctionDeployAction =
  | { type: "begin"; mode: "fresh" | "resume" }
  | { type: "blocked"; stage: AuctionPreflightStage; detail: string }
  | { type: "prepared"; auctionAddress: string | null }
  | { type: "step_started"; step: AuctionDeployStepId }
  | { type: "step_address"; step: AuctionDeployStepId; address: string }
  | {
      type: "step_done";
      step: AuctionDeployStepId;
      txHash: string | null;
      address: string;
      alreadyDeployed: boolean;
    }
  | {
      type: "step_failed";
      step: AuctionDeployStepId;
      txHash: string | null;
      outcome: "reverted" | "unknown" | null;
      reason: string;
    }
  | { type: "link_started" }
  | { type: "link_failed"; reason: string }
  | { type: "linked" };

export type AuctionDispatch = (action: AuctionDeployAction) => void;

function freshDeploySteps(
  admission: "curated" | "community",
): Record<AuctionDeployStepId, AuctionDeployStepState> {
  const entry = (skipped: boolean): AuctionDeployStepState => ({
    status: skipped ? "skipped" : "pending",
    txHash: null,
    address: null,
    alreadyDeployed: false,
  });
  return {
    hook: entry(admission !== "curated"),
    executor: entry(false),
    auction: entry(false),
    hookAuction: entry(admission !== "curated"),
    fund: entry(false),
    received: entry(false),
    bind: entry(false),
  };
}

export function initAuctionDeployState(
  admission: "curated" | "community" = "community",
): AuctionDeployState {
  return {
    phase: "idle",
    steps: freshDeploySteps(admission),
    auctionAddress: null,
    failure: null,
  };
}

function withStep(
  state: AuctionDeployState,
  step: AuctionDeployStepId,
  patch: Partial<AuctionDeployStepState>,
): Record<AuctionDeployStepId, AuctionDeployStepState> {
  return { ...state.steps, [step]: { ...state.steps[step], ...patch } };
}

/** Pure flow reducer — the single state authority of the deploy card. */
export function auctionDeployReducer(
  state: AuctionDeployState,
  action: AuctionDeployAction,
): AuctionDeployState {
  switch (action.type) {
    case "begin": {
      // Both modes keep completed steps (deploy idempotency lives onchain plus
      // in the recorded predictions) and give a failed/running step a clean
      // retry that RETAINS its predicted address — the no-receipt guard reads
      // it before re-sending. `mode` documents intent ("fresh" = first run,
      // "resume" = retry); the transition is identical by design.
      const steps = Object.fromEntries(
        Object.entries(state.steps).map(([id, step]) => [
          id,
          step.status === "failed" || step.status === "running"
            ? {
                ...step,
                status: "pending" as const,
                txHash: null,
                alreadyDeployed: false,
              }
            : step,
        ]),
      ) as Record<AuctionDeployStepId, AuctionDeployStepState>;
      return { ...state, steps, phase: "preparing", failure: null };
    }
    case "blocked":
      return {
        ...state,
        phase: "blocked",
        failure: {
          stage: "prepare",
          check: action.stage,
          step: null,
          txHash: null,
          outcome: null,
          reason: action.detail,
        },
      };
    case "prepared":
      return {
        ...state,
        phase: "running",
        auctionAddress: action.auctionAddress ?? state.auctionAddress,
        failure: null,
      };
    case "step_started":
      return {
        ...state,
        phase: "running",
        steps: withStep(state, action.step, {
          status: "running",
          txHash: null,
          alreadyDeployed: false,
        }),
        failure: null,
      };
    case "step_address":
      return {
        ...state,
        steps: withStep(state, action.step, { address: action.address }),
      };
    case "step_done":
      return {
        ...state,
        steps: withStep(state, action.step, {
          status: "done",
          txHash: action.txHash,
          address: action.address,
          alreadyDeployed: action.alreadyDeployed,
        }),
      };
    case "step_failed":
      return {
        ...state,
        phase: "paused",
        steps: withStep(state, action.step, {
          status: "failed",
          txHash: action.txHash,
        }),
        failure: {
          stage: "step",
          check: null,
          step: action.step,
          txHash: action.txHash,
          outcome: action.outcome,
          reason: action.reason,
        },
      };
    case "link_started":
      return { ...state, phase: "linking", failure: null };
    case "link_failed":
      return {
        ...state,
        phase: "paused",
        failure: {
          stage: "link",
          check: null,
          step: null,
          txHash: null,
          outcome: null,
          reason: action.reason,
        },
      };
    case "linked":
      return { ...state, phase: "success", failure: null };
    default:
      return state;
  }
}

/** Index of the first step still to run (AUCTION_DEPLOY_STEPS.length when done). */
export function deployResumeIndex(state: AuctionDeployState): number {
  const index = AUCTION_DEPLOY_STEPS.findIndex(
    (s) =>
      state.steps[s.id].status !== "done" &&
      state.steps[s.id].status !== "skipped",
  );
  return index === -1 ? AUCTION_DEPLOY_STEPS.length : index;
}

/** What "retry" means in the current state (null = nothing to retry). */
export type AuctionRetryPlan =
  | { kind: "steps"; resumeAt: number }
  | { kind: "record"; auctionAddress: string }
  | null;

/**
 * Retry is always safe when offered:
 * - step failures resume at the failed step with RE-DERIVED inputs; a retry of
 *   a CREATE step first checks code at its predicted address (an unknown
 *   outcome is indistinguishable from "landed later"), and the factory step
 *   checks the CREATE2 address before re-sending (re-running `create` with the
 *   same salt would revert);
 * - the executor/hook CREATE retries predict a fresh address from the current
 *   nonce when no code exists at the previous prediction (a reverted deploy
 *   consumes its nonce);
 * - a record-update failure keeps the deployed auction and re-publishes only
 *   the record.
 */
export function retryPlan(state: AuctionDeployState): AuctionRetryPlan {
  if (state.phase !== "paused") return null;
  if (state.failure?.stage === "link") {
    const auctionAddress = state.auctionAddress ?? state.steps.auction.address;
    return auctionAddress ? { kind: "record", auctionAddress } : null;
  }
  if (state.failure?.stage === "step") {
    return { kind: "steps", resumeAt: deployResumeIndex(state) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deploy orchestrator
// ---------------------------------------------------------------------------

/** Labels for failure copy (rule 1: the failure names its step). */
export const AUCTION_DEPLOY_STEP_LABELS: Record<AuctionDeployStepId, string> = {
  hook: "Deploy bid gate",
  executor: "Deploy graduation executor",
  auction: "Deploy auction",
  hookAuction: "Lock bid gate to the auction",
  fund: "Fund the auction",
  received: "Open bidding",
  bind: "Bind the executor",
};

function isCreateStep(step: AuctionDeployStepId): step is "hook" | "executor" {
  return step === "hook" || step === "executor";
}

type PostDeployStepId = "hookAuction" | "fund" | "received" | "bind";

/** The 32-byte hex word as a bigint; an empty return (`0x`) reads as zero. */
function wordToBigInt(raw: string): bigint {
  return raw === "0x" || raw === "" ? 0n : BigInt(raw);
}

/**
 * Run one step that acts on the already-deployed contracts (lock the hook,
 * fund the auction, open bidding, bind the executor).
 *
 * Every step reads the chain first and is satisfied without a send when its
 * effect is already onchain, so a retry after an unknown outcome is always
 * safe (`onTokensReceived` is idempotent upstream). Returns whether the flow
 * may continue; on `false` the failure has already been dispatched.
 */
async function runPostDeployStep(input: {
  step: PostDeployStepId;
  effects: AuctionEffects;
  params: AuctionDeployParams;
  deployer: string;
  addresses: Record<AuctionDeployStepId, string | null>;
  dispatch: AuctionDispatch;
  fail: (
    step: AuctionDeployStepId,
    txHash: string | null,
    outcome: "reverted" | "unknown" | null,
    reason: string,
  ) => void;
}): Promise<boolean> {
  const { step, effects, params, deployer, addresses, dispatch, fail } = input;
  const auction = addresses.auction;
  if (!auction) {
    fail(
      step,
      null,
      null,
      "the auction address is unknown — run the auction step first",
    );
    return false;
  }
  const done = (address: string, txHash: string | null): void =>
    dispatch({
      type: "step_done",
      step,
      txHash,
      address,
      alreadyDeployed: txHash === null,
    });

  let call: AuctionSendCall;
  let target: string;
  try {
    switch (step) {
      case "hookAuction": {
        const hook = addresses.hook;
        if (!hook) {
          fail(
            step,
            null,
            null,
            "the bid gate address is unknown — run the bid gate step first",
          );
          return false;
        }
        const bound = addressWordValue(
          await effects.call({ to: hook, data: SELECTOR_HOOK_AUCTION }),
        );
        if (bound.toLowerCase() === auction.toLowerCase()) {
          done(hook, null);
          return true;
        }
        call = buildSetHookAuctionCall(hook, auction);
        target = hook;
        break;
      }
      case "fund": {
        const held = wordToBigInt(
          await effects.call({
            to: params.token,
            data: encodeErc20BalanceOf(auction),
          }),
        );
        if (held >= params.amount) {
          done(auction, null);
          return true;
        }
        const mine = wordToBigInt(
          await effects.call({
            to: params.token,
            data: encodeErc20BalanceOf(deployer),
          }),
        );
        if (mine < params.amount - held) {
          fail(
            step,
            null,
            null,
            `the deploying wallet ${deployer} holds ${mine} base units of the sale token but the auction still needs ${params.amount - held}: move the supply to this wallet, then retry`,
          );
          return false;
        }
        call = buildFundAuctionCall(
          params.token,
          auction,
          params.amount - held,
        );
        target = auction;
        break;
      }
      case "received":
        call = buildOnTokensReceivedCall(auction);
        target = auction;
        break;
      case "bind": {
        const executor = addresses.executor;
        if (!executor) {
          fail(
            step,
            null,
            null,
            "the GraduationExecutor address is unknown — run the executor step first",
          );
          return false;
        }
        const bound = addressWordValue(
          await effects.call({ to: executor, data: SELECTOR_BOUND_AUCTION }),
        );
        if (bound.toLowerCase() === auction.toLowerCase()) {
          done(executor, null);
          return true;
        }
        call = buildBindAuctionCall(executor, auction);
        target = executor;
        break;
      }
    }
  } catch (error) {
    fail(
      step,
      null,
      null,
      `reading the chain before "${AUCTION_DEPLOY_STEP_LABELS[step]}" failed: ${auctionErrorMessage(error)}`,
    );
    return false;
  }

  let receipt: AuctionTxReceipt;
  try {
    receipt = await effects.send(call);
  } catch (error) {
    fail(
      step,
      null,
      "unknown",
      `${auctionErrorMessage(error)} — the transaction may or may not have been broadcast; retry reads the chain first`,
    );
    return false;
  }
  if (receipt.status !== "success") {
    fail(
      step,
      receipt.txHash,
      "reverted",
      `transaction ${receipt.txHash} reverted in block ${receipt.blockNumber}`,
    );
    return false;
  }
  done(target, receipt.txHash);
  return true;
}

/**
 * Run the deploy: optional hook CREATE → GraduationExecutor CREATE → factory
 * CREATE2 auction → (curated) lock the hook to the auction → fund the auction
 * with the sale supply → `onTokensReceived()` → bind the executor to the
 * auction → record link. Without the last four steps an auction cannot take a
 * bid (`TokensNotReceived`) and its executor would trust any address. Each receipt is awaited before the next
 * broadcast (the ordering is a hard protocol requirement — the executor must
 * exist before the auction names it as both recipients). Halts on the first
 * failure and records exactly which step failed and why (mined revert vs.
 * unknown outcome); completed steps are never rolled back or hidden.
 */
export async function runAuctionDeploy(input: {
  effects: AuctionEffects;
  plan: AuctionPlanInputs;
  deployer: string;
  factory?: string;
  reserveBps?: number;
  salt?: bigint;
  dispatch: AuctionDispatch;
  mode: "fresh" | "resume";
  /** The flow's current state — completed/predicted addresses seed retries. */
  previous: AuctionDeployState;
  onLink: (input: { auction: string }) => Promise<unknown>;
}): Promise<void> {
  const {
    effects,
    plan,
    deployer,
    factory = DEFAULT_CCA_FACTORY,
    reserveBps = DEFAULT_RESERVE_BPS,
    salt = DEFAULT_AUCTION_SALT,
    dispatch,
    mode,
    previous,
    onLink,
  } = input;

  let params: AuctionDeployParams;
  try {
    params = deriveAuctionDeployParams(plan);
  } catch (error) {
    dispatch({
      type: "blocked",
      stage: "plan",
      detail: auctionErrorMessage(error),
    });
    return;
  }

  dispatch({ type: "begin", mode });
  dispatch({ type: "prepared", auctionAddress: null });

  // Addresses as the run discovers them; seeded from the carried state so a
  // resume keeps earlier completions (and predictions) alive.
  const addresses: Record<AuctionDeployStepId, string | null> = {
    hook: previous.steps.hook.address,
    executor: previous.steps.executor.address,
    auction: previous.steps.auction.address,
    hookAuction: previous.steps.hookAuction.address,
    fund: previous.steps.fund.address,
    received: previous.steps.received.address,
    bind: previous.steps.bind.address,
  };

  const failStep = (
    step: AuctionDeployStepId,
    txHash: string | null,
    outcome: "reverted" | "unknown" | null,
    reason: string,
  ): void => {
    dispatch({ type: "step_failed", step, txHash, outcome, reason });
  };

  for (const { id: step } of AUCTION_DEPLOY_STEPS) {
    // The plan is authoritative: community-track launches deploy no hook even
    // if a stale state object says otherwise.
    if (
      (step === "hook" || step === "hookAuction") &&
      params.hookPerWalletCap === null
    )
      continue;
    const carried = previous.steps[step];
    if (carried.status === "done" || carried.status === "skipped") continue;
    dispatch({ type: "step_started", step });

    if (isCreateStep(step)) {
      // Idempotency guard (mintFlow's `tokenAlreadyDeployed`): code at the
      // predicted address means an earlier attempt's CREATE landed.
      if (carried.address) {
        let deployed: boolean;
        try {
          deployed = await effects.codeAt(carried.address);
        } catch (error) {
          failStep(
            step,
            null,
            null,
            `verifying ${carried.address} onchain failed: ${auctionErrorMessage(error)}`,
          );
          return;
        }
        if (deployed) {
          addresses[step] = carried.address;
          dispatch({
            type: "step_done",
            step,
            txHash: null,
            address: carried.address,
            alreadyDeployed: true,
          });
          continue;
        }
      }
      let nonce: bigint;
      try {
        nonce = await effects.transactionCount();
      } catch (error) {
        failStep(
          step,
          null,
          null,
          `reading the wallet nonce (for the deploy-address prediction) failed: ${auctionErrorMessage(error)}`,
        );
        return;
      }
      let predicted: string;
      try {
        predicted = predictCreateAddress(deployer, nonce);
      } catch (error) {
        failStep(step, null, null, auctionErrorMessage(error));
        return;
      }
      addresses[step] = predicted;
      dispatch({ type: "step_address", step, address: predicted });
      const data =
        step === "hook"
          ? encodeAllowlistHookDeploy(
              params.treasury,
              params.hookPerWalletCap ?? 0n,
            )
          : encodeGraduationExecutorDeploy(params.treasury, reserveBps);
      let receipt: AuctionTxReceipt;
      try {
        receipt = await effects.send({ data, value: "0x0" });
      } catch (error) {
        failStep(
          step,
          null,
          "unknown",
          `${auctionErrorMessage(error)} — the transaction may or may not have been broadcast; retry checks code at ${predicted} first`,
        );
        return;
      }
      if (receipt.status !== "success") {
        failStep(
          step,
          receipt.txHash,
          "reverted",
          `transaction ${receipt.txHash} reverted in block ${receipt.blockNumber}`,
        );
        return;
      }
      // The receipt's `contractAddress` is authoritative for CREATE sends.
      const address = receipt.contractAddress ?? predicted;
      addresses[step] = address;
      dispatch({
        type: "step_done",
        step,
        txHash: receipt.txHash,
        address,
        alreadyDeployed: false,
      });
      continue;
    }

    if (step !== "auction") {
      // Acts on the deployed contracts; needs the auction address, which the
      // auction step (earlier in the list) has already recorded.
      const ok = await runPostDeployStep({
        step,
        effects,
        params,
        deployer,
        addresses,
        dispatch,
        fail: failStep,
      });
      if (!ok) return;
      continue;
    }

    // Auction step — factory CREATE2 with the executor as both recipients.
    const executor = addresses.executor;
    if (!executor) {
      failStep(
        step,
        null,
        null,
        "the GraduationExecutor address is unknown — run the executor step first",
      );
      return;
    }
    const configData = encodeAuctionConfigData({
      params,
      executor,
      hook: addresses.hook,
    });
    let auctionAddress: string | null = null;
    try {
      const raw = await effects.call(
        buildFactoryGetAddressView({
          factory,
          params,
          configData,
          salt,
          sender: deployer,
        }),
      );
      auctionAddress = addressWordValue(raw);
    } catch (error) {
      failStep(
        step,
        null,
        null,
        `factory.getAddress(...) failed: ${auctionErrorMessage(error)}`,
      );
      return;
    }
    addresses[step] = auctionAddress;
    dispatch({ type: "step_address", step, address: auctionAddress });
    try {
      if (await effects.codeAt(auctionAddress)) {
        dispatch({
          type: "step_done",
          step,
          txHash: null,
          address: auctionAddress,
          alreadyDeployed: true,
        });
        continue;
      }
    } catch (error) {
      failStep(
        step,
        null,
        null,
        `verifying ${auctionAddress} onchain failed: ${auctionErrorMessage(error)}`,
      );
      return;
    }
    let receipt: AuctionTxReceipt;
    try {
      receipt = await effects.send(
        buildFactoryCreateCall({ factory, params, configData, salt }),
      );
    } catch (error) {
      failStep(
        step,
        null,
        "unknown",
        `${auctionErrorMessage(error)} — the transaction may or may not have been broadcast; retry checks code at ${auctionAddress} first`,
      );
      return;
    }
    if (receipt.status !== "success") {
      failStep(
        step,
        receipt.txHash,
        "reverted",
        `transaction ${receipt.txHash} reverted in block ${receipt.blockNumber}`,
      );
      return;
    }
    // Verify the factory actually created code where the CREATE2 said it would.
    try {
      const deployed = await effects.codeAt(auctionAddress);
      if (!deployed) {
        failStep(
          step,
          receipt.txHash,
          null,
          `the factory transaction ${receipt.txHash} confirmed but there is no code at ${auctionAddress} — retry re-checks before re-sending`,
        );
        return;
      }
    } catch (error) {
      failStep(
        step,
        receipt.txHash,
        null,
        `the factory transaction ${receipt.txHash} confirmed but verifying ${auctionAddress} failed: ${auctionErrorMessage(error)}`,
      );
      return;
    }
    dispatch({
      type: "step_done",
      step,
      txHash: receipt.txHash,
      address: auctionAddress,
      alreadyDeployed: false,
    });
  }

  const auctionAddress = addresses.auction;
  if (!auctionAddress) {
    failStep(
      "auction",
      null,
      null,
      "the auction address is unknown after the deploy steps",
    );
    return;
  }
  dispatch({ type: "prepared", auctionAddress });
  dispatch({ type: "link_started" });
  try {
    await onLink({ auction: auctionAddress });
  } catch (error) {
    dispatch({ type: "link_failed", reason: auctionErrorMessage(error) });
    return;
  }
  dispatch({ type: "linked" });
}
