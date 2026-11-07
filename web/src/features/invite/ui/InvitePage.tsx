import { Link } from "@tanstack/react-router";

import { APP_NAME } from "@/shared/constants/brand";
import { CreatonMark } from "@/shared/ui/CreatonMark";
import { DESKTOP_APP } from "@/shared/lib/desktop-app";
import { claimInviteInBrowser } from "@/features/invite/invite-api";
import {
  BUZZ_RELEASES_URL,
  type BuzzDownloadPlatform,
  detectBuzzDownloadPlatform,
  resolveBuzzDownloadUrlForPlatform,
} from "@/shared/lib/buzz-download";
import { getOrCreateIdentity, hasStoredIdentity } from "@/shared/lib/identity";
import { saveNewProfile } from "@/features/identity/lib/profile";
import { hasNip07Provider } from "@/shared/lib/nostr-signer";

import {
  createPasskeyIdentity,
  hasPasskeyIdentity,
  isPasskeyActive,
  onPasskeySessionChange,
  signInPasskeyIdentity,
} from "@/features/identity/lib/passkey-identity";
import {
  passkeyCreateProblem,
  passkeyUnlockProblem,
} from "@/features/identity/lib/passkey-problem";
import { RecoveryKeyDialog } from "@/features/identity/ui/RecoveryKeyDialog";
import {
  rememberAcceptance,
  rememberNoAgreement,
} from "@/features/identity/lib/policy-acceptance";
import {
  communityHostName,
  inviteRelayWsUrl,
  setStoredRelayWsUrl,
} from "@/shared/lib/relay-url";
import { desktopJoinDeepLink } from "@/shared/lib/desktop-deep-link";
import { Button } from "@/shared/ui/button";
import { Fingerprint } from "lucide-react";
import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { acceptJoinPolicy, POLICY_TIMEOUT_MS } from "../accept-policy";
import { type InviteCodeProblem, inviteCodeProblem } from "../invite-code";
import { type InviteProblem, inviteProblem } from "../invite-errors";
import { InviteJoinPolicyNotice } from "./InviteJoinPolicyNotice";

type JoinPolicy = {
  terms_markdown?: string;
  privacy_markdown?: string;
  age_attestation_required: boolean;
  version: string;
};

type PolicyDocument = { title: string; markdown: string };

/** The server's terms as this page has them: still asked for, could not be had, or here (null when it has none). */
type PolicyLoad =
  | { status: "loading" }
  | { status: "failed"; detail: string }
  | { status: "ready"; policy: JoinPolicy | null };

/** What the join button is waiting for, so it can say so. */
type JoinStep = "passkey" | "joining" | null;

/** Whether this browser can make a passkey at all (it is offered only where it can work). */
function passkeysAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined"
  );
}

function problemText(text: string): InviteProblem {
  return { text, detail: null, reloadTerms: false };
}

/** The invite landing's yellow-to-blue wash behind its white card. */
const PAGE_BACKGROUND = {
  backgroundImage: "linear-gradient(180deg, #D7D72E 0%, #D7E7F6 100%)",
};

/** Landing page for a community invite link (`/invite/<code>`). */
export function InvitePage({ code }: { code: string }) {
  // A link that cannot be an invite is said so before anyone makes an account for it.
  const problem = inviteCodeProblem(code);
  return problem ? (
    <BrokenInvite problem={problem} />
  ) : (
    <InviteLanding code={code} />
  );
}

function BrokenInvite({ problem }: { problem: InviteCodeProblem }) {
  // The app's own background and buttons: this is an answer from the app, not the branded invite landing.
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center bg-background px-4 py-16 text-center"
      data-testid="invite-broken"
    >
      <div className="flex w-full max-w-xl flex-col items-center rounded-3xl border bg-card px-6 py-10 sm:px-12 sm:py-12">
        <div
          className="h-12 w-12 overflow-hidden bg-black"
          style={{ borderRadius: "22.37%" }}
        >
          <CreatonMark className="h-full w-full" label={APP_NAME} />
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">
          {problem === "expired"
            ? "This invite has expired"
            : "This invite link doesn't work"}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Ask the person who sent it for a new one.
        </p>
        <Button asChild className="mt-8">
          <Link to="/">Home</Link>
        </Button>
      </div>
    </div>
  );
}

function InviteLanding({ code }: { code: string }) {
  const relay = inviteRelayWsUrl();
  const host = relay.replace(/^wss?:\/\//, "");
  const [policyLoad, setPolicyLoad] = React.useState<PolicyLoad>({
    status: "loading",
  });
  const policy: JoinPolicy | null | undefined =
    policyLoad.status === "ready" ? policyLoad.policy : undefined;
  const [document, setDocument] = React.useState<PolicyDocument | null>(null);
  const [ageConfirmed, setAgeConfirmed] = React.useState(false);
  const [agreementConfirmed, setAgreementConfirmed] = React.useState(false);
  const [opening, setOpening] = React.useState(false);
  const [joinStep, setJoinStep] = React.useState<JoinStep>(null);
  const joiningBrowser = joinStep !== null;
  const [newName, setNewName] = React.useState("");
  const [joinProblem, setJoinProblem] = React.useState<InviteProblem | null>(
    null,
  );
  /** A passkey account made here and now in the community: its recovery key is offered before going on. */
  const [joinedWithPasskey, setJoinedWithPasskey] = React.useState<
    string | null
  >(null);
  /** The passkey account made on this page, kept if the first join attempt failed so a retry still offers its key. */
  const madePasskeyAccount = React.useRef<string | null>(null);
  // The passkey session lives outside React: re-render when it is unlocked or made, here or anywhere else.
  const [, setPasskeySession] = React.useState(0);
  React.useEffect(
    () => onPasskeySessionChange(() => setPasskeySession((n) => n + 1)),
    [],
  );
  const [downloadUrl, setDownloadUrl] = React.useState(BUZZ_RELEASES_URL);
  const [needsMacChoice, setNeedsMacChoice] = React.useState(false);
  const [showMacChoice, setShowMacChoice] = React.useState(false);
  const [choosingMacDownload, setChoosingMacDownload] = React.useState(false);
  const choosingMacDownloadRef = React.useRef(false);
  const downloadTriggerRef = React.useRef<HTMLAnchorElement>(null);

  React.useEffect(() => {
    let active = true;
    detectBuzzDownloadPlatform(navigator).then(async (platform) => {
      if (!active) return;
      if (
        platform.operatingSystem === "macos" &&
        platform.architecture === "unknown"
      ) {
        setNeedsMacChoice(true);
        return;
      }
      const url = await resolveBuzzDownloadUrlForPlatform(platform);
      if (active) setDownloadUrl(url);
    });
    return () => {
      active = false;
    };
  }, []);

  // Only the newest load may set the terms: "Try again" and a reload after the terms changed each start a new one.
  const policyGeneration = React.useRef(0);
  const loadPolicy = React.useCallback(() => {
    const mine = ++policyGeneration.current;
    setPolicyLoad({ status: "loading" });
    fetch("/api/join-policy", {
      signal: AbortSignal.timeout(POLICY_TIMEOUT_MS),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const config = (await response.json()) as { policy?: JoinPolicy };
        return config.policy ?? null;
      })
      .then(
        (loaded) => {
          if (mine === policyGeneration.current)
            setPolicyLoad({ status: "ready", policy: loaded });
        },
        (error: unknown) => {
          if (mine === policyGeneration.current)
            setPolicyLoad({
              status: "failed",
              detail: error instanceof Error ? error.message : String(error),
            });
        },
      );
  }, []);
  React.useEffect(() => {
    loadPolicy();
    return () => {
      policyGeneration.current += 1;
    };
  }, [loadPolicy]);

  /**
   * Whether joining must wait: the terms are not loaded yet (or could not be), or a box they ask for is not ticked.
   * The buttons are off while this is true, and every handler that makes or uses an account checks it again.
   */
  const disabled =
    policy === undefined ||
    opening ||
    joiningBrowser ||
    Boolean(policy?.age_attestation_required && !ageConfirmed) ||
    Boolean(
      policy &&
        (policy.terms_markdown || policy.privacy_markdown) &&
        !agreementConfirmed,
    );

  const acceptPolicy = async (): Promise<string | undefined> => {
    if (!policy) return undefined;
    return acceptJoinPolicy({
      code,
      version: policy.version,
      ageConfirmed,
    });
  };

  /** Say why joining did not work; terms that changed are loaded again, and their boxes asked for again. */
  const showProblem = (problem: InviteProblem) => {
    setJoinProblem(problem);
    if (problem.reloadTerms) {
      setAgeConfirmed(false);
      setAgreementConfirmed(false);
      loadPolicy();
    }
  };

  const openInvite = async () => {
    if (disabled) return;
    setJoinProblem(null);
    setOpening(true);
    try {
      const receipt = await acceptPolicy();
      window.location.href = desktopJoinDeepLink({
        relay,
        code,
        policyReceipt: receipt,
      });
    } catch (error) {
      showProblem(inviteProblem(error));
    } finally {
      setOpening(false);
    }
  };

  /**
   * Agree to the terms, claim the invite with the account this browser signs with, and point the browser at the
   * community. A name typed here is saved after the join (a private community would refuse a profile from a stranger);
   * if the server does not take it now, it is kept on this device and saved the next time the app opens, and the join
   * stands either way.
   */
  const claimAndJoin = async (name: string) => {
    setJoinStep("joining");
    const receipt = await acceptPolicy();
    await claimInviteInBrowser(code, relay, receipt);
    // From now on this browser is in the community the invite was for.
    setStoredRelayWsUrl(relay);
    // The terms agreed to above count as agreed to here, so the first visit does not ask again. A server with no terms
    // gave nothing to agree to, and an older agreement in this browser must not stand in for it.
    if (policy) rememberAcceptance(policy.version, communityHostName());
    else rememberNoAgreement(communityHostName());
    if (name) await saveNewProfile({ name });
  };

  // A passkey account's key exists only while its passkey is unlocked, and nothing else on this page unlocks it.
  const passkeyLocked = hasPasskeyIdentity() && !isPasskeyActive();

  const joinInBrowser = async () => {
    if (disabled) return;
    setJoinProblem(null);
    if (passkeyLocked) {
      setJoinStep("passkey");
      try {
        await signInPasskeyIdentity();
      } catch (error) {
        setJoinProblem(problemText(passkeyUnlockProblem(error)));
        setJoinStep(null);
        return;
      }
    }
    try {
      // A name typed while making an account here, before a join that failed, is still theirs to save.
      await claimAndJoin(newName.trim());
      if (madePasskeyAccount.current)
        setJoinedWithPasskey(madePasskeyAccount.current);
      else window.location.assign("/");
    } catch (error) {
      showProblem(inviteProblem(error));
    } finally {
      setJoinStep(null);
    }
  };

  /** For someone with no account yet: make one in this browser, then join with it. */
  const createAccountAndJoin = async () => {
    if (disabled) return;
    setJoinProblem(null);
    try {
      getOrCreateIdentity();
      await claimAndJoin(newName.trim());
      window.location.assign("/");
    } catch (error) {
      showProblem(inviteProblem(error));
    } finally {
      setJoinStep(null);
    }
  };

  /**
   * The same with a passkey for an account. A passkey signs in only in this browser, so once they are in, the
   * recovery key that works everywhere is offered while the passkey is still unlocked.
   */
  const createPasskeyAndJoin = async () => {
    if (disabled) return;
    setJoinProblem(null);
    setJoinStep("passkey");
    let account: string;
    try {
      account = (await createPasskeyIdentity(newName.trim() || "Creaton user"))
        .pubkey;
      madePasskeyAccount.current = account;
    } catch (error) {
      setJoinProblem(
        problemText(
          passkeyCreateProblem(error, "create an account without one"),
        ),
      );
      setJoinStep(null);
      return;
    }
    try {
      await claimAndJoin(newName.trim());
      setJoinedWithPasskey(account);
    } catch (error) {
      showProblem(inviteProblem(error));
    } finally {
      setJoinStep(null);
    }
  };

  // Any identity that survives a reload can claim: the stored nsec this app
  // creates for a browser reader, a passkey, or an extension. Gating on the
  // extension alone hid the button from browser users entirely.
  const browserSigningAvailable =
    hasNip07Provider() || hasStoredIdentity() || hasPasskeyIdentity();
  const busyLabel =
    joinStep === "passkey" ? "Waiting for your passkey…" : "Joining…";
  const hasPolicyRequirements = Boolean(
    policy &&
      (policy.age_attestation_required ||
        policy.terms_markdown ||
        policy.privacy_markdown),
  );
  const showDocument = (title: string, markdown: string) =>
    setDocument({ title, markdown });
  const closeMacChoice = React.useCallback(() => {
    setShowMacChoice(false);
    window.setTimeout(() => downloadTriggerRef.current?.focus());
  }, []);
  const chooseMacDownload = async (
    event: React.MouseEvent<HTMLAnchorElement>,
    platform: BuzzDownloadPlatform,
  ) => {
    event.preventDefault();
    if (choosingMacDownloadRef.current) return;
    choosingMacDownloadRef.current = true;
    setChoosingMacDownload(true);
    const downloadWindow = window.open("about:blank", "_blank");
    if (downloadWindow) downloadWindow.opener = null;
    setShowMacChoice(false);
    try {
      const url = await resolveBuzzDownloadUrlForPlatform(platform);
      downloadWindow?.location.replace(url);
    } finally {
      choosingMacDownloadRef.current = false;
      setChoosingMacDownload(false);
    }
  };

  React.useEffect(() => {
    if (!showMacChoice) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMacChoice();
    };
    window.document.addEventListener("keydown", closeOnEscape);
    return () => window.document.removeEventListener("keydown", closeOnEscape);
  }, [closeMacChoice, showMacChoice]);

  return (
    <div
      className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center"
      style={PAGE_BACKGROUND}
    >
      <div className="w-full max-w-xl space-y-4">
        <div className="flex w-full flex-col items-center rounded-3xl bg-white px-6 py-10 sm:px-12 sm:py-12">
          <div
            className="h-12 w-12 overflow-hidden bg-black"
            style={{ borderRadius: "22.37%" }}
          >
            <CreatonMark className="h-full w-full" label={APP_NAME} />
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-black">
            You&apos;re invited to a community on {APP_NAME}
          </h1>
          <p className="mt-2 text-sm text-black/60" data-testid="invite-host">
            {host}
          </p>

          <div
            className={`grid w-full max-w-md overflow-hidden transition-[grid-template-rows,margin,opacity,transform] duration-[220ms] [transition-timing-function:cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
              hasPolicyRequirements
                ? "mt-9 -mb-4 grid-rows-[1fr] opacity-100 translate-y-0"
                : "m-0 grid-rows-[0fr] opacity-0 -translate-y-1"
            }`}
          >
            <div className="min-h-0 overflow-hidden">
              {policy && hasPolicyRequirements ? (
                <InviteJoinPolicyNotice
                  ageConfirmed={ageConfirmed}
                  agreementConfirmed={agreementConfirmed}
                  onAgeConfirmedChange={setAgeConfirmed}
                  onAgreementConfirmedChange={setAgreementConfirmed}
                  onShowDocument={showDocument}
                  policy={policy}
                />
              ) : null}
            </div>
          </div>

          {policyLoad.status === "loading" ? (
            <p
              className="mt-9 text-sm text-black/60"
              data-testid="invite-policy-loading"
              role="status"
            >
              Loading this server's terms…
            </p>
          ) : policyLoad.status === "failed" ? (
            <div
              className="mt-9 w-full max-w-md rounded-xl border border-black/10 bg-black/[0.03] p-4 text-left"
              data-testid="invite-policy-failed"
            >
              <p className="text-sm text-black" role="alert">
                Couldn't load this server's terms. You need to agree to them
                before you join.
              </p>
              <Button
                className="mt-3 h-9 border border-black bg-white px-4 text-black hover:bg-black/5"
                data-testid="invite-policy-retry"
                onClick={loadPolicy}
              >
                Try again
              </Button>
              <details className="mt-3 text-xs text-black/60">
                <summary className="cursor-pointer">Technical details</summary>
                <p className="mt-1 break-words font-mono">
                  {policyLoad.detail}
                </p>
              </details>
            </div>
          ) : null}

          <div className="mt-9 w-full max-w-md space-y-2">
            {browserSigningAvailable ? (
              <>
                {passkeyLocked ? (
                  <p
                    className="text-sm text-black/70"
                    data-testid="invite-passkey-locked"
                    id="invite-passkey-locked"
                  >
                    Your account in this browser uses a passkey. Unlock it to
                    join.
                  </p>
                ) : null}
                <Button
                  aria-describedby={
                    passkeyLocked ? "invite-passkey-locked" : undefined
                  }
                  className="h-10 w-full bg-black text-white hover:bg-black/90 focus-visible:ring-black disabled:cursor-not-allowed disabled:bg-black/30 disabled:text-white/70"
                  data-testid="invite-join"
                  disabled={disabled}
                  onClick={joinInBrowser}
                >
                  {joiningBrowser ? (
                    busyLabel
                  ) : passkeyLocked ? (
                    <>
                      <Fingerprint aria-hidden className="h-4 w-4" />
                      Unlock with your passkey
                    </>
                  ) : (
                    "Join this community"
                  )}
                </Button>
              </>
            ) : (
              <div
                className="space-y-2 text-left"
                data-testid="invite-new-account"
              >
                <label
                  className="text-sm font-medium text-black"
                  htmlFor="invite-name"
                >
                  No account yet? Pick a name and we will make one in this
                  browser.
                </label>
                <input
                  autoComplete="nickname"
                  className="h-10 w-full rounded-md border border-black/20 bg-white px-3 text-sm text-black"
                  data-testid="invite-name"
                  id="invite-name"
                  maxLength={60}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Your name"
                  value={newName}
                />
                <Button
                  className="h-10 w-full bg-black text-white hover:bg-black/90 focus-visible:ring-black disabled:cursor-not-allowed disabled:bg-black/30 disabled:text-white/70"
                  data-testid="invite-create-and-join"
                  disabled={disabled}
                  onClick={createAccountAndJoin}
                >
                  {joinStep === "joining"
                    ? busyLabel
                    : "Create an account and join"}
                </Button>
                {passkeysAvailable() ? (
                  <>
                    <Button
                      aria-describedby="invite-passkey-note"
                      className="h-10 w-full border border-black bg-white text-black hover:bg-black/5 disabled:cursor-not-allowed disabled:border-black/30 disabled:text-black/40"
                      data-testid="invite-passkey-create"
                      disabled={disabled}
                      onClick={createPasskeyAndJoin}
                    >
                      {joinStep === "passkey" ? (
                        busyLabel
                      ) : (
                        <>
                          <Fingerprint aria-hidden className="h-4 w-4" />
                          Create with a passkey
                        </>
                      )}
                    </Button>
                    <p
                      className="text-center text-xs text-black/60"
                      id="invite-passkey-note"
                    >
                      Sign in here with your fingerprint, face or device PIN. On
                      another device you need your recovery key, which you can
                      save next.
                    </p>
                  </>
                ) : null}
              </div>
            )}
            {!DESKTOP_APP ? null : policy === null ? (
              <Button
                asChild
                className="h-10 w-full border border-black bg-white text-black hover:bg-black/5"
              >
                <a href={desktopJoinDeepLink({ relay, code })}>
                  Accept invite in Creaton
                </a>
              </Button>
            ) : (
              <Button
                className="h-10 w-full border border-black bg-white text-black hover:bg-black/5 disabled:cursor-not-allowed disabled:bg-black/30 disabled:text-white/70"
                disabled={disabled}
                onClick={openInvite}
              >
                Accept invite in Creaton
              </Button>
            )}
            {joinProblem ? (
              <div className="text-left" data-testid="invite-join-problem">
                <p className="text-sm text-red-700" role="alert">
                  {joinProblem.text}
                </p>
                {joinProblem.detail ? (
                  <details className="mt-1 text-xs text-black/60">
                    <summary className="cursor-pointer">
                      Technical details
                    </summary>
                    <p className="mt-1 break-words font-mono">
                      {joinProblem.detail}
                    </p>
                  </details>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        {DESKTOP_APP ? (
          <p className="flex h-[3.125rem] items-center justify-center rounded-2xl bg-white text-sm text-black/60">
            Don&apos;t have the app?{" "}
            <a
              aria-expanded={needsMacChoice ? showMacChoice : undefined}
              aria-haspopup={needsMacChoice ? "dialog" : undefined}
              className="ml-1 font-medium text-black underline-offset-4 hover:text-black/70 hover:underline focus-visible:underline"
              href={downloadUrl}
              ref={downloadTriggerRef}
              rel="noreferrer"
              target="_blank"
              onClick={(event) => {
                if (!needsMacChoice) return;
                event.preventDefault();
                setShowMacChoice(true);
              }}
            >
              Download it now
            </a>
            <span aria-hidden="true" className="mx-1.5 text-black/30">
              ·
            </span>
            <a
              className="font-medium text-black underline-offset-4 hover:text-black/70 hover:underline focus-visible:underline"
              href={BUZZ_RELEASES_URL}
              rel="noreferrer"
              target="_blank"
            >
              Browse releases
            </a>
          </p>
        ) : null}
      </div>

      {showMacChoice && (
        <div
          aria-label="Which Mac do you have?"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 text-left"
          role="dialog"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeMacChoice();
          }}
        >
          <div className="w-full max-w-lg rounded-3xl bg-white p-7 text-black shadow-xl sm:p-9">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">
                  Which Mac do you have?
                </h2>
                <p className="mt-2 text-sm text-black/60">
                  Choose based on when your Mac was released.
                </p>
              </div>
              <button
                aria-label="Close"
                className="text-2xl leading-none text-black/60 hover:text-black"
                type="button"
                onClick={closeMacChoice}
              >
                ×
              </button>
            </div>
            <div className="mt-6 grid gap-3">
              <a
                aria-disabled={choosingMacDownload}
                className="rounded-2xl border border-black p-5 text-black no-underline hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black aria-disabled:pointer-events-none aria-disabled:opacity-50"
                href={BUZZ_RELEASES_URL}
                onClick={(event) =>
                  void chooseMacDownload(event, {
                    operatingSystem: "macos",
                    architecture: "arm64",
                  })
                }
              >
                <strong className="block text-lg">Newer Mac</strong>
                <span className="mt-1 block text-sm">
                  2021 or later, or a late-2020 Mac with an Apple M1 chip
                </span>
              </a>
              <a
                aria-disabled={choosingMacDownload}
                className="rounded-2xl border border-black p-5 text-black no-underline hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black aria-disabled:pointer-events-none aria-disabled:opacity-50"
                href={BUZZ_RELEASES_URL}
                onClick={(event) =>
                  void chooseMacDownload(event, {
                    operatingSystem: "macos",
                    architecture: "x64",
                  })
                }
              >
                <strong className="block text-lg">Older Mac</strong>
                <span className="mt-1 block text-sm">
                  2019 or earlier, or a 2020 Mac with an Intel processor
                </span>
              </a>
            </div>
            <p className="mt-5 text-sm leading-5">
              <strong>Not sure?</strong> Open the Apple menu and choose{" "}
              <strong>About This Mac</strong>. “Chip: Apple M…” means Newer Mac.
              “Processor: Intel” means Older Mac.
            </p>
          </div>
        </div>
      )}

      {joinedWithPasskey ? (
        <RecoveryKeyDialog
          account={joinedWithPasskey}
          closeLabel="Continue"
          intro="You're in."
          onClose={() => window.location.assign("/")}
        />
      ) : null}

      {document && (
        <div
          aria-label={document.title}
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 text-left"
          role="dialog"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setDocument(null);
          }}
        >
          <div className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-6 text-black shadow-xl sm:p-8">
            <div className="mb-6 flex items-start justify-between gap-4">
              <h2 className="text-xl font-semibold">{document.title}</h2>
              <button
                aria-label="Close"
                className="text-2xl leading-none text-black/60 hover:text-black"
                type="button"
                onClick={() => setDocument(null)}
              >
                ×
              </button>
            </div>
            <div className="prose prose-sm max-w-none">
              <Markdown remarkPlugins={[remarkGfm]}>
                {document.markdown}
              </Markdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
