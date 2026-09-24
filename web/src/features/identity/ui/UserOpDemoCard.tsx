/**
 * `/identity-demo` affordance for manually verifying the UserOperation cores
 * with Touch ID.
 *
 * Two flows live here:
 *
 * 1. "Sign demo UserOp (ERC-4337 v0.8)" — builds a demo PackedUserOperation
 *    (dummy self-call), hashes it exactly as EntryPoint v0.8 does (EIP-712),
 *    prompts `getPasskeyAssertion({ challenge: userOpHash })`, and shows both
 *    real signature wraps (solady `WebAuthnAuth` and the ZeroDev
 *    WebAuthnValidator tuple). Nothing is submitted anywhere — this is the
 *    hash-shape and signature-wrapping verification path.
 *
 * 2. "Send sponsored UserOp (Touch ID)" — the REAL end-to-end proof on the
 *    deployed kernel-0.3.3 stack (`kernel033.ts`, the product's account
 *    generation): derives the user's passkey-owned counterfactual account,
 *    requests sponsorship (`zd_sponsorUserOperation`, server-side gas),
 *    verifies the locally computed v0.7 op hash against the live EntryPoint
 *    (refusing to sign on mismatch), then prompts Touch ID to sign the real
 *    WebAuthn assertion and submits through ZeroDev's hosted bundler. This
 *    SENDS A REAL sponsored UserOperation on Sepolia and spends project
 *    sponsorship — that is the point: it proves a real passkey (Touch ID /
 *    virtual authenticator) can sign sponsored UserOperations with no
 *    fixture keys anywhere in the app path.
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
import {
  createKernel033ChainRpc,
  kernel033ChainRpcUrl,
  parseR1PublicKey,
  sendKernel033UserOp,
  type Kernel033SendPhase,
  type Kernel033SendResult,
} from "../lib/kernel033";
import { PaymasterDeniedError, zerodevConfigFromEnv } from "../lib/zerodev";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Mirrors `passkey-identity.ts`'s private keys — demo-only reads of the
// record that module persists (it exposes no credential id getter).
const CREDENTIAL_KEY = "buzz.passkey.credentialId";
const R1_KEY = "buzz.passkey.r1";

const inputClass =
  "mt-1 w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-2xs";

const PHASE_LABELS: Record<Kernel033SendPhase, string> = {
  preparing: "Preparing account…",
  sponsoring: "Requesting sponsorship…",
  signing: "Touch ID to sign…",
  submitting: "Submitted — waiting for inclusion…",
  confirming: "Waiting for receipt…",
};

export function UserOpDemoCard({ disabled }: { disabled: boolean }) {
  const [entryPoint, setEntryPoint] = useState("");
  const [chainId, setChainId] = useState("31337");
  const [sender, setSender] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const [sponsoredBusy, setSponsoredBusy] = useState(false);
  const [sponsoredPhase, setSponsoredPhase] =
    useState<Kernel033SendPhase | null>(null);
  const [sponsoredError, setSponsoredError] = useState<string | null>(null);
  const [sponsoredDenied, setSponsoredDenied] = useState<{
    serverMessage: string;
    dashboardAction: string;
  } | null>(null);
  const [sponsoredResult, setSponsoredResult] =
    useState<Kernel033SendResult | null>(null);
  const [copiedResult, setCopiedResult] = useState(false);

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

  const sendSponsoredOp = async () => {
    setSponsoredBusy(true);
    setSponsoredPhase("preparing");
    setSponsoredError(null);
    setSponsoredDenied(null);
    setSponsoredResult(null);
    setCopiedResult(false);
    try {
      const credentialId = window.localStorage.getItem(CREDENTIAL_KEY);
      if (!credentialId) {
        throw new Error("no stored passkey credential id — register first");
      }
      const r1Hex = window.localStorage.getItem(R1_KEY);
      if (!r1Hex) {
        throw new Error(
          "no stored passkey public key (buzz.passkey.r1) — register first",
        );
      }
      const { pubKeyX, pubKeyY } = parseR1PublicKey(r1Hex);
      const config = zerodevConfigFromEnv();
      const rpc = createKernel033ChainRpc({
        url: kernel033ChainRpcUrl(config.chainId),
      });
      const outcome = await sendKernel033UserOp({
        credentialId,
        pubKeyX,
        pubKeyY,
        config,
        rpc,
        onPhase: setSponsoredPhase,
      });
      setSponsoredResult(outcome);
    } catch (e) {
      if (e instanceof PaymasterDeniedError) {
        setSponsoredDenied({
          serverMessage: e.serverMessage,
          dashboardAction: e.dashboardAction,
        });
      } else {
        setSponsoredError(explainPasskeyError(e));
      }
    } finally {
      setSponsoredPhase(null);
      setSponsoredBusy(false);
    }
  };

  const copySponsoredResult = () => {
    if (!sponsoredResult) return;
    void navigator.clipboard
      ?.writeText(JSON.stringify(sponsoredResult, null, 2))
      .then(() => {
        setCopiedResult(true);
      });
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

      <div className="mt-4 border-t border-black/10 pt-3 dark:border-white/10">
        <h2 className="text-sm font-semibold tracking-tight text-black dark:text-white">
          Send sponsored UserOp (Touch ID)
        </h2>
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          The real end-to-end proof: sends a sponsored self-call from this
          passkey&rsquo;s own Kernel&nbsp;0.3.3 account on Sepolia (deployed on
          first use). The paymaster covers the gas, the locally computed v0.7 op
          hash is checked against the live EntryPoint before anything is signed,
          and Touch ID produces the real WebAuthn signature — no fixture keys in
          this path. This broadcasts a real UserOperation and spends project
          sponsorship.
        </p>
        <button
          type="button"
          onClick={() => void sendSponsoredOp()}
          disabled={disabled || sponsoredBusy}
          aria-busy={sponsoredBusy}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
          data-testid="sponsored-send"
        >
          {sponsoredBusy
            ? (sponsoredPhase && PHASE_LABELS[sponsoredPhase]) || "Working…"
            : "Send sponsored UserOp (Touch ID)"}
        </button>
        {sponsoredBusy && sponsoredPhase ? (
          <p
            className="mt-2 text-center text-xs text-black/60 dark:text-white/60"
            role="status"
            data-testid="sponsored-phase"
          >
            {PHASE_LABELS[sponsoredPhase]}
          </p>
        ) : null}
        {sponsoredDenied ? (
          <div
            className="mt-2 text-xs text-red-600 dark:text-red-400"
            role="alert"
            data-testid="sponsored-denied"
          >
            <p>Sponsorship denied by dashboard policy.</p>
            <p className="mt-1 font-mono text-2xs break-all">
              {sponsoredDenied.serverMessage}
            </p>
            <p className="mt-1">{sponsoredDenied.dashboardAction}</p>
          </div>
        ) : null}
        {sponsoredError ? (
          <p
            className="mt-2 text-xs text-red-600 dark:text-red-400"
            role="alert"
            data-testid="sponsored-error"
          >
            {sponsoredError}
          </p>
        ) : null}
        {sponsoredResult ? (
          <div
            className="mt-3 text-xs text-black/70 dark:text-white/70"
            role="status"
            data-testid="sponsored-result"
          >
            <p className="font-medium text-black dark:text-white">
              Sponsored UserOperation landed on Sepolia.
            </p>
            <dl className="mt-1 space-y-0.5 font-mono text-2xs break-all">
              <div>
                <dt className="inline">sender </dt>
                <dd className="inline">{sponsoredResult.sender}</dd>
              </div>
              <div>
                <dt className="inline">tx </dt>
                <dd className="inline">{sponsoredResult.txHash}</dd>
              </div>
              <div>
                <dt className="inline">block </dt>
                <dd className="inline">
                  {BigInt(sponsoredResult.blockNumber).toString()} (
                  {sponsoredResult.deployed
                    ? "deployed this run"
                    : "pre-deployed"}
                  {sponsoredResult.success ? "" : ", userOp reported failure"})
                </dd>
              </div>
              <div>
                <dt className="inline">gas used </dt>
                <dd className="inline">
                  {BigInt(sponsoredResult.gasUsed).toString()} (sponsored by{" "}
                  {sponsoredResult.paymaster})
                </dd>
              </div>
            </dl>
            <button
              type="button"
              onClick={copySponsoredResult}
              className="mt-2 rounded-full border border-input bg-background px-3 py-1 text-xs font-medium"
              data-testid="sponsored-copy"
            >
              {copiedResult ? "Result copied" : "Copy result"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
