/**
 * Inline recovery for a stored-but-unreadable key.
 *
 * Rendered from the ProfileMenu render boundary (the always-mounted nav) so a
 * stored blob that cannot be decrypted degrades to this recoverable banner
 * instead of throwing through the root error boundary — where the very
 * recovery actions needed would be unreachable. Neither action reads the
 * broken blob: Import replaces the stored key from the backup, and Reset wipes
 * the browser storage and starts over, so recovery never requires the broken
 * path. Backed by `importIdentity` / `rotateIdentity` in
 * `@/shared/lib/identity`, the same flows the rest of identity recovery uses.
 */

import { useState } from "react";

import { importIdentity, rotateIdentity } from "@/shared/lib/identity";

export function IdentityRecoveryBanner() {
  const [backup, setBackup] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const runImport = () => {
    try {
      importIdentity(backup);
      window.location.reload();
    } catch {
      setImportError(
        "That backup key couldn't be imported. Check it and try again.",
      );
    }
  };

  return (
    <div
      role="alert"
      data-testid="identity-recovery-banner"
      className="border-t border-black/10 px-3 py-2.5 dark:border-white/10"
    >
      <p className="text-sm text-black dark:text-white">
        Your saved key can't be read: import your backup or start over
      </p>
      <form
        className="mt-2 flex flex-wrap items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          runImport();
        }}
      >
        <label htmlFor="identity-recovery-backup" className="sr-only">
          Backup key
        </label>
        <input
          id="identity-recovery-backup"
          type="password"
          value={backup}
          onChange={(event) => setBackup(event.target.value)}
          placeholder="Paste your backup key"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-2xs outline-none focus:ring-1 focus:ring-ring"
          data-testid="identity-recovery-backup-input"
        />
        <button
          type="submit"
          disabled={backup.trim().length === 0}
          className="rounded-full bg-black px-2.5 py-1 text-2xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
          data-testid="identity-recovery-import"
        >
          Import
        </button>
      </form>
      {confirmReset ? (
        <div className="mt-2 rounded-md border border-black/10 p-2 text-2xs dark:border-white/10">
          <p className="text-black/70 dark:text-white/70">
            This removes the unreadable key and starts over with a new one. It
            can't be undone.
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              className="rounded-full bg-black px-2.5 py-1 font-medium text-white dark:bg-white dark:text-black"
              data-testid="identity-recovery-reset-confirm"
              onClick={() => {
                rotateIdentity();
                window.location.reload();
              }}
            >
              Start over
            </button>
            <button
              type="button"
              className="rounded-full border border-black/15 px-2.5 py-1 font-medium dark:border-white/20"
              data-testid="identity-recovery-reset-cancel"
              onClick={() => setConfirmReset(false)}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="mt-1.5 rounded-full border border-black/15 px-2.5 py-1 text-2xs font-medium dark:border-white/20"
          data-testid="identity-recovery-reset"
          onClick={() => setConfirmReset(true)}
        >
          Reset
        </button>
      )}
      {importError ? (
        <p className="mt-1 text-2xs text-red-600 dark:text-red-400">
          {importError}
        </p>
      ) : null}
    </div>
  );
}
