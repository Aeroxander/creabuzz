/**
 * The part of the passkey sender that does the work: derive the person's account, build one operation for the calls the
 * sheet showed, have the server pay the fee, ask for the passkey once, send, and wait. Loaded only on a passkey send or
 * read (`passkey-sender.ts`), so none of this is in the first download.
 *
 * What is signed is what the sheet showed: the operation's call data is built from the same `calls` array, and just
 * before the passkey is asked it is read back and must be exactly those calls.
 */
import {
  createBundlerTransport,
  type UserOperationReceipt,
} from "@creaton/core/aa/aa.ts";
import {
  createKernel033ChainRpc,
  getKernel033Sender,
  type Kernel033ChainReadRpc,
  type PasskeyAssertionSource,
  parseR1PublicKey,
  readEntryPointSequence,
  sendKernel033UserOp,
} from "@creaton/core/aa/kernel033.ts";
import {
  callDataCarries,
  encodeExecuteCallData,
  type SenderCall,
} from "@creaton/core/aa/sponsoredSender.ts";
import { keccak256 } from "@creaton/core/aa/userop.ts";
import { BundlerNotConfiguredError } from "@creaton/core/aa/aa.ts";
import { UserOpPendingError } from "@creaton/core/aa/zerodev.ts";
import type {
  PasskeyImpl,
  PasskeyProbe,
  PasskeySettings,
} from "./passkey-sender";
import { type SendPhase, type SentCall, WalletStepError } from "./wallet";

/** What a test may replace: the passkey ceremony, the network calls, and the wait for a receipt. */
export interface PasskeyImplDeps {
  getAssertion?: PasskeyAssertionSource;
  fetchImpl?: typeof fetch;
  receipt?: { pollIntervalMs?: number; maxPolls?: number };
  /** Where the account address is remembered (default: this browser's storage). */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** The send itself (default: core's). A test reads the request the sender builds and tries to change it. */
  sendUserOp?: typeof sendKernel033UserOp;
}

const ACCOUNT_KEY = "creaton.money.passkey-account";

/** `UserOperationRevertReason(bytes32,address,uint256,bytes)`: what EntryPoint logs when the account's call reverts. */
const REVERT_REASON_TOPIC = keccak256(
  `0x${[
    ...new TextEncoder().encode(
      "UserOperationRevertReason(bytes32,address,uint256,bytes)",
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`,
);

const PHASES: Record<string, SendPhase> = {
  preparing: "preparing",
  sponsoring: "checking",
  signing: "signing",
  submitting: "sending",
  confirming: "confirming",
};

/** The account's accounts being sent from now: a second send from the same account waits for the first, never overlaps. */
const sending = new Set<string>();

/** The revert bytes the account's call gave, from the receipt's logs, or undefined. */
function revertReasonOf(receipt: UserOperationReceipt): unknown {
  for (const log of receipt.logs) {
    const entry = log as { topics?: unknown; data?: unknown };
    if (
      !Array.isArray(entry.topics) ||
      String(entry.topics[0]).toLowerCase() !== REVERT_REASON_TOPIC ||
      typeof entry.data !== "string"
    )
      continue;
    // data = nonce (32 bytes) | offset (32 bytes) | length (32 bytes) | the revert bytes, padded.
    const body = entry.data.slice(2);
    const length = Number.parseInt(body.slice(128, 192), 16);
    if (!Number.isSafeInteger(length) || length === 0) return undefined;
    const revert = body.slice(192, 192 + length * 2);
    return { data: `0x${revert}`, ...errorText(revert) };
  }
  return undefined;
}

/** The words of a plain `Error(string)` revert (selector 08c379a0), when that is what it is; contract errors keep their selector. */
function errorText(revert: string): { message?: string } {
  if (!revert.startsWith("08c379a0") || revert.length < 8 + 128) return {};
  const length = Number.parseInt(revert.slice(8 + 64, 8 + 128), 16);
  if (!Number.isSafeInteger(length) || revert.length < 8 + 128 + length * 2)
    return {};
  const bytes =
    revert.slice(8 + 128, 8 + 128 + length * 2).match(/.{2}/g) ?? [];
  try {
    return {
      message: new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(bytes.map((b) => Number.parseInt(b, 16))),
      ),
    };
  } catch {
    return {};
  }
}

export function createPasskeyImpl(
  settings: PasskeySettings,
  probe: PasskeyProbe,
  deps: PasskeyImplDeps = {},
): PasskeyImpl {
  const rpc: Kernel033ChainReadRpc = createKernel033ChainRpc({
    url: settings.rpcUrl,
    fetchImpl: deps.fetchImpl,
  });
  const bundler = createBundlerTransport({
    url: settings.bundlerUrl,
    fetchImpl: deps.fetchImpl,
  });
  const storage =
    deps.storage === undefined
      ? (() => {
          try {
            return localStorage;
          } catch {
            return null;
          }
        })()
      : deps.storage;

  const owner = (): { r1: string; x: bigint; y: bigint } => {
    const r1 = probe.ownerKey();
    if (!r1) throw new WalletStepError("no-passkey", 0);
    const keys = parseR1PublicKey(r1);
    return { r1, x: keys.pubKeyX, y: keys.pubKeyY };
  };

  /** The account's address: remembered per network and owner key, so a reload needs no network call to know it. */
  const remembered = (r1: string): string | null => {
    try {
      const saved = JSON.parse(storage?.getItem(ACCOUNT_KEY) ?? "null") as {
        chainId?: unknown;
        r1?: unknown;
        address?: unknown;
      } | null;
      return saved &&
        saved.chainId === settings.chainId &&
        saved.r1 === r1 &&
        typeof saved.address === "string"
        ? saved.address
        : null;
    } catch {
      return null;
    }
  };

  const accountAddress = async (): Promise<string> => {
    const { r1, x, y } = owner();
    const known = remembered(r1);
    if (known) return known;
    const address = (
      await getKernel033Sender({ pubKeyX: x, pubKeyY: y, rpc })
    ).toLowerCase();
    try {
      storage?.setItem(
        ACCOUNT_KEY,
        JSON.stringify({ chainId: settings.chainId, r1, address }),
      );
    } catch {
      // Storage is off: the account is derived again next time.
    }
    return address;
  };

  return {
    connectedAddress: async () => {
      try {
        return await accountAddress();
      } catch {
        return null;
      }
    },
    getAddress: accountAddress,

    async sendCalls(calls, chainId, options) {
      if (chainId !== settings.chainId)
        throw new WalletStepError("wrong-network", 0);
      if (calls.length === 0) throw new WalletStepError("failed", 0);
      const credentialId = probe.credentialId();
      if (!credentialId) throw new WalletStepError("no-passkey", 0);
      const { x, y } = owner();
      const shown: SenderCall[] = calls.map((c) => ({
        to: c.to,
        data: c.data,
        value: c.value,
      }));
      const from = await accountAddress();
      // One send at a time from an account: a second operation in the same slot could only fail.
      if (sending.has(from))
        throw new WalletStepError(
          "failed",
          0,
          new Error("Another send from this account is still running."),
        );
      sending.add(from);
      const submitted: { now: { userOpHash: string; nonce: bigint } | null } = {
        now: null,
      };
      try {
        const result = await (deps.sendUserOp ?? sendKernel033UserOp)({
          credentialId,
          pubKeyX: x,
          pubKeyY: y,
          config: {
            chainId: settings.chainId,
            bundlerUrl: settings.bundlerUrl,
            sponsorUrl: settings.sponsorUrl,
            fetchImpl: deps.fetchImpl,
          },
          rpc,
          // The calls the sheet described, in the order it described them: nothing else is ever put in the operation.
          callData: encodeExecuteCallData(shown),
          beforeSign: (op) => {
            if (!callDataCarries(op.callData, shown))
              throw new WalletStepError("failed", 0);
          },
          onSubmitted: (s) => {
            submitted.now = { userOpHash: s.userOpHash, nonce: s.nonce };
          },
          onPhase: (phase) => {
            const mapped = PHASES[phase];
            if (mapped) options?.onPhase?.(mapped);
          },
          getAssertion: deps.getAssertion,
          receipt: deps.receipt,
        });
        if (!result.success)
          throw new WalletStepError(
            "reverted",
            0,
            revertReasonOf(result.receipt),
            result.userOpHash,
          );
        return {
          txHash: result.txHash,
          status: "confirmed" as const,
          userOpHash: result.userOpHash,
        };
      } catch (error) {
        if (error instanceof WalletStepError) throw error;
        if (error instanceof UserOpPendingError)
          throw new WalletStepError("pending", 0, undefined, error.userOpHash, {
            from,
            nonce: Number(error.nonce),
          });
        if (error instanceof BundlerNotConfiguredError)
          throw new WalletStepError("not-set-up", 0, error);
        // Once the bundler took it, the operation may still land: never "nothing was sent".
        if (submitted.now)
          throw new WalletStepError(
            "pending",
            0,
            error,
            submitted.now.userOpHash,
            { from, nonce: Number(submitted.now.nonce) },
          );
        throw new WalletStepError("failed", 0, error);
      } finally {
        sending.delete(from);
      }
    },

    readCall: async (to, data) => rpc.ethCall({ to, data }),
    blockNumber: async () => Number(await rpc.blockNumber()),
    chainId: () => rpc.chainId(),
    getLogs: async (filter) =>
      rpc.getLogs({
        address: filter.address,
        topics: filter.topics,
        from: BigInt(filter.from),
        to: BigInt(filter.to),
      }),

    async outcomeOf(sent: SentCall) {
      const receipt = await bundler.getUserOperationReceipt(sent.hash);
      if (receipt !== null)
        return receipt.success === true ? "landed" : "reverted";
      let known: unknown;
      try {
        known = await bundler.getUserOperationByHash(sent.hash);
      } catch {
        // A bundler that cannot say is not a "landed" and not a "gone": the person is told it is unknown.
        return "unknown";
      }
      if (known !== null) return "waiting";
      if (sent.nonce === null) return "unknown";
      // Gone from the bundler: another operation in its slot means it was replaced; the same slot means it was dropped.
      const next = await readEntryPointSequence(rpc, sent.from);
      return next > BigInt(sent.nonce) ? "replaced" : "unknown";
    },
  };
}
