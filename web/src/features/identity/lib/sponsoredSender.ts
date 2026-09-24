/**
 * Sponsored sender: drive the passkey-owned Kernel-0.3.3 account (EntryPoint
 * v0.7) with gas sponsored by the ZeroDev paymaster — an ALTERNATIVE to the
 * injected wallet (`window.ethereum`) for the launchpad's unsigned-call flows
 * (`web/src/features/launchpad/ui/RecordBidDialog.tsx`). The composed calldata
 * is sender-agnostic: the adapter only decides how the calls reach the chain.
 *
 * Seams consumed (nothing here forks or duplicates their logic):
 * - `./kernel033.ts` — the decided kernel-0.3.3 stack: `getKernel033Sender`
 *   (bounded counterfactual-address `eth_call`), `sendKernel033UserOp`
 *   (sponsor → hash guard → real passkey → bundler → receipt), plus
 *   `createKernel033ChainRpc` / `kernel033ChainRpcUrl` / `parseR1PublicKey`.
 * - `./zerodev.ts` — `zerodevConfigFromEnv` (paymaster/bundler project) and
 *   `PaymasterDeniedError`, which passes through this adapter untouched so the
 *   UI can surface its `dashboardAction` (Rule 1: never swallow a failure).
 * - `./userop-abi.ts` + `./aa-kernel.ts` — `abiEncode`/`abiEncodeCall` and the
 *   `KERNEL_EXECUTE_SIGNATURE`, both already `cast`-golden-tested.
 * - `./passkey-identity.ts` — `passkeyIdentity()` supplies the passkey's
 *   secp256r1 owner key (`evmOwner.r1UncompressedHex`); the credential id
 *   comes from this module's config or `buzz.passkey.credentialId` (that
 *   module exposes no getter — same read `identity/ui/UserOpDemoCard.tsx` uses).
 *
 * Batch vs per-call — DECIDED: one UserOp per `sendCalls` (batched) whenever
 * there is more than one call, because the deployed kernel-0.3.3 supports
 * batch execution through the SAME `execute(bytes32,bytes)` selector (there is
 * no separate `executeBatch` function):
 * - Live probe 2026-09-24, deployed impl `0xd6cedde84be40893d153be9d467cd6ad37875b28`:
 *   `supportsExecutionMode(0x01 || 31×0x00)` (CALLTYPE_BATCH‖EXECTYPE_DEFAULT)
 *   returns `true`, as does `entrypoint()` → EntryPoint v0.7
 *   `0x0000…71727de22e5e9d8baf0edac6f37da032`.
 * - v3.3 source (contracts/lib/zerodev-kernel @ tag v3.3): `src/Kernel.sol:330`
 *   `execute(ExecMode, bytes)` → `ExecLib.execute`; `src/Kernel.sol:509`
 *   `supportsExecutionMode` accepts CALLTYPE_BATCH; `src/types/Constants.sol`
 *   defines `CALLTYPE_BATCH = 0x01`.
 * - Wire layouts (v3.3 `src/utils/ExecLib.sol`, decoded by its pinned solady
 *   `LibERC7579`, lib/solady @ 3f2f534): mode word = `callType ‖ execType ‖
 *   bytes4(0) ‖ selector ‖ payload` (batch-default = `0x01` + 31 zero bytes);
 *   single `executionData = target(20) ‖ value(32) ‖ raw data` — byte-identical
 *   to `aa-kernel.ts` `buildKernelSelfCallData`, the construction
 *   `scripts/zerodev-smoke.mjs` STEP B landed on Sepolia; batch
 *   `executionData = abi.encode(Execution[])` with
 *   `struct Execution { address target; uint256 value; bytes callData; }`
 *   (v3.3 `src/types/Structs.sol:7`, `ExecLib.encodeBatch`).
 *
 * Per-call fallback (`batching: "per-call"`) sends one UserOp per call in
 * order — parity with the injected wallet's sequential sends. Like that path,
 * a mid-sequence failure propagates unchanged (possibly after earlier calls
 * landed); the default batched mode has no such window because one UserOp is
 * atomic.
 *
 * Bounds (Rule 4): no retries and no loops of our own — the per-call loop is
 * bounded by the caller's finite `calls` array and `kernel033.ts` owns its
 * bounded receipt polling.
 */
import { KERNEL_EXECUTE_SIGNATURE } from "./aa-kernel.ts";
import {
  createKernel033ChainRpc,
  getKernel033Sender,
  kernel033ChainRpcUrl,
  parseR1PublicKey,
  sendKernel033UserOp,
  type Kernel033ChainRpc,
  type Kernel033SendResult,
  type PasskeyAssertionSource,
} from "./kernel033.ts";
import { passkeyIdentity } from "./passkey-identity.ts";
import type { AbiField } from "./userop-abi.ts";
import { abiEncode, abiEncodeCall } from "./userop-abi.ts";
import { zerodevConfigFromEnv, type ZerodevConfig } from "./zerodev.ts";

/** LocalStorage key holding the passkey credential id (see module docs). */
export const PASSKEY_CREDENTIAL_STORAGE_KEY = "buzz.passkey.credentialId";

/** `execute(bytes32,bytes)` mode: CALLTYPE_SINGLE ‖ EXECTYPE_DEFAULT. */
export const KERNEL_EXECUTE_MODE_SINGLE = `0x${"00".repeat(32)}`;

/** `execute(bytes32,bytes)` mode: CALLTYPE_BATCH (0x01) ‖ EXECTYPE_DEFAULT. */
export const KERNEL_EXECUTE_MODE_BATCH = `0x01${"00".repeat(31)}`;

/** One unsigned call — the shape the launchpad flows hand to a sender. */
export interface SenderCall {
  to: string;
  data: string;
  /** Quantity string, e.g. "0x0". Defaults to zero. */
  value?: string;
}

/** Result of sending a call sequence. */
export interface SendCallsResult {
  /**
   * Bundle tx hash of the LAST UserOp — what a feed mirror's `tx` tag binds
   * (the injected-wallet path returns its last hash the same way).
   */
  txHash: string;
  /** "confirmed" (receipt-bound sponsored ops) or "submitted" (wallet hash). */
  status: "confirmed" | "submitted";
  /** One entry per UserOp sent (length 1 when batched). Empty for wallets. */
  userOps: Kernel033SendResult[];
}

/** The small signer interface the launchpad flows consume. */
export interface CallSender {
  /** Sender identity: the counterfactual Kernel account or the wallet account. */
  getAddress(): Promise<string>;
  /** Send the ordered calls. Implementations must not alter them. */
  sendCalls(calls: SenderCall[]): Promise<SendCallsResult>;
  /** Whether this sender can run at all right now. */
  isAvailable(): boolean;
}

/** What the sponsored sender is missing when it is not available. */
export type SponsoredSenderMissing =
  | "credential"
  | "owner-key"
  | "chain-config";

/** Honest availability detail (Rule 6: reason + recovery affordance). */
export interface SponsoredSenderAvailability {
  available: boolean;
  missing: SponsoredSenderMissing[];
  /** Plain explanation of the first blocker. */
  reason: string | null;
  /** How to recover — names the identity page for passkey blockers. */
  action: string | null;
}

/** Thrown when the sponsored sender cannot run; never a silent success. */
export class SponsoredSenderUnavailableError extends Error {
  readonly availability: SponsoredSenderAvailability;

  constructor(availability: SponsoredSenderAvailability) {
    super(availability.reason ?? "The sponsored sender is unavailable.");
    this.name = "SponsoredSenderUnavailableError";
    this.availability = availability;
  }
}

/** Thrown for empty or malformed call input. */
export class SenderCallsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SenderCallsError";
  }
}

/** The sponsored sender, a {@link CallSender} with availability detail. */
export interface SponsoredSender extends CallSender {
  availability(): SponsoredSenderAvailability;
  /** "batch" (default, one UserOp) or "per-call" (one UserOp per call). */
  batching: "batch" | "per-call";
}

export interface SponsoredSenderConfig {
  /** base64url passkey credential id. Defaults to `buzz.passkey.credentialId`. */
  credentialId?: string | undefined;
  /** Sponsored chain id (`VITE_ZERODEV_CHAIN_ID`, e.g. 11155111 for Sepolia). */
  chainId: number;
  /** Chain JSON-RPC URL — sender/nonce/hash-guard reads (NOT the ZeroDev RPC). */
  rpcUrl: string;
  /** Default "batch". See the module docs for the batch decision. */
  batching?: "batch" | "per-call" | undefined;
  /** rpId for the passkey ceremony (falls back to the browser's). */
  rpId?: string | undefined;
  /** Receipt polling bounds, forwarded to `sendKernel033UserOp`. */
  receipt?: { pollIntervalMs?: number; maxPolls?: number } | undefined;
}

/** Injection seams (node tests / mocks). Defaults hit the real stack. */
export interface SponsoredSenderDeps {
  /** Default `createKernel033ChainRpc({ url: config.rpcUrl })`. */
  rpc?: Kernel033ChainRpc | undefined;
  /** Default `zerodevConfigFromEnv()` with `chainId` overridden by config. */
  zerodev?: ZerodevConfig | undefined;
  /** Ceremony seam passed to `sendKernel033UserOp` (its default is the real Touch ID). */
  getAssertion?: PasskeyAssertionSource | undefined;
  /** Test seam: defaults to `kernel033.ts` `sendKernel033UserOp`. */
  sendUserOp?: typeof sendKernel033UserOp | undefined;
  /** Test seam: defaults to `kernel033.ts` `getKernel033Sender`. */
  getSender?: typeof getKernel033Sender | undefined;
}

/**
 * Pure availability predicate over the gathered inputs — table-tested over its
 * full input combination space in `sponsoredSender.test.mjs`.
 */
export function sponsoredSenderAvailability(input: {
  credentialId: string | null;
  r1OwnerKey: string | null;
  chainId: number;
  rpcUrl: string;
}): SponsoredSenderAvailability {
  const missing: SponsoredSenderMissing[] = [];
  if (!input.credentialId) missing.push("credential");
  if (!input.r1OwnerKey) missing.push("owner-key");
  const configOk =
    Number.isInteger(input.chainId) &&
    input.chainId > 0 &&
    input.rpcUrl.trim() !== "";
  if (!configOk) missing.push("chain-config");
  if (missing.length === 0) {
    return { available: true, missing: [], reason: null, action: null };
  }
  const first = missing[0];
  const messages: Record<
    SponsoredSenderMissing,
    { reason: string; action: string }
  > = {
    credential: {
      reason: "No passkey is registered in this browser.",
      action:
        "Create a passkey on the identity page (/identity-demo), then retry.",
    },
    "owner-key": {
      reason:
        "This browser's passkey has no wallet owner key yet (it predates wallet-owner capture).",
      action: "Re-register the passkey on the identity page (/identity-demo).",
    },
    "chain-config": {
      reason:
        "The sponsored stack is not configured (VITE_ZERODEV_CHAIN_ID and a chain RPC URL are required).",
      action: "Set the ZeroDev chain id and chain RPC URL, then reload.",
    },
  };
  return {
    available: false,
    missing,
    reason: messages[first].reason,
    action: messages[first].action,
  };
}

/**
 * Create a passkey-account sender with ZeroDev gas sponsorship. See the module
 * docs for the kernel-0.3.3 execute conventions this encodes.
 */
export function createSponsoredSender(
  config: SponsoredSenderConfig,
  deps: SponsoredSenderDeps = {},
): SponsoredSender {
  const batching = config.batching ?? "batch";
  let senderCache: Promise<string> | undefined;

  function storedCredentialId(): string | null {
    try {
      return (
        globalThis.localStorage?.getItem(PASSKEY_CREDENTIAL_STORAGE_KEY) ?? null
      );
    } catch {
      return null;
    }
  }

  function gather(): {
    credentialId: string | null;
    r1OwnerKey: string | null;
  } {
    return {
      credentialId: config.credentialId ?? storedCredentialId(),
      r1OwnerKey: passkeyIdentity()?.evmOwner.r1UncompressedHex ?? null,
    };
  }

  function availability(): SponsoredSenderAvailability {
    const { credentialId, r1OwnerKey } = gather();
    return sponsoredSenderAvailability({
      credentialId,
      r1OwnerKey,
      chainId: config.chainId,
      rpcUrl: config.rpcUrl,
    });
  }

  function requireReady(): {
    credentialId: string;
    pubKeyX: bigint;
    pubKeyY: bigint;
    rpc: Kernel033ChainRpc;
    zerodev: ZerodevConfig;
  } {
    const status = availability();
    if (!status.available) throw new SponsoredSenderUnavailableError(status);
    const { credentialId, r1OwnerKey } = gather();
    // availability() just proved both are present.
    if (!credentialId || !r1OwnerKey) {
      throw new SponsoredSenderUnavailableError(status);
    }
    const keys = parseR1PublicKey(r1OwnerKey);
    return {
      credentialId,
      pubKeyX: keys.pubKeyX,
      pubKeyY: keys.pubKeyY,
      rpc: deps.rpc ?? createKernel033ChainRpc({ url: config.rpcUrl }),
      zerodev: deps.zerodev ?? {
        ...zerodevConfigFromEnv(),
        chainId: config.chainId,
      },
    };
  }

  return {
    batching,

    isAvailable(): boolean {
      return availability().available;
    },

    availability,

    getAddress(): Promise<string> {
      // Wrapped so failures REJECT the returned promise (they must never
      // throw synchronously out of a Promise-returning API). A failed
      // derivation is not durable state: the cache is cleared on rejection so
      // a retry after recovery (e.g. registering the passkey) can succeed
      // (Rule 2). A success is immutable for this adapter's lifetime.
      if (!senderCache) {
        senderCache = (async () => {
          const ready = requireReady();
          return (deps.getSender ?? getKernel033Sender)({
            pubKeyX: ready.pubKeyX,
            pubKeyY: ready.pubKeyY,
            rpc: ready.rpc,
          });
        })().catch((err: unknown) => {
          senderCache = undefined;
          throw err;
        });
      }
      return senderCache;
    },

    async sendCalls(calls: SenderCall[]): Promise<SendCallsResult> {
      if (calls.length === 0) {
        throw new SenderCallsError("sendCalls needs at least one call.");
      }
      const ready = requireReady();
      // One UserOp for the whole sequence (batch execute) by default; the
      // per-call fallback keeps the injected wallet's sequential semantics.
      const groups: SenderCall[][] =
        batching === "per-call" ? calls.map((call) => [call]) : [calls];
      const userOps: Kernel033SendResult[] = [];
      let last: Kernel033SendResult | undefined;
      for (const group of groups) {
        const result = await (deps.sendUserOp ?? sendKernel033UserOp)({
          credentialId: ready.credentialId,
          pubKeyX: ready.pubKeyX,
          pubKeyY: ready.pubKeyY,
          config: ready.zerodev,
          rpc: ready.rpc,
          callData:
            batching === "per-call"
              ? encodeExecuteSingleCallData(group[0])
              : encodeExecuteCallData(group),
          rpId: config.rpId,
          receipt: config.receipt,
          getAssertion: deps.getAssertion,
        });
        userOps.push(result);
        last = result;
      }
      if (!last) {
        throw new SenderCallsError("sendCalls produced no user operations.");
      }
      return { txHash: last.txHash, status: "confirmed", userOps };
    },
  };
}

/**
 * Account callData for one call: `execute(bytes32(0), target(20) ‖ value(32) ‖
 * data)` — the tight v3.3 `ExecLib.decodeSingle` layout, byte-identical to
 * `buildKernelSelfCallData` for the empty-data case.
 */
export function encodeExecuteSingleCallData(call: SenderCall): string {
  const { to, value, data } = normalizeCall(call);
  const executionData = `0x${to.slice(2)}${word32(value)}${data.slice(2)}`;
  return abiEncodeCall(KERNEL_EXECUTE_SIGNATURE, [
    { kind: "bytes32", value: KERNEL_EXECUTE_MODE_SINGLE },
    { kind: "bytes", value: executionData },
  ]);
}

/**
 * Account callData for a call sequence: `execute(bytes32(0x01…), abi.encode(
 * Execution[]))` — the v3.3 `ExecLib.encodeBatch` layout.
 */
export function encodeExecuteBatchCallData(calls: SenderCall[]): string {
  const items: AbiField[][] = calls.map((call) => {
    const { to, value, data } = normalizeCall(call);
    return [
      { kind: "address", value: to },
      { kind: "uint", value },
      { kind: "bytes", value: data },
    ];
  });
  const executionData = abiEncode([{ kind: "tuple[]", items }]);
  return abiEncodeCall(KERNEL_EXECUTE_SIGNATURE, [
    { kind: "bytes32", value: KERNEL_EXECUTE_MODE_BATCH },
    { kind: "bytes", value: executionData },
  ]);
}

/**
 * Account callData for a sequence: single-execute for one call (the proven
 * bytes), batch-execute for several (one atomic UserOp).
 */
export function encodeExecuteCallData(calls: SenderCall[]): string {
  return calls.length === 1
    ? encodeExecuteSingleCallData(calls[0])
    : encodeExecuteBatchCallData(calls);
}

function normalizeCall(call: SenderCall): {
  to: string;
  value: bigint;
  data: string;
} {
  const to = call.to.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to)) {
    throw new SenderCallsError(
      `call.to must be a 20-byte address, got ${String(call.to)}`,
    );
  }
  const data = call.data.toLowerCase();
  if (!/^0x([0-9a-f]{2})*$/.test(data)) {
    throw new SenderCallsError(
      `call.data must be 0x-prefixed even-length hex, got ${String(call.data)}`,
    );
  }
  let value = 0n;
  if (call.value !== undefined && call.value !== "") {
    if (!/^0x[0-9a-f]+$/.test(call.value.toLowerCase())) {
      throw new SenderCallsError(
        `call.value must be a hex quantity, got ${String(call.value)}`,
      );
    }
    value = BigInt(call.value);
  }
  return { to, value, data };
}

function word32(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

// `kernel033ChainRpcUrl` is re-exported so the launchpad resolves the
// sponsored chain's RPC URL from the one module that owns the rule
// (`VITE_CHAIN_RPC_URL`, Sepolia fallback).
export { kernel033ChainRpcUrl };
