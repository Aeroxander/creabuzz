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
  abiEncode,
  abiEncodeCall,
  type AbiField,
  functionSelector,
} from "../../identity/lib/userop-abi.ts";

/** Canonical zero address — native pairing / "no validator yet" marker. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The TokenMaster router `DeployAppToken.s.sol` defaults to (APPTOKEN_ROUTER). */
export const DEFAULT_TOKENMASTER_ROUTER =
  "0x0E00009d00d1000069ed00A908e00081F5006008";

/**
 * The StandardPool factory `DeployAppToken.s.sol` defaults to
 * (APPTOKEN_STANDARD_FACTORY).
 */
export const DEFAULT_STANDARD_POOL_FACTORY =
  "0x000000c5F2DF717F497BeAcCE161F8b042310d17";

/**
 * The canonical creator-token Transfer Validator the deploy script wires when
 * APPTOKEN_TV is unset (`DeployAppToken.s.sol`, `realTV`).
 */
export const CANONICAL_TRANSFER_VALIDATOR =
  "0x721C008fdff27BF06E7E123956E2Fe03B63342e3";

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

/** `setTransferValidator(address)` — ERC-20C owner op on the new token. */
export const SIGNATURE_SET_TRANSFER_VALIDATOR = "setTransferValidator(address)";
/** `setRulesetOfCollection(address,uint8,address,uint8,uint16)` — TV ruleset. */
export const SIGNATURE_SET_RULESET_OF_COLLECTION =
  "setRulesetOfCollection(address,uint8,address,uint8,uint16)";
/**
 * `deployToken(...)` — TokenMaster router entry point
 * (`ITokenMasterRouter.deployToken(DeploymentParameters,SignatureECDSA)`).
 * Tuple types follow `tm-tokenmaster/src/DataTypes.sol` field order exactly.
 */
export const SIGNATURE_DEPLOY_TOKEN =
  "deployToken((address,bytes32,address,bool,bool," +
  "(string,string,uint8,address,address,uint256,bytes,address,bool,address,uint256),uint16)," +
  "(uint256,bytes32,bytes32))";

/**
 * `deployParams.maxInfrastructureFeeBPS` in `DeployAppToken.s.sol` (250) —
 * the cap `encodeDeployToken` bakes into the deploy call. A live router fee
 * above it makes `deployToken` revert (`InvalidInfrastructureFeeBPS`).
 */
export const MAX_INFRASTRUCTURE_FEE_BPS = 250n;

/**
 * Immutable pool ceilings (docs/dao-os.md R4), mirrored from
 * `contracts/script/DeployAppToken.s.sol` and desktop `evmCalls.ts` (pinned by
 * `mint-tx.test.mjs`). They used to be 10_000 / 9999 bps — "the owner may
 * charge a 100% fee" — a rug-capable configuration. Whoever owns the token can
 * move fees and spreads anywhere BELOW these, never above.
 */
export const MAX_TOKEN_FEE_BPS = 1_000n;
export const MAX_TOKEN_SPREAD_BPS = 1_000n;
/** Ceiling on the creator's spend share: equal to its initial value, so it can only go down. */
export const MAX_SPEND_CREATOR_SHARE_BPS = 5_000n;
export const INITIAL_SPEND_CREATOR_SHARE_BPS = 5_000n;

const TOKEN_DECIMALS = 18n; // the script hardcodes 18
const VANILLA_RULESET_ID = 1n; // open trading; tighten later via the validator

/** One unsigned call — the shape both senders receive unmodified. */
export interface MintEvmCall {
  to: string;
  data: string;
  value: string;
}

/** Inputs for {@link buildTokenDeployCalls} (desktop `TokenDeployCallsParams`). */
export interface TokenDeployCallsParams {
  /** `PoolDeploymentParameters.name`. */
  name: string;
  /** `PoolDeploymentParameters.symbol`. */
  symbol: string;
  /**
   * APPTOKEN_TREASURY — token `initialOwner` AND `initialSupplyRecipient`.
   * The deploy script requires broadcaster == treasury (the validator wiring
   * is an owner op); the signing account must be this address.
   */
  treasury: string;
  /**
   * The precomputed deterministic token address — `tokenAddress` in
   * `DeploymentParameters`. Derived from
   * `StandardPoolFactory.computeDeploymentAddress(...)` (a view call).
   */
  tokenAddress: string;
  /** APPTOKEN_SALT → `bytes32(tokenSalt)`. Default 1n (the script default). */
  salt?: bigint;
  /**
   * Initial supply in base units (18 decimals). The script computes
   * `APPTOKEN_INITIAL_SUPPLY * 1e18`; pass the product. Default 1_000_000e18.
   */
  initialSupplyAmount?: bigint;
  /**
   * APPTOKEN_PAIRED_DEPOSIT_WEI — the native starting reserve, sent as
   * `msg.value` with `deployToken` (native pairing requires it to be nonzero).
   * Default 0.1 ether.
   */
  pairedDepositWei?: bigint;
  /** APPTOKEN_SPREAD_BPS — initial buy+sell spread. Default 100. */
  spreadBps?: number;
  /** APPTOKEN_BUY_FEE_BPS — initial buy fee. Default 200. */
  buyFeeBps?: number;
  /** APPTOKEN_SELL_FEE_BPS — initial sell fee. Default 200. */
  sellFeeBps?: number;
  /**
   * APPTOKEN_TV — `poolParams.defaultTransferValidator`, exactly as the script
   * passes it (may be the zero address = no validator at construction). The
   * post-deploy wiring resolves the zero address to
   * {@link CANONICAL_TRANSFER_VALIDATOR}, mirroring the script's `realTV`.
   */
  defaultTransferValidator?: string;
  /** APPTOKEN_ROUTER — TokenMaster router. Default {@link DEFAULT_TOKENMASTER_ROUTER}. */
  router?: string;
  /** APPTOKEN_STANDARD_FACTORY. Default {@link DEFAULT_STANDARD_POOL_FACTORY}. */
  factory?: string;
  /**
   * APPTOKEN_OWNER — `poolParams.initialOwner`, the holder of the token's fee
   * and spread levers (below the immutable ceilings). Defaults to `treasury`.
   * Pass the DAO to launch DAO-owned. The transfer-validator wiring (calls 2-3
   * of {@link buildTokenDeployCalls}) is an OWNER op, so those calls are only
   * composed when the owner is the treasury wallet that signs. To hand a
   * treasury-owned token to the DAO after graduation use
   * {@link buildTransferTokenOwnershipCall}.
   */
  owner?: string;
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

function bytes32Hex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function zero32(): string {
  return `0x${"0".repeat(64)}`;
}

/**
 * `DeploymentParameters.poolParams.encodedInitializationArgs` — the script's
 * `abi.encode(StandardPoolInitializationParameters{...})`. All fields are
 * static, so the encoding is 28 flat words. Field order:
 * `pools/standard-token-pool/DataTypes.sol` (port of evmCalls.ts:690-775).
 */
function encodeStandardPoolInitArgs(p: ResolvedTokenDeployParams): string {
  const buyParams: AbiField = {
    kind: "tuple",
    fields: [
      { kind: "uint", value: BigInt(p.spreadBps) }, // buySpreadBPS
      { kind: "uint", value: BigInt(p.buyFeeBps) }, // buyFeeBPS
      { kind: "uint", value: 10n ** 18n }, // buyCostPairedTokenNumerator
      { kind: "uint", value: 10n ** 18n }, // buyCostPoolTokenDenominator
      { kind: "bool", value: false }, // useTargetSupply
      { kind: "uint", value: 0n }, // reserved
      { kind: "uint", value: 0n }, // buyDemandFeeBPS
      { kind: "uint", value: 0n }, // targetSupplyBaseline
      { kind: "uint", value: 0n }, // targetSupplyBaselineScaleFactor
      { kind: "uint", value: 0n }, // targetSupplyGrowthRatePerSecond
      { kind: "uint", value: 0n }, // targetSupplyBaselineTimestamp
    ],
  };
  const sellParams: AbiField = {
    kind: "tuple",
    fields: [
      { kind: "uint", value: BigInt(p.spreadBps) }, // sellSpreadBPS
      { kind: "uint", value: BigInt(p.sellFeeBps) }, // sellFeeBPS
    ],
  };
  const spendParams: AbiField = {
    kind: "tuple",
    fields: [{ kind: "uint", value: INITIAL_SPEND_CREATOR_SHARE_BPS }], // creatorShareBPS — script's 5000
  };
  return abiEncode([
    {
      kind: "tuple",
      fields: [
        { kind: "address", value: p.treasury }, // initialSupplyRecipient
        { kind: "uint", value: p.initialSupplyAmount },
        { kind: "uint", value: 0n }, // minBuySpreadBPS
        { kind: "uint", value: MAX_TOKEN_SPREAD_BPS }, // maxBuySpreadBPS
        { kind: "uint", value: MAX_TOKEN_FEE_BPS }, // maxBuyFeeBPS
        { kind: "uint", value: MAX_TOKEN_FEE_BPS }, // maxBuyDemandFeeBPS
        { kind: "uint", value: 0n }, // minSellSpreadBPS
        { kind: "uint", value: MAX_TOKEN_SPREAD_BPS }, // maxSellSpreadBPS
        { kind: "uint", value: MAX_TOKEN_FEE_BPS }, // maxSellFeeBPS
        { kind: "uint", value: MAX_SPEND_CREATOR_SHARE_BPS }, // maxSpendCreatorShareBPS
        { kind: "uint", value: 0n }, // creatorEmissionRateNumerator
        { kind: "uint", value: 1n }, // creatorEmissionRateDenominator
        { kind: "uint", value: 0n }, // creatorEmissionsHardCap
        buyParams, // initialBuyParameters
        sellParams, // initialSellParameters
        spendParams, // initialSpendParameters
        { kind: "uint", value: 0n }, // initialPausedState
      ],
    },
  ]);
}

/**
 * ABI-encode `router.deployToken{value: pairedDepositWei}(deployParams,
 * SignatureECDSA({v: 0, r: 0, s: 0}))` — the deploy script's one router call.
 * The empty signature matches the script (permissionless on fresh/local
 * deployments). Struct field order: `tm-tokenmaster/src/DataTypes.sol`.
 */
export function encodeDeployToken(params: TokenDeployCallsParams): string {
  const p = resolveTokenDeployParams(params);
  return abiEncodeCall(SIGNATURE_DEPLOY_TOKEN, [
    {
      kind: "tuple",
      fields: [
        { kind: "address", value: p.factory }, // tokenFactory
        { kind: "bytes32", value: bytes32Hex(p.salt) }, // tokenSalt
        { kind: "address", value: p.tokenAddress },
        { kind: "bool", value: false }, // blockTransactionsFromUntrustedChannels
        { kind: "bool", value: false }, // restrictPairingToLists
        {
          kind: "tuple",
          fields: [
            { kind: "string", value: p.name },
            { kind: "string", value: p.symbol },
            { kind: "uint", value: TOKEN_DECIMALS }, // tokenDecimals — 18
            { kind: "address", value: p.owner }, // initialOwner (APPTOKEN_OWNER)
            { kind: "address", value: ZERO_ADDRESS }, // pairedToken — native
            { kind: "uint", value: p.pairedDepositWei },
            {
              kind: "bytes",
              value: encodeStandardPoolInitArgs(p),
            }, // encodedInitializationArgs
            { kind: "address", value: p.defaultTransferValidator },
            { kind: "bool", value: false }, // useRouterForPairedTransfers
            { kind: "address", value: ZERO_ADDRESS }, // partnerFeeRecipient
            { kind: "uint", value: 0n }, // partnerFeeBPS
          ],
        }, // poolParams
        { kind: "uint", value: MAX_INFRASTRUCTURE_FEE_BPS },
      ],
    }, // DeploymentParameters
    {
      kind: "tuple",
      fields: [
        { kind: "uint", value: 0n },
        { kind: "bytes32", value: zero32() },
        { kind: "bytes32", value: zero32() },
      ],
    }, // empty signature
  ]);
}

/** ABI-encode `token.setTransferValidator(validator)` (ERC-20C owner op). */
export function encodeSetTransferValidator(validator: string): string {
  return abiEncodeCall(SIGNATURE_SET_TRANSFER_VALIDATOR, [
    { kind: "address", value: validator },
  ]);
}

/**
 * ABI-encode `validator.setRulesetOfCollection(collection, rulesetId,
 * customRuleset, globalOptions, rulesetOptions)` (the deploy script's pinned
 * `IValidatorRuleset` surface).
 */
export function encodeSetRulesetOfCollection(
  collection: string,
  rulesetId: bigint,
  customRuleset: string,
  globalOptions: bigint,
  rulesetOptions: bigint,
): string {
  return abiEncodeCall(SIGNATURE_SET_RULESET_OF_COLLECTION, [
    { kind: "address", value: collection },
    { kind: "uint", value: rulesetId },
    { kind: "address", value: customRuleset },
    { kind: "uint", value: globalOptions },
    { kind: "uint", value: rulesetOptions },
  ]);
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

/** ABI-encode Ownable `transferOwnership(newOwner)` (`cast`: `0xf2fde38b`). */
export function encodeTransferOwnership(newOwner: string): string {
  return abiEncodeCall("transferOwnership(address)", [
    { kind: "address", value: newOwner },
  ]);
}

/**
 * `token.transferOwnership(dao)` — hands a treasury-owned apptoken to the DAO
 * (the holder of the fee/spread levers) once the launch has graduated.
 * Owner-only: the current owner (the treasury wallet) must sign it.
 */
export function buildTransferTokenOwnershipCall(
  token: string,
  newOwner: string,
): MintEvmCall {
  return {
    to: token,
    data: encodeTransferOwnership(newOwner),
    value: valueHex(0n),
  };
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
    detail: `The launch record's treasury (${recorded}) is not your wallet (${wallet}). In v1 the deploying wallet must be the treasury — steps 2-3 (transfer validator, trading ruleset) are token-owner operations. Update the launch's treasury to your wallet address (Edit terms), then deploy.`,
  };
}
