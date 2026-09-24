/**
 * ERC-4337 transports and counterfactual sender derivation.
 *
 * Two submission paths (the locked wave-4b decisions):
 *
 * a) **Self-bundling**: compose `EntryPoint.handleOps(PackedUserOperation[],
 *    address beneficiary)` calldata and hand it to an injected
 *    `SubmitTransaction` port (unsigned transaction only — the injected
 *    wallet signs, exactly like `web/src/features/launchpad/ui/RecordBidDialog.tsx`
 *    sends `eth_sendTransaction`). Selector `0x449fd934` derived with
 *    `cast sig "handleOps(((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))[],address)"`
 *    and golden-tested against `cast abi-encode`.
 *
 * b) **Standard bundler RPC**: `eth_sendUserOperation`,
 *    `eth_estimateUserOperationGas`, `eth_getUserOperationReceipt` per the
 *    ERC-4337 bundler spec. Every call is bounded: per-attempt timeout,
 *    capped exponential backoff between attempts, hard attempt limit, and a
 *    terminal typed error (Review-Proven Rules 1 and 4 — retries never loop
 *    forever and a failure never resolves as success).
 *
 * Counterfactual sender derivation follows the ERC-4337 `getSenderAddress`
 * flow: `EntryPoint.getSenderAddress(initCode)` always reverts with
 * `SenderAddressResult(address)` (IEntryPoint v0.8.0, lines 165 + 239), and
 * the address is read out of the revert payload.
 *
 * Sources:
 * - https://github.com/eth-infinitism/account-abstraction/blob/v0.8.0/contracts/interfaces/IEntryPoint.sol
 * - ERC-4337 bundler RPC: https://eips.ethereum.org/EIPS/eip-4337 and
 *   https://www.erc4337.io/docs/bundler/specification
 * - Paymasters are explicitly out of scope for wave 4b (`paymasterAndData`
 *   must stay empty for these transports to be meaningful).
 */
import type { AbiField } from "./userop-abi.ts";
import { abiEncodeCall, decodeAddressError } from "./userop-abi.ts";
import type { PackedUserOperation } from "./userop.ts";

/** An unsigned transaction request, wallet-signed at submission. */
export interface TransactionRequest {
  to: string;
  data: string;
  value?: string;
  from?: string;
}

/** Port: submit `tx`, resolve with the transaction hash. */
export type SubmitTransaction = (tx: TransactionRequest) => Promise<string>;

/**
 * Port: `eth_call`-style read. Resolves with raw return data on success;
 * throws `EthCallRevertError` (carrying the revert payload) on revert —
 * `getSenderAddress` relies on the revert payload.
 */
export type EthCall = (tx: { to: string; data: string }) => Promise<string>;

/** Minimal EIP-1193 provider surface used by the adapters. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export class EthCallRevertError extends Error {
  readonly data: string;

  constructor(message: string, data: string) {
    super(message);
    this.name = "EthCallRevertError";
    this.data = data;
  }
}

/** The bundler URL is not configured (`VITE_BUNDLER_URL` / config). */
export class BundlerNotConfiguredError extends Error {
  constructor() {
    super(
      "bundler: no URL configured — set VITE_BUNDLER_URL or pass { url } " +
        "(paymaster transport is a later wave)",
    );
    this.name = "BundlerNotConfiguredError";
  }
}

/** A JSON-RPC or HTTP failure from the bundler. */
export class BundlerRpcError extends Error {
  readonly code: number | undefined;

  /** Whether the request may be retried (HTTP-layer failures only). */
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: { code?: number; retryable?: boolean },
  ) {
    super(message);
    this.name = "BundlerRpcError";
    this.code = options?.code;
    this.retryable = options?.retryable ?? false;
  }
}

/** The bundler did not answer within the per-attempt timeout. */
export class BundlerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`bundler: request timed out after ${timeoutMs}ms`);
    this.name = "BundlerTimeoutError";
  }
}

/** `handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)`. */
export const HANDLE_OPS_SIGNATURE =
  "handleOps(((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))[],address)";

/** `getSenderAddress(bytes)`. */
export const GET_SENDER_ADDRESS_SIGNATURE = "getSenderAddress(bytes)";

/** `SenderAddressResult(address)` — the deliberate revert of the flow above. */
export const SENDER_ADDRESS_RESULT_SIGNATURE = "SenderAddressResult(address)";

const packedUserOpFields = (op: PackedUserOperation): AbiField[] => [
  { kind: "address", value: op.sender },
  { kind: "uint", value: BigInt(op.nonce) },
  { kind: "bytes", value: op.initCode },
  { kind: "bytes", value: op.callData },
  { kind: "bytes32", value: op.accountGasLimits },
  { kind: "uint", value: BigInt(op.preVerificationGas) },
  { kind: "bytes32", value: op.gasFees },
  { kind: "bytes", value: op.paymasterAndData },
  { kind: "bytes", value: op.signature },
];

/** Compose `EntryPoint.handleOps(userOps, beneficiary)` calldata. */
export function buildHandleOpsCalldata(
  userOps: PackedUserOperation[],
  beneficiary: string,
): string {
  if (userOps.length === 0) {
    throw new Error("aa: handleOps needs at least one user operation");
  }
  return abiEncodeCall(HANDLE_OPS_SIGNATURE, [
    { kind: "tuple[]", items: userOps.map(packedUserOpFields) },
    { kind: "address", value: beneficiary },
  ]);
}

/** Self-bundling submission: one `handleOps` transaction via the port. */
export async function submitUserOpsViaHandleOps(params: {
  submitTransaction: SubmitTransaction;
  entryPoint: string;
  userOps: PackedUserOperation[];
  beneficiary: string;
}): Promise<string> {
  return params.submitTransaction({
    to: params.entryPoint,
    data: buildHandleOpsCalldata(params.userOps, params.beneficiary),
  });
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`aa: ${what} must be a non-empty string`);
  }
  return value;
}

/** Adapter: `SubmitTransaction` over an EIP-1193 wallet provider. */
export function createEip1193SubmitTransaction(
  provider: Eip1193Provider,
): SubmitTransaction {
  return async (tx) => {
    const params = {
      ...(tx.from === undefined ? {} : { from: tx.from }),
      to: tx.to,
      ...(tx.value === undefined ? {} : { value: tx.value }),
      data: tx.data,
    };
    return requireString(
      await provider.request({
        method: "eth_sendTransaction",
        params: [params],
      }),
      "transaction hash",
    );
  };
}

/** Adapter: `EthCall` over an EIP-1193 provider, surfacing revert payloads. */
export function createEip1193EthCall(provider: Eip1193Provider): EthCall {
  return async (tx) => {
    try {
      return requireString(
        await provider.request({
          method: "eth_call",
          params: [{ to: tx.to, data: tx.data }, "latest"],
        }),
        "eth_call return data",
      );
    } catch (error) {
      const data = (error as { data?: unknown }).data;
      if (typeof data === "string" && data.startsWith("0x")) {
        throw new EthCallRevertError("eth_call reverted", data.toLowerCase());
      }
      throw error;
    }
  };
}

/**
 * The ERC-4337 `getSenderAddress` flow: `eth_call` the EntryPoint's
 * `getSenderAddress(initCode)` and parse the `SenderAddressResult` revert.
 */
export async function getSenderAddress(params: {
  call: EthCall;
  entryPoint: string;
  initCode: string;
}): Promise<string> {
  const data = abiEncodeCall(GET_SENDER_ADDRESS_SIGNATURE, [
    { kind: "bytes", value: params.initCode },
  ]);
  let revertData: string | undefined;
  try {
    const returned = await params.call({ to: params.entryPoint, data });
    throw new Error(
      `aa: getSenderAddress returned data (${returned}) instead of reverting ` +
        "with SenderAddressResult — wrong entryPoint?",
    );
  } catch (error) {
    if (error instanceof EthCallRevertError) {
      revertData = error.data;
    } else {
      throw error;
    }
  }
  const sender = decodeAddressError(
    revertData,
    SENDER_ADDRESS_RESULT_SIGNATURE,
  );
  if (sender === null) {
    throw new Error(
      `aa: revert payload ${revertData} is not SenderAddressResult(address)`,
    );
  }
  return sender;
}

/** Result shape of `eth_estimateUserOperationGas`. */
export interface UserOperationGasEstimate {
  preVerificationGas: string;
  verificationGasLimit: string;
  callGasLimit: string;
  paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string;
}

/** Result shape of `eth_getUserOperationReceipt` (`null` while pending). */
export interface UserOperationReceipt {
  userOpHash: string;
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  actualGasCost: string;
  actualGasUsed: string;
  [key: string]: unknown;
}

export interface BundlerConfig {
  /** Bundler endpoint; falls back to `bundlerUrlFromEnv()`. */
  url?: string | undefined;
  /** Per-attempt timeout. Default 15000 ms. */
  timeoutMs?: number;
  /** Total attempts (first try + retries). Default 3; always ≥ 1. */
  maxAttempts?: number;
  /** First backoff delay; doubles per attempt, capped at 2000 ms. Default 250 ms. */
  backoffMs?: number;
  /** Injection seam for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Wire-shape adapter for `eth_sendUserOperation` /
   * `eth_estimateUserOperationGas`. Defaults to identity (the packed
   * struct, matching `eth_sendUserOperation` against a self-bundling
   * EntryPoint); ZeroDev's hosted bundler speaks the ERC-4337 v0.7-style
   * UNPACKED JSON and rejects the packed keys (see `zerodev.ts` ledger
   * item 3) — pass `toRpcUserOperation` there.
   */
  userOpEncoder?: (userOp: PackedUserOperation) => unknown;
}

export interface BundlerTransport {
  readonly url: string;
  /** `eth_sendUserOperation` — resolves with the userOpHash. */
  sendUserOperation(
    userOp: PackedUserOperation,
    entryPoint: string,
  ): Promise<string>;
  /** `eth_estimateUserOperationGas`. */
  estimateUserOperationGas(
    userOp: PackedUserOperation,
    entryPoint: string,
  ): Promise<UserOperationGasEstimate>;
  /** `eth_getUserOperationReceipt` — resolves `null` until mined. */
  getUserOperationReceipt(
    userOpHash: string,
  ): Promise<UserOperationReceipt | null>;
  /**
   * Escape hatch for provider-specific JSON-RPC methods (e.g. ZeroDev's
   * `zd_sponsorUserOperation`) under the same bounded retry policy as the
   * typed methods (Rule 4).
   */
  request<T>(method: string, params: unknown[]): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

/**
 * Bundler URL from the Vite env. Optional chaining keeps this module
 * importable outside Vite (unit tests), same pattern as
 * `web/src/features/launchpad/chain.ts`.
 */
export function bundlerUrlFromEnv(): string | undefined {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const url = env?.VITE_BUNDLER_URL;
  return url === undefined || url === "" ? undefined : url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Error bodies carry the upstream failure (e.g. ZeroDev's sponsorship
 * simulation/policy text arrives as an HTTP 400 body) — discarding them
 * hides the exact failure (Review-Proven Rule 1). Bounded to 2000 chars.
 */
async function boundedBodyText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text === "" ? "" : `: ${text.slice(0, 2000)}`;
  } catch {
    return "";
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  body: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create the standard bundler RPC transport. Methods reject with
 * `BundlerNotConfiguredError` when no URL is available.
 */
export function createBundlerTransport(
  config: BundlerConfig = {},
): BundlerTransport {
  const url = config.url ?? bundlerUrlFromEnv();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoffMs = Math.max(0, config.backoffMs ?? DEFAULT_BACKOFF_MS);
  const fetchImpl = config.fetchImpl ?? fetch;
  const userOpEncoder =
    config.userOpEncoder ?? ((op: PackedUserOperation) => op);

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    if (url === undefined) {
      throw new BundlerNotConfiguredError();
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    let lastError: Error = new BundlerRpcError(`bundler: ${method} failed`);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          fetchImpl,
          url,
          body,
          timeoutMs,
        );
        if (response.status === 429 || response.status >= 500) {
          lastError = new BundlerRpcError(
            `bundler: ${method} HTTP ${response.status}${await boundedBodyText(response)}`,
            { retryable: true },
          );
        } else if (!response.ok) {
          throw new BundlerRpcError(
            `bundler: ${method} HTTP ${response.status}${await boundedBodyText(response)}`,
          );
        } else {
          const payload = (await response.json()) as {
            result?: T;
            error?: { code?: number; message?: string };
          };
          if (payload.error !== undefined) {
            throw new BundlerRpcError(
              `bundler: ${method} RPC error ${payload.error.message ?? "unknown"}`,
              { code: payload.error.code },
            );
          }
          return payload.result as T;
        }
      } catch (error) {
        if (error instanceof BundlerRpcError && !error.retryable) {
          throw error;
        }
        if (!(error instanceof BundlerRpcError)) {
          const timedOut =
            (error as { name?: string }).name === "AbortError" ||
            (error as { name?: string }).name === "TimeoutError";
          lastError = timedOut
            ? new BundlerTimeoutError(timeoutMs)
            : new BundlerRpcError(
                `bundler: ${method} network error: ${(error as Error).message}`,
                { retryable: true },
              );
        }
      }
      if (attempt + 1 < maxAttempts) {
        await sleep(Math.min(MAX_BACKOFF_MS, backoffMs * 2 ** attempt));
      }
    }
    throw lastError;
  }

  return {
    url: url ?? "",
    async sendUserOperation(userOp, entryPoint) {
      return requireString(
        await rpc<string>("eth_sendUserOperation", [
          userOpEncoder(userOp),
          entryPoint,
        ]),
        "userOpHash",
      );
    },
    async estimateUserOperationGas(userOp, entryPoint) {
      return (await rpc<UserOperationGasEstimate>(
        "eth_estimateUserOperationGas",
        [userOpEncoder(userOp), entryPoint],
      )) as UserOperationGasEstimate;
    },
    async getUserOperationReceipt(userOpHash) {
      return rpc<UserOperationReceipt | null>("eth_getUserOperationReceipt", [
        userOpHash,
      ]);
    },
    async request<T>(method: string, params: unknown[]): Promise<T> {
      return rpc<T>(method, params);
    },
  };
}
