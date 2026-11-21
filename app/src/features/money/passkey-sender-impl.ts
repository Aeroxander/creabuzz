/**
 * The part of the passkey sender that does the work: derive the person's account, build one operation for the calls the
 * sheet showed, have the server pay the fee, ask for the passkey once, send, and wait. Loaded only on a passkey send or
 * read (`passkey-sender.ts`), so none of this is in the first download.
 *
 * What is signed is what the sheet showed: the operation's call data is built from the same `calls` array, and just
 * before the passkey is asked it is read back and must be exactly those calls.
 */
import {
  BundlerRpcError,
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
import { signKernelHash } from "@creaton/core/aa/kernel-signature.ts";
import { kernel033AddressLocal } from "@creaton/core/aa/kernel033-address.ts";
import { keccak256 } from "@creaton/core/aa/userop.ts";
import {
  walletAttestationDigest,
  walletTypedData,
  type WalletAttestation,
} from "@creaton/core/account/wallet-proof.ts";
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

/**
 * Whether an error from sending a signed operation leaves open that the bundler holds it: anything but the bundler's
 * own refusal as the first and only try ("already known" is its way of saying it holds it).
 */
function mayHaveBeenTaken(error: unknown): boolean {
  if (!(error instanceof BundlerRpcError)) return true;
  return error.maybeDelivered || /already known/i.test(error.message);
}

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

/**
 * The digest of the one message a passkey account signs besides its money steps: the wallet link that names the person's
 * account (never a transfer). `typed` is rebuilt from its own fields and must be exactly what the link's builder makes, and
 * the account it names must be the account signing: anything else is refused, so this can never be made to sign something else.
 */
export function walletLinkDigest(from: string, typed: unknown): string {
  const t = typed as {
    domain?: Record<string, unknown>;
    message?: Record<string, unknown>;
  } | null;
  const d = t?.domain;
  const m = t?.message;
  if (
    !d ||
    !m ||
    typeof m.npub !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(m.npub)
  )
    throw new Error("A passkey account signs only the link to your account.");
  const envelope: WalletAttestation = {
    domain: {
      name: String(d.name),
      version: String(d.version),
      chain_id: Number(d.chainId),
      verifying_contract: String(d.verifyingContract),
    },
    attestation: {
      account: String(m.account),
      npub: (m.npub.slice(2).match(/../g) ?? []).map((h) =>
        Number.parseInt(h, 16),
      ),
      expires: Number(m.expires),
      nonce: Number(m.nonce),
    },
    signature: "",
  };
  if (
    JSON.stringify(walletTypedData(envelope)) !== JSON.stringify(typed) ||
    envelope.attestation.account.toLowerCase() !== from.toLowerCase()
  )
    throw new Error("A passkey account signs only the link to your account.");
  return `0x${[...walletAttestationDigest(envelope)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
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

  /**
   * The account's address, worked out here from the passkey's own key and checked against what the node says (remembered per
   * network and owner key after one match, so a reload makes no call). An address the two do not agree on is never used or
   * shown: a node that lied about it could otherwise send a person's money, or a deposit, to an account nobody controls.
   */
  const accountAddress = async (): Promise<string> => {
    const { r1, x, y } = owner();
    const mine = kernel033AddressLocal({ pubKeyX: x, pubKeyY: y });
    if (remembered(r1) === mine) return mine;
    const said = (
      await getKernel033Sender({ pubKeyX: x, pubKeyY: y, rpc })
    ).toLowerCase();
    if (said !== mine)
      throw new WalletStepError(
        "account-mismatch",
        0,
        new Error("The node's account address is not the one worked out here."),
      );
    try {
      storage?.setItem(
        ACCOUNT_KEY,
        JSON.stringify({ chainId: settings.chainId, r1, address: mine }),
      );
    } catch {
      // Storage is off: the account is checked again next time.
    }
    return mine;
  };

  return {
    connectedAddress: async () => {
      try {
        return await accountAddress();
      } catch (error) {
        // A mismatch is told, never hidden as "no account yet"; any other failure shows none and is tried again.
        if (
          error instanceof WalletStepError &&
          error.reason === "account-mismatch"
        )
          throw error;
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
      // `signed`: signed, maybe not yet taken; `submitted`: the bundler took it.
      const progress: {
        signed: { userOpHash: string; nonce: bigint } | null;
        submitted: boolean;
      } = { signed: null, submitted: false };
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
          onSigned: (s) => {
            progress.signed = { userOpHash: s.userOpHash, nonce: s.nonce };
            // Remembered by the caller now: a tab closed while the bundler works must not forget a step that may land.
            options?.onSent?.({
              hash: s.userOpHash,
              from,
              nonce: Number(s.nonce),
            });
          },
          onSubmitted: () => {
            progress.submitted = true;
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
        // Once the bundler took it, or may have taken it without saying so, the operation may still land: never
        // "nothing was sent". Only an answer that says no (and no earlier try that may have got through) is "failed".
        if (progress.signed && (progress.submitted || mayHaveBeenTaken(error)))
          throw new WalletStepError(
            "pending",
            0,
            error,
            progress.signed.userOpHash,
            { from, nonce: Number(progress.signed.nonce) },
          );
        throw new WalletStepError("failed", 0, error);
      } finally {
        sending.delete(from);
      }
    },

    async signTypedData(from, typed) {
      const credentialId = probe.credentialId();
      if (!credentialId) throw new WalletStepError("no-passkey", 0);
      const account = await accountAddress();
      if (from.toLowerCase() !== account.toLowerCase())
        throw new WalletStepError("failed", 0);
      // One passkey prompt; the account itself says on the network whether the signature is valid.
      return signKernelHash({
        credentialId,
        hash: walletLinkDigest(account, typed),
        account,
        chainId: settings.chainId,
        getAssertion: deps.getAssertion,
      });
    },

    readCall: async (to, data) => rpc.ethCall({ to, data }),
    blockNumber: async () => Number(await rpc.blockNumber()),
    blockTime: async (block) =>
      rpc.blockTime(block === "latest" ? "latest" : BigInt(block)),
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
      if (receipt !== null) {
        // A receipt for another operation answers nothing about this one.
        if (
          String(receipt.userOpHash).toLowerCase() !== sent.hash.toLowerCase()
        )
          throw new Error("The bundler answered about another operation.");
        return receipt.success === true ? "landed" : "reverted";
      }
      // A bundler that cannot say throws: that is neither "landed" nor "gone", so the caller says "still waiting".
      const known = await bundler.getUserOperationByHash(sent.hash);
      if (known !== null) return "waiting";
      if (sent.nonce === null) return "unknown";
      // Gone from the bundler: another operation in its slot means it was replaced; the same slot means it was dropped.
      const next = await readEntryPointSequence(rpc, sent.from);
      return next > BigInt(sent.nonce) ? "replaced" : "unknown";
    },
  };
}
