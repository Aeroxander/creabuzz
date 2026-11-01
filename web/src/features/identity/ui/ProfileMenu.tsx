/**
 * The "you" chip + profile menu: identity, edit profile, backup, sign out.
 */

import { useEffect, useState, useRef } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  KeyRound,
  LogIn,
  LogOut,
  Pencil,
  User,
} from "lucide-react";
import { Button } from "@/shared/ui/button";

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
  hasUserName,
  resolveUserHandle,
  resolveUserName,
} from "@/features/profiles/use-profiles";
import { UserAvatar } from "@/shared/ui/UserAvatar";
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
import { PolicyLinks } from "./PolicyLinks";
import {
  CREATE_ACCOUNT,
  SIGN_IN_EVENT,
  SIGN_UP_EVENT,
} from "../lib/account-copy";
import {
  BACKED_UP_KEY,
  copyRecoveryKey,
  currentRecovery,
  hasBackedUp,
  RecoveryKeyDialog,
} from "./RecoveryKeyDialog";
import { ProfilePictureField } from "./ProfilePictureField";
import { pictureLinkProblem } from "../lib/picture-check";
import {
  setupPasskey,
  signInPasskeyIdentity,
  hasPasskeyIdentity,
  isPasskeyActive,
  passkeyMode,
  removePasskeyIdentity,
  removingPasskeyLosesAccount,
  registerPasskeySigner,
  onPasskeySessionChange,
} from "../lib/passkey-identity";
import { Fingerprint, Wallet } from "lucide-react";
import { Overlay, Portal, useAnchoredStyle } from "@/shared/ui/portal";
import {
  type FailureWords,
  errorMessage,
  failureWords,
  readableError,
} from "@/shared/lib/readable-error";
import {
  passkeyCreateProblem,
  passkeyUnlockProblem,
} from "../lib/passkey-problem";
import { FailureNote } from "@/shared/ui/failure-note";

// Side-effect: make the passkey signer the primary signer while a passkey
// session is active. Runs on first import of this module (mounted always).
void registerPasskeySigner();

export { hasBackedUp };

/**
 * Where the menu is mounted. `sidebar` is the full-width chip; `rail` (the
 * global nav on wide screens) and `tabbar` (the phone bottom bar) show only the
 * avatar, keeping the name and username as the button's accessible text.
 * `header` is the top bar on wide screens: the avatar, or "Sign in" and
 * "Sign up" until there is an identity. On a phone (`tabbar`) the slot says
 * "Sign in"; its dialog can switch to making an account.
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
  const [showOnboarding, setShowOnboarding] = useState<
    "create" | "signin" | null
  >(null);
  const [editName, setEditName] = useState<string | null>(null);
  const [editAbout, setEditAbout] = useState("");
  const [editPicture, setEditPicture] = useState("");
  const [pictureUploading, setPictureUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [menuError, setMenuError] = useState<FailureWords | null>(null);
  const [showBackup, setShowBackup] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmRemovePasskey, setConfirmRemovePasskey] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<FailureWords | null>(null);
  const { theme, setTheme } = useTheme();
  const { fontSize, density, setFontSize, setDensity } = useTypography();
  const [walletBinding, setWalletBinding] = useState(() => readWalletBinding());
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  // `existingUserPubkey` reports the passkey identity when one is registered, so
  // this no longer has to prefer it by hand and drift from the filters.
  const pubkey = existingUserPubkey() ?? "";
  const profilesRead = useProfiles(pubkey ? [pubkey] : []);
  const profiles = profilesRead.data;
  const profile = pubkey ? profiles?.[pubkey] : undefined;
  const resolvedName = resolveUserName(profile, pubkey);
  // The community username when this identity has claimed one; nothing
  // otherwise (a short key is not a handle). The full pubkey stays available as
  // a tooltip so the username never hides the identity that actually signs.
  const secondaryName = resolveUserHandle(profile);
  // An account with no name yet is "Your account" to its owner, never a short key.
  const displayName = hasUserName(profile) ? resolvedName : "Your account";

  // Other surfaces (the Home welcome) ask for the sign-up dialog rather than
  // owning a second copy of it.
  useEffect(() => {
    const open = () => setShowOnboarding("create");
    const openSignIn = () => setShowOnboarding("signin");
    window.addEventListener(SIGN_UP_EVENT, open);
    window.addEventListener(SIGN_IN_EVENT, openSignIn);
    return () => {
      window.removeEventListener(SIGN_UP_EVENT, open);
      window.removeEventListener(SIGN_IN_EVENT, openSignIn);
    };
  }, []);

  // A passkey account reads its profile while the passkey is still locked (the sign-in prompt below waits for a touch),
  // and that read is refused: read it again when the passkey session changes, or Edit profile stays off for good.
  const [passkeySession, setPasskeySession] = useState(0);
  useEffect(
    () => onPasskeySessionChange(() => setPasskeySession((n) => n + 1)),
    [],
  );
  const refetchProfile = profilesRead.refetch;
  const hasAccount = pubkey !== "";
  useEffect(() => {
    if (passkeySession > 0 && hasAccount) void refetchProfile();
  }, [passkeySession, hasAccount, refetchProfile]);

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
    if (!editName?.trim() || pictureLinkProblem(editPicture, profile?.picture))
      return;
    setSaving(true);
    setMenuError(null);
    try {
      // Hand over the current profile: kind 0 is replaceable, so anything the
      // editor does not carry has to be merged back in. An emptied picture is
      // removed (null), as the editor shows it.
      await publishProfile(
        {
          name: editName,
          about: editAbout || undefined,
          picture: editPicture.trim() || null,
        },
        profile as Record<string, unknown> | undefined,
      );
      setEditName(null);
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    } catch (e) {
      // A refusal in its plain words (a ban, the request limit); anything else as one plain sentence, with the
      // server's own words under Technical details.
      setMenuError(failureWords(e, "Couldn't save your profile. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const passkeyActive = isPasskeyActive();
  const passkeySetUp = hasPasskeyIdentity();
  const passkeyModeNow = passkeyMode();
  const recovery = currentRecovery(pubkey);

  // What went wrong, by whether the passkey was being unlocked or made; the browser's words under Technical details.
  const runPasskey = async (
    fn: () => Promise<unknown>,
    problem: (error: unknown) => string,
  ) => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      await fn();
      setPasskeyBusy(false);
      setOpen(false);
    } catch (e) {
      setPasskeyError({ text: problem(e), detail: errorMessage(e) });
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
    const signIn = (
      <button
        type="button"
        onClick={() => setShowOnboarding("signin")}
        className={
          placement === "tabbar"
            ? "flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-2xs font-semibold text-foreground/75 hover:bg-foreground/[0.06] hover:text-foreground"
            : "inline-flex h-10 items-center rounded-lg px-3 text-sm font-semibold text-foreground/80 transition hover:bg-foreground/[0.06] hover:text-foreground"
        }
        data-testid="sign-in-cta"
      >
        {placement === "tabbar" ? (
          <LogIn aria-hidden className="h-5 w-5 shrink-0" />
        ) : null}
        Sign in
      </button>
    );
    return (
      <div
        className={
          placement === "header"
            ? "flex items-center gap-1"
            : compact
              ? ""
              : "border-t border-black/10 px-3 py-2.5 dark:border-white/10"
        }
      >
        {placement === "tabbar" ? (
          signIn
        ) : (
          <>
            {placement === "header" ? signIn : null}
            <button
              type="button"
              onClick={() => setShowOnboarding("create")}
              className={
                placement === "header"
                  ? "inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground shadow-[0_6px_16px_-6px_hsl(var(--primary)/0.6)] transition hover:brightness-110"
                  : "flex w-full items-center gap-2 rounded-md border border-dashed border-black/20 px-2 py-2 text-left text-sm text-black/60 hover:bg-black/5 dark:border-white/20 dark:text-white/60 dark:hover:bg-white/10"
              }
              data-testid="create-identity-cta"
            >
              {placement === "header" ? "Sign up" : CREATE_ACCOUNT}
            </button>
          </>
        )}
        {showOnboarding ? (
          <OnboardingDialog
            onCancel={() => setShowOnboarding(null)}
            onDone={() => {
              // Reload so the fresh profile (kind 0) renders in the chip.
              window.location.reload();
            }}
            onPasskeyDone={() => {
              // Passkey setup re-renders in place — no reload, no extra
              // ceremony; the session is already active with the derived key.
              setCreated(true);
              setShowOnboarding(null);
              setOpen(false);
            }}
            startOn={showOnboarding}
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
                  aria-label="Name"
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                  data-testid="profile-name-input"
                />
                <textarea
                  value={editAbout}
                  onChange={(e) => setEditAbout(e.target.value)}
                  placeholder="About you"
                  aria-label="About you"
                  rows={2}
                  className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                  data-testid="profile-about-input"
                />
                <ProfilePictureField
                  idPrefix="profile-menu-picture"
                  onChange={setEditPicture}
                  onUploadingChange={setPictureUploading}
                  saved={profile?.picture}
                  value={editPicture}
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
                    disabled={
                      saving ||
                      pictureUploading ||
                      editName.trim().length === 0 ||
                      pictureLinkProblem(editPicture, profile?.picture) !== null
                    }
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
                {/* The way to your own profile: the timeline's side nav no longer repeats it. */}
                <Link
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
                  data-testid="profile-menu-profile"
                  onClick={() => setOpen(false)}
                  params={{ pubkey }}
                  to="/u/$pubkey"
                >
                  <User aria-hidden className="h-3.5 w-3.5" />
                  Your profile
                </Link>
                <MenuItem
                  icon={<Pencil className="h-3.5 w-3.5" />}
                  // The editor starts from the saved profile and saving merges into it: before it has been read,
                  // the fields would start empty and a save would drop what the editor does not show.
                  disabled={!profilesRead.isSuccess}
                  label="Edit profile"
                  onClick={() => {
                    setEditName(profile?.display_name ?? profile?.name ?? "");
                    setEditAbout(profile?.about ?? "");
                    setEditPicture(profile?.picture ?? "");
                  }}
                />
                {profilesRead.isError && !profilesRead.isFetching ? (
                  <p
                    className="px-2 pb-1 text-xs text-amber-700 dark:text-amber-300"
                    data-testid="profile-read-failed"
                    role="alert"
                  >
                    Couldn't read your profile, so it can't be edited yet.{" "}
                    {readableError(profilesRead.error)}{" "}
                    <button
                      className="underline"
                      data-testid="profile-read-retry"
                      onClick={() => void profilesRead.refetch()}
                      type="button"
                    >
                      Try again
                    </button>
                  </p>
                ) : null}
                <MenuItem
                  icon={<KeyRound className="h-3.5 w-3.5" />}
                  label={hasBackedUp() ? "Recovery key" : "Save a recovery key"}
                  onClick={() => {
                    // The dialog takes over: the menu under it would only show through on a phone. Focus goes back
                    // to the account button the menu hangs from when the dialog closes.
                    triggerRef.current?.focus();
                    setOpen(false);
                    setShowBackup(true);
                  }}
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
                          void copyRecoveryKey(recovery.hex, pubkey);
                        else {
                          triggerRef.current?.focus();
                          setOpen(false);
                          setShowBackup(true);
                        }
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
                        setOpen(false);
                        setConfirmRemovePasskey(true);
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
                      void (passkeySetUp
                        ? runPasskey(
                            () => signInPasskeyIdentity(),
                            passkeyUnlockProblem,
                          )
                        : runPasskey(
                            () => setupPasskey(displayName),
                            (error) =>
                              passkeyCreateProblem(
                                error,
                                "keep signing in as you do now",
                              ),
                          ));
                    }}
                  />
                )}
              </div>
            )}
            {menuError ? (
              <FailureNote
                className="mt-2 text-xs text-red-600 dark:text-red-400"
                failure={menuError}
                testId="profile-save-error"
              />
            ) : null}
            {passkeyError ? (
              <FailureNote
                className="mt-1 text-xs text-red-600 dark:text-red-400"
                failure={passkeyError}
                testId="profile-passkey-error"
              />
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
            <PolicyLinks />
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
            .catch((error: unknown) => setWalletError(failureWords(error).text))
            .finally(() => setWalletBusy(false));
        }}
        open={confirmUnbind}
        title="Disconnect this wallet?"
      />

      {showBackup ? (
        <RecoveryKeyDialog
          account={pubkey}
          onClose={() => setShowBackup(false)}
          returnFocus={triggerRef}
        />
      ) : null}

      {confirmRemovePasskey ? (
        <Overlay
          className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 dark:bg-black/50"
          data-testid="remove-passkey-dialog"
        >
          <div className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl">
            <h3 className="text-base font-semibold text-black dark:text-white">
              Remove passkey sign-in?
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {/* A PRF passkey is the only source of its key; an unlock-mode one only guards the key kept here. */}
              {removingPasskeyLosesAccount(passkeyModeNow, hasBackedUp())
                ? "You haven't saved your recovery key. Without it this account is gone for good."
                : passkeyModeNow === "prf"
                  ? "This browser forgets your passkey. To sign back in, you need your recovery key."
                  : "Your account stays on this browser. It just won't ask for your passkey any more."}
            </p>
            {/* Losing the account: saving the key is the main button and removing is the second choice. */}
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <Button
                onClick={() => setConfirmRemovePasskey(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              {removingPasskeyLosesAccount(passkeyModeNow, hasBackedUp()) ? (
                <>
                  <Button
                    data-testid="remove-passkey-confirm"
                    onClick={() => {
                      removePasskeyIdentity();
                      window.location.reload();
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Remove anyway
                  </Button>
                  <Button
                    data-testid="remove-passkey-save-key"
                    onClick={() => {
                      setConfirmRemovePasskey(false);
                      setShowBackup(true);
                    }}
                    size="sm"
                    type="button"
                  >
                    Save recovery key
                  </Button>
                </>
              ) : (
                <Button
                  data-testid="remove-passkey-confirm"
                  onClick={() => {
                    removePasskeyIdentity();
                    window.location.reload();
                  }}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  Remove
                </Button>
              )}
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
                ? passkeySetUp
                  ? "This browser forgets your passkey too. To sign back in, you need your recovery key."
                  : "To sign back in, you need your recovery key."
                : "You have not saved your recovery key. Without it you cannot get back into this account."}
            </p>
            {/* The app's own buttons: signing out is the destructive one. */}
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <Button
                onClick={() => setConfirmSignOut(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              {hasBackedUp() ? null : (
                <Button
                  data-testid="signout-save-key"
                  onClick={() => {
                    setConfirmSignOut(false);
                    setShowBackup(true);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Save recovery key
                </Button>
              )}
              <Button
                data-testid="signout-confirm"
                onClick={() => {
                  removePasskeyIdentity();
                  forgetIdentity();
                  localStorage.removeItem(BACKED_UP_KEY);
                  window.location.assign("/");
                }}
                size="sm"
                type="button"
                variant="destructive"
              >
                {hasBackedUp() ? "Sign out" : "Sign out anyway"}
              </Button>
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
  disabled = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-black/70 hover:bg-black/5 disabled:opacity-40 dark:text-white/70 dark:hover:bg-white/10"
    >
      {icon}
      {label}
    </button>
  );
}
