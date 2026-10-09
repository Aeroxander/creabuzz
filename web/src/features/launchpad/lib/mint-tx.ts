/**
 * Token-mint calldata for the web launchpad: the `DeployAppToken.s.sol`
 * onchain sequence and the two view preflights. Port of desktop
 * `lib/evmCalls.ts`' token-deploy section (lines 560-866) and `lib/mintFlow.ts`'s
 * plan → params mapping and view builders (lines 97-278). Wire shapes:
 *
 * - `deployToken(DeploymentParameters, SignatureECDSA)` — TokenMaster router
 *   entry (`tm-tokenmaster/src/DataTypes.sol` field order, exact signature in
 *   {@link SIGNATURE_DEPLOY_TOKEN}); empty ECDSA signature is what the deploy
 *   script uses (permissionless on fresh/local deployments).
 * - `DeploymentParameters.poolParams.encodedInitializationArgs` is
 *   `abi.encode(StandardPoolInitializationParameters{...})` —
 *   `pools/standard-token-pool/DataTypes.sol` field order; treasury gets
 *   `initialSupplyAmount - 1` while the router keeps a permanent 1-wei lock
 *   (`StandardPool.sol:127-128`).
 * - `factory.computeDeploymentAddress(bytes32, PoolDeploymentParameters,
 *   uint256, uint256)` — the CREATE2 preflight; its pool block is spliced
 *   from the production `encodeDeployToken` bytes so the computed address is
 *   exactly what the deploy call creates.
 * - `router.infrastructureFeeBPS()` — the fee cap preflight.
 *
 * The encoder is `identity/lib/userop-abi.ts`'s golden-tested `abiEncode` /
 * `abiEncodeCall` (same hand-rolled ABI coder the sponsored sender uses);
 * desktop's `mintFlow.test.mjs` `cast` vectors are the byte-parity bind.
 */
import {
  DEFAULT_STANDARD_POOL_FACTORY,
  DEFAULT_TOKENMASTER_ROUTER,
  encodeDeployToken,
} from "@creaton/core/launchpad/evmCalls.ts";
import { addressWordValue } from "@creaton/core/launchpad/auctionPlan.ts";
import type {
  EvmCall,
  TokenDeployCallsParams,
} from "@creaton/core/launchpad/evmCalls.ts";

/** The encoders live once, in `@creaton/core`; they are re-exported here so this module's callers keep one import site. */
export {
  CANONICAL_TRANSFER_VALIDATOR,
  INITIAL_SPEND_CREATOR_SHARE_BPS,
  MAX_INFRASTRUCTURE_FEE_BPS,
  MAX_SPEND_CREATOR_SHARE_BPS,
  MAX_TOKEN_FEE_BPS,
  MAX_TOKEN_SPREAD_BPS,
  SIGNATURE_DEPLOY_TOKEN,
  SIGNATURE_SET_RULESET_OF_COLLECTION,
  SIGNATURE_SET_TRANSFER_VALIDATOR,
  ZERO_ADDRESS,
  buildTokenDeployCalls,
  encodeSetRulesetOfCollection,
  encodeSetTransferValidator,
} from "@creaton/core/launchpad/evmCalls.ts";
export {
  DEFAULT_STANDARD_POOL_FACTORY,
  DEFAULT_TOKENMASTER_ROUTER,
  encodeDeployToken,
};
export type { TokenDeployCallsParams };

import { functionSelector } from "../../identity/lib/userop-abi.ts";

/** `infrastructureFeeBPS() -> uint16` on the TokenMaster router. */
export const SIGNATURE_INFRA_FEE_BPS = "infrastructureFeeBPS()";

/**
 * `computeDeploymentAddress(bytes32, PoolDeploymentParameters, uint256,
 * uint256) -> address` on the StandardPool factory. The tuple is
 * `PoolDeploymentParameters` in canonical ABI form (DataTypes.sol field order).
 */
export const SIGNATURE_COMPUTE_DEPLOYMENT_ADDRESS =
  "computeDeploymentAddress(bytes32,(string,string,uint8,address,address," +
  "uint256,bytes,address,bool,address,uint256),uint256,uint256)";

/** Selector of {@link SIGNATURE_INFRA_FEE_BPS} (`cast sig`: `0xa82f4d02`). */
export const SELECTOR_INFRA_FEE_BPS = "0xa82f4d02";
/** Selector of {@link SIGNATURE_COMPUTE_DEPLOYMENT_ADDRESS} (`cast`: `0x8d33f2bf`). */
export const SELECTOR_COMPUTE_DEPLOYMENT_ADDRESS = "0x8d33f2bf";

/** One unsigned call — the shape both senders receive unmodified. */
export type MintEvmCall = EvmCall & { value: string };

// ---------------------------------------------------------------------------
// ABI layout probing (mintFlow.ts:174-278) — the CREATE2 preflight splices the
// production encoder's bytes, so layout drift throws instead of computing a
// wrong deterministic address.
// ---------------------------------------------------------------------------

const DEPLOY_ARGS_HEAD_WORDS = 4;
const DEPLOY_PARAMS_POOL_WORD = 5;
const DEPLOY_PARAMS_HEAD_WORDS = 7;

function bareArgs(calldata: string): string {
  const hex = calldata.toLowerCase().replace(/^0x/, "");
  if (hex.length <= 8 || (hex.length - 8) % 64 !== 0) {
    throw new Error("deploy calldata truncated");
  }
  return hex.slice(8);
}

function argWord(args: string, index: number): string {
  const word = args.slice(index * 64, index * 64 + 64);
  if (word.length !== 64) throw new Error("deploy calldata truncated");
  return word;
}

function wordValue(word: string): bigint {
  return BigInt(`0x${word}`);
}

function uint256Word(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) {
    throw new Error(`uint256 out of range: ${value}`);
  }
  return value.toString(16).padStart(64, "0");
}

/**
 * Cut the self-contained `PoolDeploymentParameters` tuple block out of a
 * `deployToken` calldata (from {@link encodeDeployToken}). Throws on layout
 * drift or truncation rather than encoding a wrong CREATE2 input.
 */
export function extractPoolParamsBlock(deployCalldata: string): string {
  const args = bareArgs(deployCalldata);
  const paramsOffset = wordValue(argWord(args, 0));
  const expectedHead = BigInt(DEPLOY_ARGS_HEAD_WORDS * 32);
  if (paramsOffset !== expectedHead) {
    throw new Error(
      `deploy calldata layout drift: DeploymentParameters at ${paramsOffset}, expected ${expectedHead}`,
    );
  }
  const paramsStart = Number(paramsOffset);
  const poolOffset = wordValue(
    argWord(args, paramsStart / 32 + DEPLOY_PARAMS_POOL_WORD),
  );
  const expectedPool = BigInt(DEPLOY_PARAMS_HEAD_WORDS * 32);
  if (poolOffset !== expectedPool) {
    throw new Error(
      `deploy calldata layout drift: poolParams at ${poolOffset}, expected ${expectedPool}`,
    );
  }
  const block = args.slice((paramsStart + Number(poolOffset)) * 2);
  if (block.length === 0 || block.length % 64 !== 0) {
    throw new Error("deploy calldata truncated");
  }
  return `0x${block}`;
}

/**
 * The `factory.computeDeploymentAddress(tokenSalt, poolParams, pairedValueIn,
 * infrastructureFeeBPS)` view call for the given deploy params and the LIVE
 * router fee (the script's exact precondition order).
 *
 * The salt, paired deposit, and `poolParams` are spliced out of
 * `encodeDeployToken(params)` so the CREATE2 input byte-matches what the
 * deploy transaction will actually send; `params.tokenAddress` never reaches
 * `PoolDeploymentParameters`, so a placeholder produces the identical call.
 */
export function buildComputeDeploymentAddressView(
  params: TokenDeployCallsParams,
  infrastructureFeeBps: bigint,
): MintEvmCall {
  const deployData = encodeDeployToken(params);
  const args = bareArgs(deployData);
  const paramsStart = Number(wordValue(argWord(args, 0)));
  // DeploymentParameters.tokenSalt (bytes32) — reused as the view's salt arg.
  const saltWord = argWord(args, paramsStart / 32 + 1);
  const poolBlock = extractPoolParamsBlock(deployData);
  // poolParams.initialPairedTokenToDeposit — the view's pairedValueIn arg
  // (DeployAppToken.s.sol passes the same `pairedDeposit` to both).
  const pairedWord = argWord(poolBlock.slice(2), 5);
  return {
    to: params.factory ?? DEFAULT_STANDARD_POOL_FACTORY,
    data:
      SELECTOR_COMPUTE_DEPLOYMENT_ADDRESS +
      saltWord +
      uint256Word(BigInt(DEPLOY_ARGS_HEAD_WORDS * 32)) + // poolParams offset
      pairedWord +
      uint256Word(infrastructureFeeBps) +
      poolBlock.slice(2),
    value: "0x0",
  };
}

/** The `router.infrastructureFeeBPS()` view call (no arguments). */
export function buildInfraFeeView(
  router: string = DEFAULT_TOKENMASTER_ROUTER,
): MintEvmCall {
  return {
    to: router,
    data: functionSelector(SIGNATURE_INFRA_FEE_BPS),
    value: "0x0",
  };
}

/** Decode an eth_call 32-byte word as an address (left-padded, 20 bytes). */
export const decodeAddressWord = addressWordValue;

// ---------------------------------------------------------------------------
// Plan inputs → deploy params (mintFlow.ts:74-120) + treasury gate (:401-431)
// ---------------------------------------------------------------------------

/** The launch's mint plan plus the v1 deployer-derived treasury. */
export interface MintPlanInputs {
  /** `PoolDeploymentParameters.name` (the launch record's token plan). */
  name: string;
  /** `PoolDeploymentParameters.symbol`. */
  symbol: string;
  /** Whole tokens (the plan's supply); converted to 18-decimal base units. */
  supply: string;
  /**
   * Token `initialOwner` AND `initialSupplyRecipient`. V1: the deployer
   * account — calls 2-3 are token-owner ops, so the broadcaster must be the
   * treasury. Use {@link treasuryGate} to enforce it.
   */
  treasury: string;
}

/**
 * Map a launch mint plan to {@link TokenDeployCallsParams}. All other deploy
 * knobs keep `DeployAppToken.s.sol`'s env defaults (salt 1, 0.1 ether paired
 * deposit, spread 100, buy/sell fee 200, zero default transfer validator).
 */
export function deployParamsForPlan(
  inputs: MintPlanInputs,
  tokenAddress: string,
): TokenDeployCallsParams {
  const supply = inputs.supply.trim();
  if (!/^\d+$/.test(supply) || BigInt(supply) === 0n) {
    throw new Error(
      `token supply must be a positive whole number: ${inputs.supply}`,
    );
  }
  return {
    name: inputs.name,
    symbol: inputs.symbol,
    treasury: inputs.treasury,
    tokenAddress,
    // DeployAppToken.s.sol: `APPTOKEN_INITIAL_SUPPLY * 1e18`.
    initialSupplyAmount: BigInt(supply) * 10n ** 18n,
  };
}

/** Result of {@link treasuryGate}. */
export type TreasuryGate =
  | { ok: true; treasury: string }
  | { ok: false; detail: string };

/**
 * V1 allows deploying only when the sender is the launch's treasury: calls 2-3
 * are token-owner ops (`DeployAppToken.s.sol` reverts with
 * `NotTreasuryBroadcaster` otherwise), so a mismatch must block in the UI
 * instead of reverting onchain. An unset record treasury is adopted as the
 * sender address.
 */
export function treasuryGate(
  deployer: string,
  recordTreasury: string | null | undefined,
): TreasuryGate {
  const wallet = deployer.trim();
  const recorded = (recordTreasury ?? "").trim();
  if (recorded === "") return { ok: true, treasury: wallet };
  if (recorded.toLowerCase() === wallet.toLowerCase()) {
    return { ok: true, treasury: wallet };
  }
  return {
    ok: false,
    detail: `The launch record's treasury (${recorded}) is not your wallet (${wallet}). For now, the deploying wallet must be the treasury, because the transfer validator and the trading ruleset are token-owner operations. Update the launch's treasury to your wallet address (Edit terms), then deploy.`,
  };
}
