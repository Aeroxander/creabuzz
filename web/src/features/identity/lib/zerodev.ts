/**
 * ZeroDev hosted bundler + paymaster client (wave 4c).
 *
 * Every wire shape below was DISCOVERED (docs fetch, published SDK source,
 * or live authenticated probing with the real project credentials) — never
 * invented. The ledger (each claim cites its source):
 *
 * 1. RPC URL: `https://rpc.zerodev.app/api/v3/<projectId>/chain/<chainId>` —
 *    chain id is part of the path, and **the same URL serves bundler and
 *    paymaster** methods:
 *    - https://docs.zerodev.app/api-and-toolings/infrastructure/rpcs
 *      ("Configuring the RPC for a specific infra provider" shows
 *      `https://rpc.zerodev.app/api/v3/xxxxxf2d-…-90cc-…x007/chain/42161`
 *      and the `?provider=` query param: ULTRA_RELAY | ALCHEMY | GELATO |
 *      PIMLICO)
 *    - https://docs.zerodev.app/api-and-toolings/infrastructure/intro
 *      ("The same RPC can be used as both bundler and paymaster RPCs")
 *    - The legacy `api/v2/{bundler,paymaster}/<projectId>` URLs exist but
 *      reject requests with `{"error":"ChainId not found not found for
 *      projectId …"}` unless the project carries a default chain (live
 *      probe 2026-09-24), so the v3 chain-in-path URL is the reliable form.
 *
 * 2. API key transport: query `?apikey=<key>` **and** header
 *    `X-API-Key: <key>` are both accepted (live probes: identical responses
 *    with either, and with neither). Neither transport was enforced on the
 *    probed methods (`eth_supportedEntryPoints`,
 *    `eth_estimateUserOperationGas` — a garbage key was not rejected), so
 *    the key is sent BOTH ways here for forward compatibility; do not treat
 *    a successful call as proof the key was checked. Vite embeds `VITE_*`
 *    values in the client bundle — ZeroDev project keys are
 *    client-publishable by design (the project id already appears in every
 *    browser RPC call), but VALUES ARE NEVER COMMITTED to this repo.
 *
 * 3. Bundler RPC methods (`eth_supportedEntryPoints`,
 *    `eth_estimateUserOperationGas`, `eth_sendUserOperation`,
 *    `eth_getUserOperationReceipt`) take the **ERC-4337 v0.7-style
 *    UNPACKED** user operation JSON (viem `UserOperationRequest<"0.7">`):
 *    `sender, nonce, factory?, factoryData?, callData, callGasLimit,
 *    verificationGasLimit, preVerificationGas, maxFeePerGas,
 *    maxPriorityFeePerGas, paymaster?, paymasterVerificationGasLimit?,
 *    paymasterPostOpGasLimit?, paymasterData?, signature`. The packed struct
 *    (`initCode`/`accountGasLimits`/`gasFees`/`paymasterAndData`) is
 *    REJECTED: live probe returned `{"error":{"message":"Validation error:
 *    Unrecognized keys: \"initCode\", \"accountGasLimits\", \"gasFees\",
 *    \"paymasterAndData\" at \"params[0].userOp\"","code":-32601}}` while
 *    the unpacked form reached bundler simulation
 *    (`AA13 initCode failed or OOG`, code -32500 — the expected outcome for
 *    a probe op with garbage initcode).
 *
 * 4. Sponsorship RPC: `zd_sponsorUserOperation` with `params[0] =
 *    { chainId: number, userOp, entryPointAddress, gasTokenData?,
 *    shouldOverrideFee?, manualGasEstimation?, shouldConsume? }` and
 *    response `{ preVerificationGas, verificationGasLimit, callGasLimit,
 *    paymaster, paymasterVerificationGasLimit, paymasterPostOpGasLimit,
 *    paymasterData, maxFeePerGas?, maxPriorityFeePerGas? }`:
 *    - @zerodev/sdk@5.5.10 `types/kernel.ts` (`ZeroDevPaymasterRpcSchema`,
 *      `zd_sponsorUserOperation`) and `clients/decorators/kernel.ts`
 *      (`zerodevPaymasterActions.sponsorUserOperation`) — the published
 *      ZeroDev SDK source, inspected from the npm registry.
 *    - Gas estimation policy (discovered): the schema types the request's
 *      `callGasLimit`/`preVerificationGas`/`verificationGasLimit` (and the
 *      two paymaster limits) as `PartialBy` — OMITTABLE — and RETURNS all
 *      of them: the paymaster simulates and estimates server-side unless
 *      `manualGasEstimation: true`. A standalone
 *      `eth_estimateUserOperationGas` on an un-sponsored, unfunded op fails
 *      `AA21 didn't pay prefund` (live probe) — so for sponsored ops the
 *      sponsor response IS the gas estimation. Dummy-signature policy: the
 *      validator's stub goes into the sponsor simulation (the deployed
 *      V0_0_3_PATCHED stub is pinned in `zerodev-smoke.mjs`).
 *    - Live probe confirmed the validator: `chainId` must be a NUMBER
 *      (`"0xaa36a7"` → `Validation errors: … "params[0].chainId"`),
 *      `maxFeePerGas`/`maxPriorityFeePerGas` must be present, and the
 *      packed keys must be absent. Simulation/policy failures arrive as
 *      HTTP 400 WITH a JSON body (`{"error":"UserOperation reverted during
 *      simulation with reason: AA13 …"}`) — the body is the real error.
 *
 * 5. Entry points (live `eth_supportedEntryPoints` on Sepolia through the
 *    v3 URL, 2026-09-24): v0.6 `0x5FF1…2789`, v0.7
 *    `0x0000000071727De22E5E9d8BAf0edAc6f37da032`, **v0.8.0
 *    `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`**, and v0.9
 *    `0x433709009B8330FDa32311DF1C2AFA402eD8D009`. EntryPoint v0.8.0 (our
 *    core) is supported — no version adaptation needed at the cloud level.
 *
 * 6. Gas policies / denial UX: sponsorship requires a dashboard policy
 *    (https://docs.zerodev.app/api-and-toolings/infrastructure/gas-policies;
 *    https://docs.zerodev.app/get-started/sdks/setup-project "toggle Sponsor
 *    all transactions"). Policy denials surface as `PaymasterDeniedError`
 *    with the exact dashboard action; every error keeps the raw server
 *    message (Review-Proven Rule 1 — never swallow the failure).
 */
import type {
  BundlerConfig,
  BundlerTransport,
  UserOperationGasEstimate,
  UserOperationReceipt,
} from "./aa.ts";
import { createBundlerTransport } from "./aa.ts";
import type { PackedUserOperation } from "./userop.ts";
import {
  getUserOpHash,
  packAccountGasLimits,
  packGasFees,
  unpackUints,
} from "./userop.ts";

/** EntryPoint v0.7 (canonical; live `eth_supportedEntryPoints`). */
export const ENTRY_POINT_V0_7 = "0x0000000071727de22e5e9d8baf0edac6f37da032";

/** EntryPoint v0.8.0 (canonical; live `eth_supportedEntryPoints`). */
export const ENTRY_POINT_V0_8 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";

/** ZeroDev RPC host (`/api/v3/<projectId>/chain/<chainId>`). */
export const ZERODEV_RPC_HOST = "https://rpc.zerodev.app";

/** Thrown when the ZeroDev project id (or chain id) is not configured. */
export class ZerodevNotConfiguredError extends Error {
  constructor(missing: string) {
    super(
      `zerodev: ${missing} is not configured — set VITE_ZERODEV_PROJECT_ID / ` +
        "VITE_ZERODEV_CHAIN_ID (build-time env; Vite embeds VITE_* in the " +
        "client bundle) or pass a ZerodevConfig",
    );
    this.name = "ZerodevNotConfiguredError";
  }
}

/** Exact dashboard action surfaced with every sponsorship policy denial. */
export const PAYMASTER_DENIED_DASHBOARD_ACTION =
  "ZeroDev dashboard → your project → Gas Policies → select the target " +
  "network → enable “Sponsor all transactions” (or add a policy covering " +
  "this sender/sender-type). " +
  "(https://docs.zerodev.app/api-and-toolings/infrastructure/gas-policies)";

/**
 * `zd_sponsorUserOperation` refused to sponsor. `serverMessage` is the raw
 * upstream error (never paraphrased away); `dashboardAction` is the
 * operator step that unblocks it.
 */
export class PaymasterDeniedError extends Error {
  readonly serverMessage: string;
  readonly dashboardAction: string;

  constructor(serverMessage: string) {
    super(
      `zerodev: paymaster denied sponsorship: ${serverMessage} — ` +
        PAYMASTER_DENIED_DASHBOARD_ACTION,
    );
    this.name = "PaymasterDeniedError";
    this.serverMessage = serverMessage;
    this.dashboardAction = PAYMASTER_DENIED_DASHBOARD_ACTION;
  }
}

export interface ZerodevConfig {
  /** ZeroDev project id (public by design; never hardcode values). */
  projectId?: string | undefined;
  /** Project API key (sent as `?apikey=` and `X-API-Key`). */
  apiKey?: string | undefined;
  /** Chain id the RPC URL targets (e.g. 11155111 for Sepolia). */
  chainId?: number | undefined;
  /** Per-attempt timeout. Default 15000 ms. */
  timeoutMs?: number;
  /** Total attempts (first try + retries). Default 3; always ≥ 1. */
  maxAttempts?: number;
  /** First backoff delay; doubles per attempt, capped at 2000 ms. */
  backoffMs?: number;
  /** Injection seam for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Config from the Vite build-time env (`VITE_ZERODEV_PROJECT_ID`,
 * `VITE_ZERODEV_API_KEY`, `VITE_ZERODEV_CHAIN_ID`). Optional chaining keeps
 * this module importable outside Vite (node unit tests and the smoke
 * script), same pattern as `bundlerUrlFromEnv` in `aa.ts`.
 */
export function zerodevConfigFromEnv(): ZerodevConfig {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const chainIdRaw = env?.VITE_ZERODEV_CHAIN_ID;
  return {
    projectId: env?.VITE_ZERODEV_PROJECT_ID,
    apiKey: env?.VITE_ZERODEV_API_KEY,
    chainId: chainIdRaw === undefined ? undefined : Number(chainIdRaw),
  };
}

/** `https://rpc.zerodev.app/api/v3/<projectId>/chain/<chainId>?apikey=…` */
export function zerodevRpcUrl(config: ZerodevConfig): string {
  const projectId = config.projectId ?? zerodevConfigFromEnv().projectId;
  const chainId = config.chainId ?? zerodevConfigFromEnv().chainId;
  if (projectId === undefined || projectId === "") {
    throw new ZerodevNotConfiguredError("VITE_ZERODEV_PROJECT_ID");
  }
  if (chainId === undefined || !Number.isInteger(chainId) || chainId <= 0) {
    throw new ZerodevNotConfiguredError("VITE_ZERODEV_CHAIN_ID");
  }
  const base = `${ZERODEV_RPC_HOST}/api/v3/${projectId}/chain/${chainId}`;
  const apiKey = config.apiKey ?? zerodevConfigFromEnv().apiKey;
  return apiKey === undefined || apiKey === ""
    ? base
    : `${base}?apikey=${encodeURIComponent(apiKey)}`;
}

/** `X-API-Key` header when an API key is configured (see ledger item 2). */
export function zerodevHeaders(config: ZerodevConfig): Record<string, string> {
  const apiKey = config.apiKey ?? zerodevConfigFromEnv().apiKey;
  return apiKey === undefined || apiKey === "" ? {} : { "X-API-Key": apiKey };
}

/**
 * ERC-4337 v0.7-style unpacked user operation — the wire shape ZeroDev's
 * bundler/paymaster accepts (ledger item 3). Optional fields are omitted
 * entirely when absent (the gateway rejects `null`).
 */
export interface RpcUserOperation {
  sender: string;
  nonce: string;
  factory?: string | undefined;
  factoryData?: string | undefined;
  callData: string;
  /** Omit in `zd_sponsorUserOperation` requests (schema `PartialBy`). */
  callGasLimit?: string | undefined;
  verificationGasLimit?: string | undefined;
  preVerificationGas?: string | undefined;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster?: string | undefined;
  paymasterVerificationGasLimit?: string | undefined;
  paymasterPostOpGasLimit?: string | undefined;
  paymasterData?: string | undefined;
  signature: string;
}

function requireHex(value: string, what: string, byteLength?: number): void {
  const expected = byteLength === undefined ? "" : String(byteLength * 2);
  const pattern =
    byteLength === undefined
      ? /^0x[0-9a-fA-F]*$/
      : new RegExp(`^0x[0-9a-fA-F]{${expected}}$`);
  if (!pattern.test(value)) {
    throw new Error(
      `zerodev: ${what} must be a 0x hex string${
        byteLength === undefined ? "" : ` of ${byteLength} bytes`
      }, got ${value}`,
    );
  }
}

/**
 * Packed struct ⇄ unpacked wire. `initCode = factory ‖ factoryData`;
 * `paymasterAndData = paymaster(20) ‖ paymasterVerificationGasLimit(16) ‖
 * paymasterPostOpGasLimit(16) ‖ paymasterData` — the v0.7/v0.8
 * `UserOperationLib` offsets (`PAYMASTER_VALIDATION_GAS_OFFSET = 20`,
 * `PAYMASTER_POSTOP_GAS_OFFSET = 36`, `PAYMASTER_DATA_OFFSET = 52`; see
 * https://raw.githubusercontent.com/eth-infinitism/account-abstraction/v0.9.0/contracts/core/UserOperationLib.sol).
 */
export function toRpcUserOperation(
  packed: PackedUserOperation,
): RpcUserOperation {
  requireHex(packed.initCode, "initCode");
  requireHex(packed.paymasterAndData, "paymasterAndData");
  const gas = unpackUints(packed.accountGasLimits);
  const fees = unpackUints(packed.gasFees);
  const initCodeBody = packed.initCode.slice(2);
  const pm = packed.paymasterAndData.slice(2);

  const rpc: RpcUserOperation = {
    sender: packed.sender,
    nonce: packed.nonce,
    callData: packed.callData,
    callGasLimit: `0x${gas.low128.toString(16)}`,
    verificationGasLimit: `0x${gas.high128.toString(16)}`,
    preVerificationGas: packed.preVerificationGas,
    maxFeePerGas: `0x${fees.low128.toString(16)}`,
    maxPriorityFeePerGas: `0x${fees.high128.toString(16)}`,
    signature: packed.signature,
  };
  if (initCodeBody.length > 0) {
    if (initCodeBody.length < 40) {
      throw new Error("zerodev: initCode shorter than its factory prefix");
    }
    rpc.factory = `0x${initCodeBody.slice(0, 40)}`;
    const data = `0x${initCodeBody.slice(40)}`;
    if (data !== "0x") {
      rpc.factoryData = data;
    }
  }
  if (pm.length > 0) {
    if (pm.length < 104) {
      throw new Error("zerodev: paymasterAndData shorter than 52 bytes");
    }
    rpc.paymaster = `0x${pm.slice(0, 40)}`;
    rpc.paymasterVerificationGasLimit = `0x${BigInt(
      `0x${pm.slice(40, 72)}`,
    ).toString(16)}`;
    rpc.paymasterPostOpGasLimit = `0x${BigInt(
      `0x${pm.slice(72, 104)}`,
    ).toString(16)}`;
    const data = `0x${pm.slice(104)}`;
    if (data !== "0x") {
      rpc.paymasterData = data;
    }
  }
  return rpc;
}

/** `zd_sponsorUserOperation` response (ledger item 4). */
export interface SponsorshipResult {
  preVerificationGas: string;
  verificationGasLimit: string;
  callGasLimit: string;
  paymaster: string;
  paymasterVerificationGasLimit?: string | undefined;
  paymasterPostOpGasLimit?: string | undefined;
  paymasterData: string;
  maxFeePerGas?: string | undefined;
  maxPriorityFeePerGas?: string | undefined;
}

/** `zd_sponsorUserOperation` params[0] (ledger item 4). */
export interface SponsorshipRequest {
  chainId: number;
  userOp: RpcUserOperation;
  entryPointAddress: string;
  shouldOverrideFee?: boolean | undefined;
  /** true = trust the caller's gas fields instead of server estimation. */
  manualGasEstimation?: boolean | undefined;
  shouldConsume?: boolean | undefined;
}

function toU128Hex(value: string | undefined): string {
  const n = value === undefined ? 0n : BigInt(value);
  // paymasterAndData packs the two gas limits as TIGHT u128 values — 16
  // bytes / 32 hex chars each (UserOperationLib bytes 20..36 and 36..52),
  // NOT full ABI words.
  return n.toString(16).padStart(32, "0");
}

/** Pack `paymaster ‖ u128 ‖ u128 ‖ paymasterData` (v0.7/v0.8 layout). */
export function packPaymasterAndData(result: {
  paymaster: string;
  paymasterVerificationGasLimit?: string | undefined;
  paymasterPostOpGasLimit?: string | undefined;
  paymasterData?: string | undefined;
}): string {
  requireHex(result.paymaster, "paymaster", 20);
  requireHex(result.paymasterData ?? "0x", "paymasterData");
  return `0x${result.paymaster.slice(2).toLowerCase()}${toU128Hex(
    result.paymasterVerificationGasLimit,
  )}${toU128Hex(result.paymasterPostOpGasLimit)}${(result.paymasterData ?? "0x")
    .slice(2)
    .toLowerCase()}`;
}

/**
 * Fold a sponsorship into the packed op: paymaster fields + the paymaster's
 * gas/fee values. The result is the FINAL op — its hash is what the account
 * signs (fees and paymaster data are inside the signed struct hash).
 */
export function applySponsorship(
  packed: PackedUserOperation,
  sponsorship: SponsorshipResult,
): PackedUserOperation {
  const verificationGasLimit = BigInt(sponsorship.verificationGasLimit);
  const callGasLimit = BigInt(sponsorship.callGasLimit);
  const maxPriorityFeePerGas =
    sponsorship.maxPriorityFeePerGas === undefined
      ? unpackUints(packed.gasFees).high128
      : BigInt(sponsorship.maxPriorityFeePerGas);
  const maxFeePerGas =
    sponsorship.maxFeePerGas === undefined
      ? unpackUints(packed.gasFees).low128
      : BigInt(sponsorship.maxFeePerGas);
  return {
    ...packed,
    preVerificationGas: sponsorship.preVerificationGas,
    accountGasLimits: packAccountGasLimits({
      verificationGasLimit,
      callGasLimit,
    }),
    gasFees: packGasFees({ maxPriorityFeePerGas, maxFeePerGas }),
    paymasterAndData: packPaymasterAndData({
      paymaster: sponsorship.paymaster,
      paymasterVerificationGasLimit: sponsorship.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: sponsorship.paymasterPostOpGasLimit,
      paymasterData: sponsorship.paymasterData,
    }),
  };
}

/**
 * Policy-denial classifier — scans the SERVER TEXT only (never the method
 * name). Exact denial strings are dashboard-version dependent (none is
 * published), so this only reclassifies the error TYPE; the raw
 * `serverMessage` is always preserved on the thrown error and callers
 * (e.g. the smoke script) print it verbatim (Rule 1). Simulation failures
 * (AA13/AA21/AA24 …) are deliberately NOT policy denials.
 */
function looksLikePolicyDenial(message: string): boolean {
  return /polic|denied|forbid|unauthor|not allowed|exceed|quota/i.test(message);
}

/**
 * `zd_sponsorUserOperation` against the hosted paymaster. Bounded like the
 * bundler transport (Rule 4): per-attempt timeout, bounded retries with
 * backoff for 429/5xx/network blips, terminal typed errors.
 */
export async function sponsorUserOperation(
  config: ZerodevConfig,
  request: SponsorshipRequest,
  transport?: BundlerTransport,
): Promise<SponsorshipResult> {
  const client =
    transport ??
    createBundlerTransport({
      url: zerodevRpcUrl(config),
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      backoffMs: config.backoffMs,
      fetchImpl: config.fetchImpl,
    });
  try {
    const result = await client.request<SponsorshipResult>(
      "zd_sponsorUserOperation",
      [
        {
          chainId: request.chainId,
          userOp: request.userOp,
          entryPointAddress: request.entryPointAddress,
          shouldOverrideFee: request.shouldOverrideFee ?? false,
          manualGasEstimation: request.manualGasEstimation ?? false,
          shouldConsume: request.shouldConsume ?? true,
        },
      ],
    );
    if (
      typeof result?.paymaster !== "string" ||
      typeof result?.paymasterData !== "string"
    ) {
      throw new Error(
        `zerodev: zd_sponsorUserOperation returned an unexpected shape: ${JSON.stringify(result)}`,
      );
    }
    return result;
  } catch (error) {
    const message = (error as Error).message;
    // aa.ts wraps upstream errors as `bundler: <method> RPC error <server>`
    // or `… HTTP <status>: <body>`; the message already carries the raw
    // server text verbatim (Rule 1) — classify on it as-is.
    const rpcError = / RPC error ([\s\S]*)$/.exec(message);
    const serverMessage = rpcError === null ? message : rpcError[1];
    if (looksLikePolicyDenial(serverMessage)) {
      throw new PaymasterDeniedError(serverMessage);
    }
    throw error;
  }
}

/** Passkey-style signer port: userOpHash → validator signature bytes. */
export type SignUserOpHash = (opHash: string) => string | Promise<string>;

/** Hash port; defaults to `getUserOpHash` (EntryPoint v0.8.0 EIP-712). */
export type HashUserOp = (
  userOp: PackedUserOperation,
  entryPoint: string,
  chainId: bigint,
) => string | Promise<string>;

export interface SponsoredUserOpRequest {
  config: ZerodevConfig;
  /** EntryPoint the account is wired to (e.g. `ENTRY_POINT_V0_8`). */
  entryPointAddress: string;
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  /** Fee ceiling the user signs for (maxFeePerGas / priority fee). */
  fees: { maxFeePerGas: string; maxPriorityFeePerGas: string };
  /** Validator-specific stub for the sponsor simulation (ledger item 4). */
  dummySignature: string;
  /** Signs the FINAL op hash (after sponsorship fields are folded in). */
  signUserOpHash: SignUserOpHash;
  /**
   * Manual gas limits — sent WITH `manualGasEstimation: true` so the
   * paymaster trusts them. Omitted → the paymaster estimates (its response
   * carries the gas fields).
   */
  gas?: Partial<UserOperationGasEstimate> | undefined;
  /** Hash override (e.g. the v0.7 triple-hash for v0.7-wired accounts). */
  hashUserOp?: HashUserOp | undefined;
  /** Receipt polling bounds (Rule 4). Defaults: 2000 ms × 90 polls. */
  receipt?: { pollIntervalMs?: number; maxPolls?: number } | undefined;
  /** Injection seam for tests. */
  transport?: BundlerTransport | undefined;
}

export interface SponsoredUserOpResult {
  opHash: string;
  userOp: PackedUserOperation;
  rpcUserOperation: RpcUserOperation;
  sponsorship: SponsorshipResult;
  gas: UserOperationGasEstimate;
  receipt: UserOperationReceipt;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLLS = 90;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The full hosted flow: build → sponsor (server-side simulation + gas
 * estimation fills `paymasterAndData` + limits) → sign the FINAL hash →
 * submit → bounded receipt polling. One op, one atomic submission; every
 * step bounded (Rule 4) and every failure typed. A standalone
 * `eth_estimateUserOperationGas` is deliberately NOT called for sponsored
 * ops — it reverts `AA21 didn't pay prefund` on unfunded accounts (live
 * probe) and the sponsor response already returns the estimates.
 */
export async function sendSponsoredUserOp(
  request: SponsoredUserOpRequest,
): Promise<SponsoredUserOpResult> {
  const config = request.config;
  const chainId = config.chainId ?? zerodevConfigFromEnv().chainId;
  if (chainId === undefined || !Number.isInteger(chainId) || chainId <= 0) {
    throw new ZerodevNotConfiguredError("VITE_ZERODEV_CHAIN_ID");
  }
  const transport =
    request.transport ??
    createBundlerTransport({
      url: zerodevRpcUrl(config),
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      backoffMs: config.backoffMs,
      fetchImpl: config.fetchImpl,
      userOpEncoder: toRpcUserOperation,
    });

  // 1. Skeleton op with the signer's fee ceiling and dummy signature. Gas
  //    limits seed `manualGasEstimation` runs only; the default flow lets
  //    the paymaster estimate (schema `PartialBy`, ledger item 4).
  const skeleton: PackedUserOperation = {
    sender: request.sender,
    nonce: request.nonce,
    initCode: request.initCode,
    callData: request.callData,
    accountGasLimits: packAccountGasLimits({
      verificationGasLimit: BigInt(request.gas?.verificationGasLimit ?? "0x0"),
      callGasLimit: BigInt(request.gas?.callGasLimit ?? "0x0"),
    }),
    preVerificationGas: request.gas?.preVerificationGas ?? "0x0",
    gasFees: packGasFees({
      maxPriorityFeePerGas: BigInt(request.fees.maxPriorityFeePerGas),
      maxFeePerGas: BigInt(request.fees.maxFeePerGas),
    }),
    paymasterAndData: "0x",
    signature: request.dummySignature,
  };

  // 2. Sponsorship simulates + estimates + fills paymaster fields.
  const sponsorOp = toRpcUserOperation(skeleton);
  if (request.gas === undefined) {
    // PartialBy fields: omitted → the paymaster estimates them.
    delete sponsorOp.preVerificationGas;
    delete sponsorOp.verificationGasLimit;
    delete sponsorOp.callGasLimit;
  }
  const sponsorship = await sponsorUserOperation(
    config,
    {
      chainId,
      userOp: sponsorOp,
      entryPointAddress: request.entryPointAddress,
      manualGasEstimation: request.gas !== undefined,
    },
    transport,
  );
  const sponsored = applySponsorship(skeleton, sponsorship);
  const gas: UserOperationGasEstimate = {
    preVerificationGas: sponsored.preVerificationGas,
    verificationGasLimit: `0x${unpackUints(sponsored.accountGasLimits).high128.toString(16)}`,
    callGasLimit: `0x${unpackUints(sponsored.accountGasLimits).low128.toString(16)}`,
  };

  // 4. Sign the FINAL hash, then submit and poll (bounded).
  const hashUserOp = request.hashUserOp ?? defaultHashUserOp;
  const opHash = await hashUserOp(
    sponsored,
    request.entryPointAddress,
    BigInt(chainId),
  );
  const signature = await request.signUserOpHash(opHash);
  const finalOp: PackedUserOperation = { ...sponsored, signature };
  const submittedHash = await transport.sendUserOperation(
    finalOp,
    request.entryPointAddress,
  );
  if (submittedHash.toLowerCase() !== opHash.toLowerCase()) {
    throw new Error(
      `zerodev: bundler returned userOpHash ${submittedHash}, expected ${opHash}`,
    );
  }

  const pollIntervalMs =
    request.receipt?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPolls = Math.max(1, request.receipt?.maxPolls ?? DEFAULT_MAX_POLLS);
  let receipt: UserOperationReceipt | null = null;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    receipt = await transport.getUserOperationReceipt(opHash);
    if (receipt !== null) {
      break;
    }
    await sleep(pollIntervalMs);
  }
  if (receipt === null) {
    throw new Error(
      `zerodev: no receipt for ${opHash} after ${maxPolls} polls ` +
        `(${pollIntervalMs} ms apart)`,
    );
  }

  return {
    opHash,
    userOp: finalOp,
    rpcUserOperation: toRpcUserOperation(finalOp),
    sponsorship,
    gas,
    receipt,
  };
}

/** EntryPoint v0.8.0 EIP-712 hash (the canonical core). */
function defaultHashUserOp(
  userOp: PackedUserOperation,
  entryPoint: string,
  chainId: bigint,
): string {
  return getUserOpHash(userOp, entryPoint, chainId);
}

/** BundlerConfig shim type for callers configuring transports explicitly. */
export type ZerodevBundlerConfig = BundlerConfig;
