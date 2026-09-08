/**
 * The "you" chip + profile menu: identity, edit profile, backup, sign out.
 */

import { useEffect, useState } from "react";
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
  hasStoredIdentity,
  importIdentity,
  rotateIdentity,
  userPubkey,
} from "@/shared/lib/identity";
import {
  useProfiles,
  profileDisplayName,
} from "@/features/profiles/use-profiles";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { publishProfile } from "../lib/profile";
import { OnboardingDialog } from "./OnboardingDialog";

const BACKED_UP_KEY = "buzz.identity.backedUp";

function copyNsec(value: string, label = "Key copied") {
  void navigator.clipboard?.writeText(value).then(() => {
    import("sonner").then(({ toast }) => toast.success(label));
  });
}

export function hasBackedUp(): boolean {
  try {
    return localStorage.getItem(BACKED_UP_KEY) === "1";
  } catch {
    return true;
  }
}

export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  // Read once at mount; sign out / import reload the page, so no setter
  // is needed — "create identity" itself reloads on completion.
  const [created] = useState(() => hasStoredIdentity());
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [editName, setEditName] = useState<string | null>(null);
  const [editAbout, setEditAbout] = useState("");
  const [saving, setSaving] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [showBackup, setShowBackup] = useState(false);
  const [revealKey, setRevealKey] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const pubkey = userPubkey();
  const { data: profiles } = useProfiles(pubkey ? [pubkey] : []);
  const profile = profiles?.[0];
  const displayName = profileDisplayName(profile, pubkey);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-testid='profile-menu']")) {
        close();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const saveProfile = async () => {
    if (!editName?.trim()) return;
    setSaving(true);
    setMenuError(null);
    try {
      await publishProfile({ name: editName, about: editAbout || undefined });
      setEditName(null);
    } catch (e) {
      setMenuError(e instanceof Error ? e.message : "couldn't save");
    } finally {
      setSaving(false);
    }
  };

  const nsec = (() => {
    try {
      return localStorage.getItem("buzz.identity.nsec") ?? "";
    } catch {
      return "";
    }
  })();

  if (!created) {
    return (
      <div className="border-t border-black/10 px-3 py-2.5 dark:border-white/10">
        <button
          type="button"
          onClick={() => setShowOnboarding(true)}
          className="flex w-full items-center gap-2 rounded-md border border-dashed border-black/20 px-2 py-2 text-left text-sm text-black/60 hover:bg-black/5 dark:border-white/20 dark:text-white/60 dark:hover:bg-white/10"
          data-testid="create-identity-cta"
        >
          <UserPlus className="h-4 w-4" />
          Create your identity
        </button>
        {showOnboarding ? (
          <OnboardingDialog
            onDone={() => {
              // Reload so the fresh profile (kind 0) renders in the chip.
              window.location.reload();
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div data-testid="profile-menu" className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/10"
        data-testid="user-chip"
      >
        <UserAvatar
          avatarUrl={profile?.picture ?? null}
          displayName={displayName}
          size="sm"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-black dark:text-white">
            {displayName}
          </span>
          <span className="block truncate font-mono text-[10px] text-black/45 dark:text-white/45">
            {truncatePubkey(pubkey)}
          </span>
        </span>
        {!hasBackedUp() ? (
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        ) : null}
      </button>

      {open ? (
        <div className="absolute bottom-full left-0 z-40 mb-1 w-72 rounded-xl border border-black/10 bg-background p-3 shadow-xl dark:border-white/10">
          {!hasBackedUp() ? (
            <p className="mb-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              Back up your key — it only exists in this browser.
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
              <p className="truncate font-mono text-[10px] text-black/45 dark:text-white/45">
                {truncatePubkey(pubkey)}
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
                label={
                  hasBackedUp() ? "Back up key" : "Back up key (recommended)"
                }
                onClick={() => setShowBackup(true)}
              />
              <MenuItem
                icon={<LogOut className="h-3.5 w-3.5" />}
                label="Sign out (new key)"
                onClick={() => setConfirmSignOut(true)}
              />
            </div>
          )}
          {menuError ? (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              {menuError}
            </p>
          ) : null}
        </div>
      ) : null}

      {showBackup ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 dark:bg-black/50"
          data-testid="backup-dialog"
        >
          <div className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl">
            <h3 className="text-base font-semibold text-black dark:text-white">
              Back up your key
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              This hex nsec signs everything you do here. Store it somewhere
              safe; your identity can't be recovered without it.
            </p>
            <div className="mt-3 rounded-md border border-input bg-black/[0.03] p-2 font-mono text-[11px] break-all text-black/70 dark:bg-white/5 dark:text-white/70">
              {revealKey ? nsec : nsec.slice(0, 12) + "…" + nsec.slice(-8)}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setRevealKey((v) => !v)}
                className="rounded-md border border-input bg-background px-3 py-1 text-xs font-medium"
              >
                {revealKey ? "Hide" : "Reveal"}
              </button>
              <button
                type="button"
                onClick={() => {
                  copyNsec(nsec);
                  localStorage.setItem(BACKED_UP_KEY, "1");
                }}
                className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1 text-xs font-medium"
                data-testid="backup-copy"
              >
                <Check className="h-3 w-3" /> Copy
              </button>
              <button
                type="button"
                onClick={() => {
                  const blob = new Blob([nsec], { type: "text/plain" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `buzz-identity-${truncatePubkey(pubkey)}.key`;
                  a.click();
                  URL.revokeObjectURL(url);
                  localStorage.setItem(BACKED_UP_KEY, "1");
                }}
                className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1 text-xs font-medium"
                data-testid="backup-download"
              >
                <Download className="h-3 w-3" /> Download
              </button>
              <button
                type="button"
                onClick={() => setShowBackup(false)}
                className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground"
              >
                Close
              </button>
            </div>
            <BackupImport onImported={() => setShowBackup(false)} />
          </div>
        </div>
      ) : null}

      {confirmSignOut ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 dark:bg-black/50"
          data-testid="signout-dialog"
        >
          <div className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl">
            <h3 className="text-base font-semibold text-black dark:text-white">
              Sign out with a new key?
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Your current identity is removed from this browser and a fresh one
              is created. Back up first if you want to keep this identity.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmSignOut(false)}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground"
              >
                Keep identity
              </button>
              <button
                type="button"
                onClick={() => {
                  rotateIdentity();
                  localStorage.removeItem(BACKED_UP_KEY);
                  window.location.reload();
                }}
                className="rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-black"
                data-testid="signout-confirm"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
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
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
    >
      {icon}
      {label}
    </button>
  );
}

function BackupImport({ onImported }: { onImported: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const tryImport = () => {
    try {
      importIdentity(value);
      localStorage.setItem(BACKED_UP_KEY, "1");
      onImported();
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "invalid key");
    }
  };
  return (
    <div className="mt-4 border-t border-black/10 pt-3 dark:border-white/10">
      <p className="text-xs font-medium text-black/60 dark:text-white/60">
        Restore an existing key
      </p>
      <div className="mt-1.5 flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste the 64-char hex nsec"
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[11px] outline-none focus:ring-1 focus:ring-ring"
          data-testid="backup-import-input"
        />
        <button
          type="button"
          disabled={value.trim().length < 64}
          onClick={tryImport}
          className="rounded-md border border-input bg-background px-3 py-1 text-xs font-medium disabled:opacity-40"
          data-testid="backup-import"
        >
          Import
        </button>
      </div>
      {error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </div>
  );
}
