/**
 * The "you" chip + profile menu: identity, edit profile, backup, sign out.
 */

import { useEffect, useState, useRef } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  KeyRound,
  LogOut,
  Pencil,
  UserPlus,
} from "lucide-react";

import {
  existingUserPubkey,
  hasStoredIdentity,
  forgetIdentity,
  StoredIdentityUnreadableError,
  storedIdentityHex,
} from "@/shared/lib/identity";
import { IdentityRecoveryBanner } from "./IdentityRecoveryBanner";
import {
  useProfiles,
  resolveUserName,
  resolveUserSecondaryName,
} from "@/features/profiles/use-profiles";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { useQueryClient } from "@tanstack/react-query";
import {
  publishProfile,
  publishRememberedProfile,
  rememberOwnProfile,
} from "../lib/profile";
import { passkeyModeCopy } from "../lib/mode-copy";
import { useTheme } from "@/shared/theme/ThemeProvider";
import {
  useTypography,
  type FontSize,
} from "@/shared/theme/TypographyProvider";
import { readWalletBinding, revokeWalletBinding } from "../lib/siwe";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { OnboardingDialog } from "./OnboardingDialog";
import { CREATE_ACCOUNT, SIGN_UP_EVENT } from "../lib/account-copy";
import {
  backedUpFor,
  type RecoveryExport,
  recoveryExportFor,
} from "../lib/recovery-key";
import {
  setupPasskey,
  signInPasskeyIdentity,
  hasPasskeyIdentity,
  isPasskeyActive,
  passkeyMode,
  passkeySecretKey,
  removePasskeyIdentity,
  registerPasskeySigner,
} from "../lib/passkey-identity";
import { Fingerprint, Wallet } from "lucide-react";
import { Overlay, Portal, useAnchoredStyle } from "@/shared/ui/portal";

const BACKED_UP_KEY = "buzz.identity.backedUp";

// Side-effect: make the passkey signer the primary signer while a passkey
// session is active. Runs on first import of this module (mounted always).
void registerPasskeySigner();

/** How a passkey registered here holds the key, or null without one. */
function passkeyHolding(): "prf" | "unlock" | null {
  return hasPasskeyIdentity() ? passkeyMode() : null;
}

/** Whether this account's recovery key was saved from this browser (D111: per account, after a real export). */
export function hasBackedUp(): boolean {
  try {
    return backedUpFor(
      localStorage.getItem(BACKED_UP_KEY),
      existingUserPubkey(),
      passkeyHolding(),
    );
  } catch {
    return true;
  }
}

function markBackedUp(account: string) {
  try {
    localStorage.setItem(BACKED_UP_KEY, account.toLowerCase());
  } catch {
    // Not remembered: the reminder simply stays.
  }
}

/**
 * This account's recovery key, from wherever this browser holds it (`recoveryExportFor`): the one source for every
 * backup the menu offers, so none can save an empty key or another identity's.
 */
function currentRecovery(account: string): RecoveryExport {
  let stored: string | null = null;
  try {
    stored = storedIdentityHex();
  } catch {
    stored = null;
  }
  const secret = passkeySecretKey();
  return recoveryExportFor(account || null, {
    passkey: passkeyHolding(),
    passkeySecret: secret
      ? Array.from(secret, (byte) => byte.toString(16).padStart(2, "0")).join(
          "",
        )
      : null,
    stored,
  });
}

/** Copy the key, and count it as saved only once the clipboard took it. */
function copyRecoveryKey(hex: string, account: string) {
  void navigator.clipboard
    ?.writeText(hex)
    .then(() => {
      markBackedUp(account);
      return import("sonner").then(({ toast }) =>
        toast.success("Recovery key copied"),
      );
    })
    .catch(() =>
      import("sonner").then(({ toast }) =>
        toast.error("Couldn't copy it. Try Download instead."),
      ),
    );
}

/**
 * Where the menu is mounted. `sidebar` is the full-width chip; `rail` (the
 * global nav on wide screens) and `tabbar` (the phone bottom bar) show only the
 * avatar, keeping the name and username as the button's accessible text.
 * `header` is the top bar on wide screens: the avatar, or a "Sign up" button
 * until there is an identity.
 */
export type ProfileMenuPlacement = "sidebar" | "rail" | "tabbar" | "header";

/** Where the popover sits against its trigger, now that it is measured. */
const ANCHOR: Record<
  ProfileMenuPlacement,
  "above-left" | "right" | "above-right" | "below-right"
> = {
  sidebar: "above-left",
  rail: "right",
  tabbar: "above-right",
  header: "below-right",
};

export function ProfileMenu({
  placement = "sidebar",
}: {
  placement?: ProfileMenuPlacement;
} = {}) {
  const compact = placement !== "sidebar";
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  // Portalled and measured against the trigger: the header's blur would
  // otherwise trap this popover in its own stacking context.
  const popoverStyle = useAnchoredStyle(triggerRef, open, ANCHOR[placement]);
  // Read once at mount; sign out / import reload the page, so no setter
  // is needed — "create identity" itself reloads on completion.
  const [created, setCreated] = useState(
    () => hasStoredIdentity() || hasPasskeyIdentity(),
  );
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [editName, setEditName] = useState<string | null>(null);
  const [editAbout, setEditAbout] = useState("");
  const [saving, setSaving] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [showBackup, setShowBackup] = useState(false);
  const [revealKey, setRevealKey] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const { theme, setTheme } = useTheme();
  const { fontSize, density, setFontSize, setDensity } = useTypography();
  const [walletBinding, setWalletBinding] = useState(() => readWalletBinding());
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  // `existingUserPubkey` reports the passkey identity when one is registered, so
  // this no longer has to prefer it by hand and drift from the filters.
  const pubkey = existingUserPubkey() ?? "";
  const { data: profiles } = useProfiles(pubkey ? [pubkey] : []);
  const profile = pubkey ? profiles?.[pubkey] : undefined;
  const resolvedName = resolveUserName(profile, pubkey);
  // The community username when this identity has claimed one; the recognisable
  // pubkey otherwise. The full pubkey stays available as a tooltip so the
  // username never hides the identity that actually signs.
  const secondaryName = resolveUserSecondaryName(profile, pubkey);
  // An account with no name yet would show its short key twice: say what it is instead.
  const displayName =
    resolvedName === secondaryName ? "Your account" : resolvedName;

  // Other surfaces (the Home welcome) ask for the sign-up dialog rather than
  // owning a second copy of it.
  useEffect(() => {
    const open = () => setShowOnboarding(true);
    window.addEventListener(SIGN_UP_EVENT, open);
    return () => window.removeEventListener(SIGN_UP_EVENT, open);
  }, []);

  // Auto sign-in on boot for PRF-mode passkeys (one touch; instant in the
  // mock). Unlock mode is left to the PasskeyUnlockGate overlay instead.
  useEffect(() => {
    if (hasPasskeyIdentity() && passkeyMode() === "prf" && !isPasskeyActive()) {
      void signInPasskeyIdentity().catch((e) => {
        console.error("[passkey] auto sign-in failed", e);
      });
    }
  }, []);

  // A profile follows the person: remembered when a community shows it, and given to a community that has none for them.
  const queryClient = useQueryClient();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pubkey` is the trigger: a new sign-in may have a profile to carry.
  useEffect(() => {
    void publishRememberedProfile().then((published) => {
      if (published)
        void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    });
  }, [pubkey, queryClient]);
  useEffect(() => {
    if (profile) rememberOwnProfile(profile as Record<string, unknown>);
  }, [profile]);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const handler = (e: MouseEvent) => {
      // The popover is portalled to the document root, so it is not inside the
      // trigger's element: a press inside either one is not "outside".
      if (
        !(e.target as HTMLElement).closest(
          "[data-testid='profile-menu'], [data-testid='profile-popover']",
        )
      ) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const saveProfile = async () => {
    if (!editName?.trim()) return;
    setSaving(true);
    setMenuError(null);
    try {
      // Hand over the current profile: kind 0 is replaceable, so anything the
      // editor does not carry has to be merged back in.
      await publishProfile(
        { name: editName, about: editAbout || undefined },
        profile as Record<string, unknown> | undefined,
      );
      setEditName(null);
    } catch (e) {
      setMenuError(e instanceof Error ? e.message : "couldn't save");
    } finally {
      setSaving(false);
    }
  };

  const passkeyActive = isPasskeyActive();
  const passkeySetUp = hasPasskeyIdentity();
  const passkeyModeNow = passkeyMode();
  const recovery = currentRecovery(pubkey);

  const runPasskey = async (fn: () => Promise<unknown>) => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      await fn();
      setPasskeyBusy(false);
      setOpen(false);
    } catch (e) {
      setPasskeyError(e instanceof Error ? e.message : "passkey failed");
      setPasskeyBusy(false);
    }
  };

  // Render boundary for the always-mounted nav: a stored-but-unreadable key
  // must degrade to the inline recovery banner below, never throw through the
  // root error boundary — where the Import/Reset recovery would be unreachable.
  let identityUnreadable = false;
  try {
    storedIdentityHex();
  } catch (error) {
    if (!(error instanceof StoredIdentityUnreadableError)) throw error;
    identityUnreadable = true;
  }

  if (identityUnreadable) {
    return <IdentityRecoveryBanner />;
  }

  if (!created) {
    return (
      <div
        className={
          compact
            ? ""
            : "border-t border-black/10 px-3 py-2.5 dark:border-white/10"
        }
      >
        <button
          type="button"
          onClick={() => setShowOnboarding(true)}
          className={
            placement === "header"
              ? "inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground shadow-[0_6px_16px_-6px_hsl(var(--primary)/0.6)] transition hover:brightness-110"
              : compact
                ? "grid h-10 w-10 place-items-center rounded-full border border-dashed border-black/30 text-black/70 hover:bg-black/5 dark:border-white/30 dark:text-white/70 dark:hover:bg-white/10"
                : "flex w-full items-center gap-2 rounded-md border border-dashed border-black/20 px-2 py-2 text-left text-sm text-black/60 hover:bg-black/5 dark:border-white/20 dark:text-white/60 dark:hover:bg-white/10"
          }
          data-testid="create-identity-cta"
          title={compact ? CREATE_ACCOUNT : undefined}
        >
          {placement === "header" ? null : (
            <UserPlus aria-hidden className="h-4 w-4" />
          )}
          <span
            className={
              compact && placement !== "header" ? "sr-only" : undefined
            }
          >
            {placement === "header" ? "Sign up" : CREATE_ACCOUNT}
          </span>
        </button>
        {showOnboarding ? (
          <OnboardingDialog
            onDone={() => {
              // Reload so the fresh profile (kind 0) renders in the chip.
              window.location.reload();
            }}
            onPasskeyDone={() => {
              // Passkey setup re-renders in place — no reload, no extra
              // ceremony; the session is already active with the derived key.
              setCreated(true);
              setShowOnboarding(false);
              setOpen(false);
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div data-testid="profile-menu" className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={
          compact
            ? "relative grid h-10 w-10 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            : "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/10"
        }
        data-testid="user-chip"
        title={compact ? displayName : undefined}
      >
        <UserAvatar
          avatarUrl={profile?.picture ?? null}
          displayName={displayName}
          size="sm"
        />
        <span className={compact ? "sr-only" : "min-w-0 flex-1"}>
          <span className="block truncate text-sm font-medium text-black dark:text-white">
            {displayName}
          </span>
          <span
            className="block truncate font-mono text-2xs text-black/60 dark:text-white/60"
            data-testid="user-chip-username"
            title={pubkey}
          >
            {secondaryName}
          </span>
        </span>
        {!hasBackedUp() ? (
          <KeyRound
            aria-hidden
            className={
              compact
                ? "absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full bg-background text-amber-500"
                : "h-3.5 w-3.5 shrink-0 text-amber-500"
            }
          />
        ) : null}
      </button>

      {open ? (
        <Portal>
          <div
            className="fixed z-50 max-h-[80dvh] w-72 overflow-y-auto rounded-xl border border-black/10 bg-background p-3 shadow-xl dark:border-white/10"
            data-testid="profile-popover"
            style={popoverStyle}
          >
            {!hasBackedUp() ? (
              <p className="mb-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-2xs text-amber-900 dark:text-amber-200">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Save a recovery key. Your account only exists in this browser.
              </p>
            ) : null}

            <div className="flex items-center gap-2">
              <UserAvatar
                avatarUrl={profile?.picture ?? null}
                displayName={displayName}
                size="md"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-black dark:text-white">
                  {displayName}
                </p>
                <p
                  className="truncate font-mono text-2xs text-black/60 dark:text-white/60"
                  data-testid="profile-menu-username"
                  title={pubkey}
                >
                  {secondaryName}
                </p>
              </div>
            </div>

            {editName !== null ? (
              <div className="mt-2 space-y-2">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Display name"
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                  data-testid="profile-name-input"
                />
                <textarea
                  value={editAbout}
                  onChange={(e) => setEditAbout(e.target.value)}
                  placeholder="About you"
                  rows={2}
                  className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                  data-testid="profile-about-input"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditName(null)}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={saving || editName.trim().length === 0}
                    onClick={() => void saveProfile()}
                    className="rounded-full bg-black px-3 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
                    data-testid="profile-save"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 space-y-0.5">
                <MenuItem
                  icon={<Pencil className="h-3.5 w-3.5" />}
                  label="Edit profile"
                  onClick={() => {
                    setEditName(profile?.display_name ?? profile?.name ?? "");
                    setEditAbout(profile?.about ?? "");
                  }}
                />
                <MenuItem
                  icon={<KeyRound className="h-3.5 w-3.5" />}
                  label={hasBackedUp() ? "Recovery key" : "Save a recovery key"}
                  onClick={() => setShowBackup(true)}
                />
                <div className="px-2 py-1.5">
                  <p className="text-xs text-black/60 dark:text-white/60">
                    Appearance
                  </p>
                  <div
                    className="mt-1 flex items-center gap-1"
                    data-testid="theme-control"
                  >
                    {(["system", "light", "dark"] as const).map((option) => (
                      <button
                        className={`rounded-md border px-2 py-1 text-xs font-medium capitalize ${
                          theme === option
                            ? "border-black/30 bg-black/10 dark:border-white/30 dark:bg-white/15"
                            : "border-black/15 dark:border-white/15"
                        }`}
                        data-testid={`theme-${option}`}
                        key={option}
                        onClick={() => setTheme(option)}
                        type="button"
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-black/60 dark:text-white/60">
                    Text size
                  </p>
                  <div
                    className="mt-1 flex items-center gap-1"
                    data-testid="font-size-control"
                  >
                    {(["smaller", "default", "larger"] as const).map(
                      (option) => (
                        <button
                          className={`rounded-md border px-2 py-1 text-xs font-medium capitalize ${
                            fontSize === option
                              ? "border-black/30 bg-black/10 dark:border-white/30 dark:bg-white/15"
                              : "border-black/15 dark:border-white/15"
                          }`}
                          data-testid={`font-size-${option}`}
                          key={option}
                          onClick={() => setFontSize(option as FontSize)}
                          type="button"
                        >
                          {option}
                        </button>
                      ),
                    )}
                  </div>
                  <p className="mt-2 text-xs text-black/60 dark:text-white/60">
                    Conversation density
                  </p>
                  <div
                    className="mt-1 flex items-center gap-1"
                    data-testid="density-control"
                  >
                    {(["comfortable", "compact"] as const).map((option) => (
                      <button
                        className={`rounded-md border px-2 py-1 text-xs font-medium capitalize ${
                          density === option
                            ? "border-black/30 bg-black/10 dark:border-white/30 dark:bg-white/15"
                            : "border-black/15 dark:border-white/15"
                        }`}
                        data-testid={`density-${option}`}
                        key={option}
                        onClick={() => setDensity(option)}
                        type="button"
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>
                {passkeySetUp ? (
                  <div
                    className="mt-1 flex items-start gap-1.5 rounded-md bg-black/[0.03] px-2 py-1.5 text-2xs text-black/60 dark:bg-white/5 dark:text-white/60"
                    data-testid="passkey-mode-note"
                  >
                    <Fingerprint className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      {passkeyModeCopy(passkeyModeNow)}
                      {passkeyActive ? "" : ". Locked for this session."}
                    </span>
                  </div>
                ) : null}
                {passkeyActive ? (
                  <>
                    <MenuItem
                      icon={<KeyRound className="h-3.5 w-3.5" />}
                      label="Copy recovery key"
                      onClick={() => {
                        if (recovery.kind === "ready")
                          copyRecoveryKey(recovery.hex, pubkey);
                        else setShowBackup(true);
                      }}
                    />
                    <p
                      className="mb-1 px-2 text-2xs leading-4 text-black/55 dark:text-white/55"
                      data-testid="recovery-export-note"
                    >
                      Your recovery key signs you in on another device. Anyone
                      who has it can act as you, so keep it private. The passkey
                      itself stays on this device.
                    </p>
                    <MenuItem
                      icon={<LogOut className="h-3.5 w-3.5" />}
                      label="Remove passkey sign-in"
                      onClick={() => {
                        removePasskeyIdentity();
                        window.location.reload();
                      }}
                    />
                  </>
                ) : (
                  <MenuItem
                    icon={<Fingerprint className="h-3.5 w-3.5" />}
                    label={
                      passkeySetUp
                        ? "Sign in with passkey"
                        : "Set up passkey sign-in"
                    }
                    onClick={() => {
                      void runPasskey(
                        passkeySetUp
                          ? () => signInPasskeyIdentity()
                          : () => setupPasskey(displayName),
                      );
                    }}
                  />
                )}
              </div>
            )}
            {menuError ? (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                {menuError}
              </p>
            ) : null}
            {passkeyError ? (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {passkeyError}
              </p>
            ) : null}
            {passkeyBusy ? (
              <p className="mt-1 text-xs text-black/60 dark:text-white/60">
                Waiting for your passkey…
              </p>
            ) : null}

            {walletBinding ? (
              <div className="mt-2 border-t border-black/10 pt-2 dark:border-white/10">
                <div
                  className="flex items-center gap-1.5 rounded-md bg-black/[0.03] px-2 py-1.5 text-2xs text-black/60 dark:bg-white/5 dark:text-white/60"
                  data-testid="wallet-binding"
                >
                  <Wallet className="h-3 w-3" />
                  <span className="truncate">
                    Wallet {walletBinding.address.slice(0, 6)}…
                    {walletBinding.address.slice(-4)} connected
                  </span>
                </div>
                <MenuItem
                  icon={<Wallet className="h-3.5 w-3.5" />}
                  label={walletBusy ? "Disconnecting…" : "Disconnect wallet"}
                  onClick={() => setConfirmUnbind(true)}
                />
              </div>
            ) : null}
            {walletError ? (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {walletError}
              </p>
            ) : null}
            <div className="mt-2 border-t border-black/10 pt-2 dark:border-white/10">
              <MenuItem
                icon={<LogOut className="h-3.5 w-3.5" />}
                label="Sign out"
                onClick={() => {
                  setOpen(false);
                  setConfirmSignOut(true);
                }}
              />
            </div>
          </div>
        </Portal>
      ) : null}

      <ConfirmDialog
        confirmLabel="Disconnect"
        description="It can no longer act for your account here, and it cannot be connected to this account again."
        onCancel={() => setConfirmUnbind(false)}
        onConfirm={() => {
          setConfirmUnbind(false);
          setWalletBusy(true);
          setWalletError(null);
          void revokeWalletBinding()
            .then(() => setWalletBinding(null))
            .catch((error: unknown) =>
              setWalletError(
                error instanceof Error ? error.message : String(error),
              ),
            )
            .finally(() => setWalletBusy(false));
        }}
        open={confirmUnbind}
        title="Disconnect this wallet?"
      />

      {showBackup ? (
        <Overlay
          className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 dark:bg-black/50"
          data-testid="backup-dialog"
        >
          <div className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl">
            <h3 className="text-base font-semibold text-black dark:text-white">
              Save your recovery key
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              This secret key is your account: anyone who has it can act as you.
              Keep it somewhere private. You need it to sign in on another
              device, or if this browser is ever cleared.
            </p>
            {recovery.kind === "ready" ? (
              <div className="mt-3 rounded-md border border-input bg-black/[0.03] p-2 font-mono text-2xs break-all text-black/70 dark:bg-white/5 dark:text-white/70">
                {revealKey
                  ? recovery.hex
                  : `${recovery.hex.slice(0, 12)}…${recovery.hex.slice(-8)}`}
              </div>
            ) : (
              <p
                className="mt-3 rounded-md bg-amber-500/10 p-2 text-sm text-amber-900 dark:text-amber-200"
                data-testid="backup-unavailable"
                role="status"
              >
                {recovery.kind === "locked"
                  ? "Unlock with your passkey to show your recovery key."
                  : "Your recovery key can't be read in this browser, so there is nothing to save here. Stay signed in until you have it."}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {recovery.kind === "ready" ? (
                <>
                  <button
                    type="button"
                    onClick={() => setRevealKey((v) => !v)}
                    className="rounded-md border border-input bg-background px-3 py-1 text-xs font-medium"
                  >
                    {revealKey ? "Hide" : "Reveal"}
                  </button>
                  <button
                    type="button"
                    onClick={() => copyRecoveryKey(recovery.hex, pubkey)}
                    className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1 text-xs font-medium"
                    data-testid="backup-copy"
                  >
                    <Check className="h-3 w-3" /> Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const blob = new Blob([recovery.hex], {
                        type: "text/plain",
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `buzz-identity-${truncatePubkey(pubkey)}.key`;
                      a.click();
                      URL.revokeObjectURL(url);
                      markBackedUp(pubkey);
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1 text-xs font-medium"
                    data-testid="backup-download"
                  >
                    <Download className="h-3 w-3" /> Download
                  </button>
                </>
              ) : recovery.kind === "locked" ? (
                <button
                  type="button"
                  disabled={passkeyBusy}
                  onClick={() => void runPasskey(() => signInPasskeyIdentity())}
                  className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1 text-xs font-medium"
                  data-testid="backup-unlock"
                >
                  <Fingerprint className="h-3 w-3" /> Unlock
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setShowBackup(false)}
                className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground"
              >
                Close
              </button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {confirmSignOut ? (
        <Overlay
          className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 dark:bg-black/50"
          data-testid="signout-dialog"
        >
          <div className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl">
            <h3 className="text-base font-semibold text-black dark:text-white">
              Sign out of this browser?
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {hasBackedUp()
                ? "To sign back in, you need your recovery key."
                : "You have not saved your recovery key. Without it you cannot get back into this account."}
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmSignOut(false)}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground"
              >
                Cancel
              </button>
              {hasBackedUp() ? null : (
                <button
                  type="button"
                  onClick={() => {
                    setConfirmSignOut(false);
                    setShowBackup(true);
                  }}
                  className="rounded-full border border-input px-4 py-1.5 text-sm font-medium"
                  data-testid="signout-save-key"
                >
                  Save recovery key
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  removePasskeyIdentity();
                  forgetIdentity();
                  localStorage.removeItem(BACKED_UP_KEY);
                  window.location.assign("/");
                }}
                className="rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-black"
                data-testid="signout-confirm"
              >
                {hasBackedUp() ? "Sign out" : "Sign out anyway"}
              </button>
            </div>
          </div>
        </Overlay>
      ) : null}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
    >
      {icon}
      {label}
    </button>
  );
}
