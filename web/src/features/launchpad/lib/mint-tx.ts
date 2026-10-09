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
  CANONICAL_TRANSFER_VALIDATOR,
  DEFAULT_STANDARD_POOL_FACTORY,
  DEFAULT_TOKENMASTER_ROUTER,
  INITIAL_SPEND_CREATOR_SHARE_BPS,
  MAX_SPEND_CREATOR_SHARE_BPS,
  MAX_TOKEN_FEE_BPS,
  MAX_TOKEN_SPREAD_BPS,
  SIGNATURE_DEPLOY_TOKEN,
  SIGNATURE_SET_RULESET_OF_COLLECTION,
  SIGNATURE_SET_TRANSFER_VALIDATOR,
  ZERO_ADDRESS,
  encodeDeployToken,
  encodeSetRulesetOfCollection,
  encodeSetTransferValidator,
} from "@creaton/core/launchpad/evmCalls.ts";
import type { TokenDeployCallsParams } from "@creaton/core/launchpad/evmCalls.ts";

/** The encoders live once, in `@creaton/core`; they are re-exported here so this module's callers keep one import site. */
export {
  CANONICAL_TRANSFER_VALIDATOR,
  DEFAULT_STANDARD_POOL_FACTORY,
  DEFAULT_TOKENMASTER_ROUTER,
  INITIAL_SPEND_CREATOR_SHARE_BPS,
  MAX_SPEND_CREATOR_SHARE_BPS,
  MAX_TOKEN_FEE_BPS,
  MAX_TOKEN_SPREAD_BPS,
  SIGNATURE_DEPLOY_TOKEN,
  SIGNATURE_SET_RULESET_OF_COLLECTION,
  SIGNATURE_SET_TRANSFER_VALIDATOR,
  ZERO_ADDRESS,
  encodeDeployToken,
  encodeSetRulesetOfCollection,
  encodeSetTransferValidator,
};
export type { TokenDeployCallsParams };

import {
  functionSelector,
} from "../../identity/lib/userop-abi.ts";

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

/**
 * `deployParams.maxInfrastructureFeeBPS` in `DeployAppToken.s.sol` (250) —
 * the cap `encodeDeployToken` bakes into the deploy call. A live router fee
 * above it makes `deployToken` revert (`InvalidInfrastructureFeeBPS`).
 */
export const MAX_INFRASTRUCTURE_FEE_BPS = 250n; // the script hardcodes 18
const VANILLA_RULESET_ID = 1n; // open trading; tighten later via the validator

/** One unsigned call — the shape both senders receive unmodified. */
export interface MintEvmCall {
  to: string;
  data: string;
  value: string;
}

interface ResolvedTokenDeployParams {
  name: string;
  symbol: string;
  treasury: string;
  owner: string;
  tokenAddress: string;
  salt: bigint;
  initialSupplyAmount: bigint;
  pairedDepositWei: bigint;
  spreadBps: number;
  buyFeeBps: number;
  sellFeeBps: number;
  defaultTransferValidator: string;
  router: string;
  factory: string;
}

function resolveTokenDeployParams(
  params: TokenDeployCallsParams,
): ResolvedTokenDeployParams {
  const spreadBps = params.spreadBps ?? 100;
  const buyFeeBps = params.buyFeeBps ?? 200;
  const sellFeeBps = params.sellFeeBps ?? 200;
  // The deploy script refuses these too (`AboveCeiling`): fail here, not on chain.
  for (const [label, value, ceiling] of [
    ["spreadBps", spreadBps, MAX_TOKEN_SPREAD_BPS],
    ["buyFeeBps", buyFeeBps, MAX_TOKEN_FEE_BPS],
    ["sellFeeBps", sellFeeBps, MAX_TOKEN_FEE_BPS],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || BigInt(value) > ceiling) {
      throw new Error(
        `${label} must be an integer in 0..${ceiling} (the pool's immutable ceiling): ${value}`,
      );
    }
  }
  return {
    name: params.name,
    symbol: params.symbol,
    treasury: params.treasury,
    owner: params.owner ?? params.treasury,
    tokenAddress: params.tokenAddress,
    salt: params.salt ?? 1n,
    initialSupplyAmount: params.initialSupplyAmount ?? 1_000_000n * 10n ** 18n,
    pairedDepositWei: params.pairedDepositWei ?? 10n ** 17n, // 0.1 ether
    spreadBps,
    buyFeeBps,
    sellFeeBps,
    defaultTransferValidator: params.defaultTransferValidator ?? ZERO_ADDRESS,
    router: params.router ?? DEFAULT_TOKENMASTER_ROUTER,
    factory: params.factory ?? DEFAULT_STANDARD_POOL_FACTORY,
  };
}

function valueHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/**
 * Compose the exact onchain call sequence of `DeployAppToken.s.sol`'s
 * broadcast section (port of evmCalls.ts:838-866):
 *
 * 1. `router.deployToken{value: pairedDepositWei}(deployParams, empty
 *    signature)` — deploys the token + Standard pool via CREATE2 at
 *    `tokenAddress`, mints `initialSupplyAmount` to `treasury`, and deposits
 *    `pairedDepositWei` of native pairing as the pool's starting reserve.
 * 2. `token.setTransferValidator(realTV)` — `realTV` resolves the zero address
 *    to {@link CANONICAL_TRANSFER_VALIDATOR} exactly like the script.
 *    Owner-only: the broadcaster must be `treasury`.
 * 3. `realTV.setRulesetOfCollection(token, 1, address(0), 0, 0)` — Vanilla
 *    ruleset (id 1 = open trading).
 *
 * The COMPOSER is sender-agnostic; the SEND strategy differs by sender (the
 * launchpad money-action contract): through `sponsoredSender.ts` these become
 * ONE batched UserOp (atomic, kernel-0.3.3 CALLTYPE_BATCH), through the
 * injected wallet three sequential transactions. Same bytes either way.
 */
export function buildTokenDeployCalls(
  params: TokenDeployCallsParams,
): MintEvmCall[] {
  const p = resolveTokenDeployParams(params);
  // The script: `realTV = tv == address(0) ? 0x721C...42e3 : tv`.
  const realTransferValidator =
    p.defaultTransferValidator.toLowerCase() === ZERO_ADDRESS
      ? CANONICAL_TRANSFER_VALIDATOR
      : p.defaultTransferValidator;
  const deploy: MintEvmCall = {
    to: p.router,
    data: encodeDeployToken(params),
    value: valueHex(p.pairedDepositWei),
  };
  // Calls 2-3 are OWNER ops signed by the treasury wallet: when the token is
  // launched with a different owner (the DAO) they would revert, so the owner
  // wires the validator itself.
  if (p.owner.toLowerCase() !== p.treasury.toLowerCase()) return [deploy];
  return [
    deploy,
    {
      to: p.tokenAddress,
      data: encodeSetTransferValidator(realTransferValidator),
      value: valueHex(0n),
    },
    {
      to: realTransferValidator,
      data: encodeSetRulesetOfCollection(
        p.tokenAddress,
        VANILLA_RULESET_ID,
        ZERO_ADDRESS,
        0n,
        0n,
      ),
      value: valueHex(0n),
    },
  ];
}

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
    to: resolveTokenDeployParams(params).factory,
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
export function decodeAddressWord(returnData: string): string {
  const word = returnData.replace(/^0x/, "").toLowerCase();
  if (word.length !== 64 || !/^[0-9a-f]*$/.test(word)) {
    throw new Error("expected a 32-byte return word");
  }
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) {
    throw new Error("expected a 32-byte address word");
  }
  return `0x${word.slice(24)}`;
}

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
