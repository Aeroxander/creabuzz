/**
 * `/identity-demo` affordance for manually verifying the wave-4b UserOperation
 * core with Touch ID: builds a demo PackedUserOperation (dummy self-call),
 * hashes it exactly as EntryPoint v0.8 does, prompts
 * `getPasskeyAssertion({ challenge: userOpHash })`, and shows both real
 * signature wraps (solady `WebAuthnAuth` and the ZeroDev WebAuthnValidator
 * tuple). Nothing is submitted anywhere — this is the hash-shape and
 * signature-wrapping verification path.
 */
import { useState } from "react";

import { getPasskeyAssertion, explainPasskeyError } from "../lib/passkey";
import { hexToBytes } from "../lib/userop-abi";
import {
  getUserOpHash,
  packUints,
  type PackedUserOperation,
} from "../lib/userop";
import { buildKernelSelfCallData } from "../lib/aa-kernel";
import {
  wrapPasskeyAssertionAsWebAuthnAuth,
  wrapPasskeyAssertionForZeroDevValidator,
} from "../lib/webauthn-auth";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Mirrors `passkey-identity.ts`'s private CRED_KEY — demo-only read of the
// record that module persists (it exposes no credential id getter).
const CREDENTIAL_KEY = "buzz.passkey.credentialId";

const inputClass =
  "mt-1 w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-2xs";

export function UserOpDemoCard({ disabled }: { disabled: boolean }) {
  const [entryPoint, setEntryPoint] = useState("");
  const [chainId, setChainId] = useState("31337");
  const [sender, setSender] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const signUserOp = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const credentialId = window.localStorage.getItem(CREDENTIAL_KEY);
      if (!credentialId) {
        throw new Error("no stored passkey credential id — register first");
      }
      const target = sender || ZERO_ADDRESS;
      const op: PackedUserOperation = {
        sender: target,
        nonce: "0x0",
        initCode: "0x",
        callData: buildKernelSelfCallData(target),
        accountGasLimits: packUints(100000n, 50000n),
        preVerificationGas: "0x5208",
        gasFees: packUints(1n, 1000000000n),
        paymasterAndData: "0x",
        signature: "0x",
      };
      const userOpHash = getUserOpHash(op, entryPoint, BigInt(chainId));
      const assertion = await getPasskeyAssertion({
        credentialId,
        challenge: hexToBytes(userOpHash),
      });
      const webAuthnAuth = wrapPasskeyAssertionAsWebAuthnAuth(assertion, {
        challengeHex: userOpHash,
      });
      const zeroDev = wrapPasskeyAssertionForZeroDevValidator(assertion, {
        challengeHex: userOpHash,
        usePrecompiled: false,
      });
      setResult(
        JSON.stringify(
          {
            userOpHash,
            packedUserOp: { ...op, signature: webAuthnAuth.encoded },
            webAuthnAuth,
            zeroDevWebAuthnSignature: zeroDev,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      setError(explainPasskeyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mt-4 border-t border-black/10 pt-3 dark:border-white/10"
      data-testid="userop-demo"
    >
      <h2 className="text-sm font-semibold tracking-tight text-black dark:text-white">
        Sign demo UserOp (ERC-4337 v0.8)
      </h2>
      <p className="mt-1 text-xs text-black/60 dark:text-white/60">
        Hashes a dummy self-call UserOp exactly as EntryPoint v0.8 does
        (EIP-712), then signs the hash with this passkey via Touch ID. Nothing
        is broadcast.
      </p>
      <label className="mt-2 block text-xs text-black/60 dark:text-white/60">
        EntryPoint v0.8 address
        <input
          type="text"
          value={entryPoint}
          onChange={(event) => setEntryPoint(event.target.value.trim())}
          placeholder="0x… entry point"
          className={inputClass}
          data-testid="userop-entrypoint"
        />
      </label>
      <label className="mt-2 block text-xs text-black/60 dark:text-white/60">
        Chain id
        <input
          type="text"
          value={chainId}
          onChange={(event) => setChainId(event.target.value.trim())}
          className={inputClass}
          data-testid="userop-chainid"
        />
      </label>
      <label className="mt-2 block text-xs text-black/60 dark:text-white/60">
        Sender (optional — zero address is fine for hash-shape checks)
        <input
          type="text"
          value={sender}
          onChange={(event) => setSender(event.target.value.trim())}
          placeholder={ZERO_ADDRESS}
          className={inputClass}
          data-testid="userop-sender"
        />
      </label>
      <button
        type="button"
        onClick={() => void signUserOp()}
        disabled={disabled || busy}
        aria-busy={busy}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
        data-testid="userop-sign"
      >
        {busy ? "Waiting for Touch ID…" : "Sign demo UserOp"}
      </button>
      {error ? (
        <p
          className="mt-2 text-xs text-red-600 dark:text-red-400"
          role="alert"
          data-testid="userop-error"
        >
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="mt-3" role="status" data-testid="userop-result">
          <p className="text-xs text-black/60 dark:text-white/60">
            Packed UserOperation, hash, and both signature wraps:
          </p>
          <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-black/[0.03] p-2 font-mono text-2xs break-all whitespace-pre-wrap text-black/80 dark:bg-white/5 dark:text-white/80">
            {result}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
