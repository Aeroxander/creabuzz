/**
 * First-run onboarding: name the durable identity and publish its profile.
 */

import { useState } from "react";
import { Sparkles } from "lucide-react";

import { publishProfile } from "../lib/profile";
import { getOrCreateIdentity } from "@/shared/lib/identity";
import { createPasskeyIdentity } from "../lib/passkey-identity";
import { signInWithWallet, walletAvailable } from "../lib/siwe";
import { Fingerprint, Wallet } from "lucide-react";

export function OnboardingDialog({
  onDone,
  onPasskeyDone,
}: {
  onDone: () => void;
  onPasskeyDone?: () => void;
}) {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (name.trim().length === 0) return;
    setSaving(true);
    setError(null);
    try {
      getOrCreateIdentity(); // materialize the key now, visibly
      await publishProfile({ name, about: about || undefined });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't create identity");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4 dark:bg-black/50"
      data-testid="onboarding-dialog"
    >
      <div className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl">
        <button
          type="button"
          onClick={() => {
            void (async () => {
              setSaving(true);
              setError(null);
              try {
                await createPasskeyIdentity(name.trim() || "Creaton user");
                (onPasskeyDone ?? onDone)();
              } catch (e) {
                setError(e instanceof Error ? e.message : "passkey failed");
                setSaving(false);
              }
            })();
          }}
          disabled={saving}
          className="mb-3 flex w-full items-center justify-center gap-2 rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
          data-testid="onboarding-passkey"
        >
          <Fingerprint className="h-4 w-4" />
          Create with passkey (no key to manage)
        </button>
        {walletAvailable() ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              void (async () => {
                setSaving(true);
                setError(null);
                try {
                  await signInWithWallet();
                  (onPasskeyDone ?? onDone)();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "wallet failed");
                  setSaving(false);
                }
              })();
            }}
            className="mb-3 flex w-full items-center justify-center gap-2 rounded-full border border-black/15 bg-white px-4 py-2 text-sm font-medium text-black hover:bg-black/5 disabled:opacity-40 dark:border-white/20 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
            data-testid="onboarding-wallet"
          >
            <Wallet className="h-4 w-4" />
            Sign in with wallet
          </button>
        ) : null}
        <div className="mb-3 flex items-center gap-2 text-2xs text-muted-foreground">
          <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
          or with a backup key
          <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-black/5 dark:bg-white/10">
          <Sparkles className="h-5 w-5 text-black/60 dark:text-white/60" />
        </div>
        <h1 className="mt-3 text-lg font-semibold tracking-tight text-black dark:text-white">
          Create your identity
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your key is generated in this browser and stays here. Messages, tasks
          and agent delegations are signed by it — back it up once you're in.
        </p>
        <div className="mt-4 space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            data-testid="onboarding-name"
          />
          <textarea
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            placeholder="About you (optional)"
            rows={2}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            data-testid="onboarding-about"
          />
        </div>
        {error ? (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDone}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            Later
          </button>
          <button
            type="button"
            disabled={saving || name.trim().length === 0}
            onClick={() => void submit()}
            className="rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
            data-testid="onboarding-create"
          >
            Create identity
          </button>
        </div>
      </div>
    </div>
  );
}
