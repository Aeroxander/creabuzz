import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { profileQueryKey } from "@/features/profile/hooks";
import {
  createWebIdentityHandoff,
  type WebIdentityHandoff,
  WEB_IDENTITY_HANDOFF_COPY as COPY,
} from "@/features/identity/webIdentityHandoff";
import { relayClient } from "@/shared/api/relayClient";
import {
  importIdentity,
  previewIdentityImport,
} from "@/shared/api/tauriIdentity";
import type { Identity } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";

/**
 * Settings row that adopts the web account's identity: paste the recovery
 * nsec from the web app, review what this device would switch to, confirm the
 * replacement. The preview (`preview_identity_import`) is read-only; the
 * swap happens only through `import_identity`, fenced to the npub shown in
 * the confirmation. Storage is the existing keyring-first path — no new
 * store, no plaintext.
 *
 * Lives next to `PasskeyIdentityCard` on purpose: that card explains where
 * the web identity comes from; this one is how you get it onto this device
 * today. The honesty note stays visible — passkey-native identity (same
 * Touch ID on web + desktop) arrives with app signing activation and makes
 * this handoff unnecessary.
 */
export function WebIdentityHandoffCard() {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [nsecInput, setNsecInput] = React.useState("");
  const [handoff] = React.useState<WebIdentityHandoff>(() =>
    createWebIdentityHandoff({
      preview: (nsec) => previewIdentityImport(nsec),
      importNsec: (nsec, expectedCurrentNpub) =>
        importIdentity(nsec, undefined, expectedCurrentNpub),
      onImported: (identity: Identity) => {
        // Mirror the onboarding import (`OnboardingFlow.importExistingKey`):
        // drop the socket authenticated as the previous key, then rekey the
        // identity query — App.tsx's replacement sentinel watches it and
        // rebuilds the community boundary so no cached state leaks across.
        relayClient.disconnect();
        queryClient.setQueryData(["identity"], identity);
        queryClient.removeQueries({ queryKey: profileQueryKey });
      },
    }),
  );
  const state = React.useSyncExternalStore(
    handoff.subscribe,
    handoff.getState,
    handoff.getState,
  );

  const closePanel = React.useCallback(() => {
    handoff.cancel();
    setNsecInput("");
    setOpen(false);
  }, [handoff]);

  const handleInput = React.useCallback(
    (value: string) => {
      setNsecInput(value);
      // Editing invalidates any preview or in-flight result: the reviewed
      // candidate no longer matches the input, so it must be re-checked.
      if (state.phase !== "idle") handoff.cancel();
    },
    [handoff, state.phase],
  );

  return (
    <div className="px-4 py-3" data-testid="web-identity-handoff">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{COPY.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{COPY.intro}</p>
          <p
            className="mt-1 text-xs text-muted-foreground/75"
            data-testid="web-identity-interim-note"
          >
            {COPY.interimNote}
          </p>
        </div>
        {!open ? (
          <Button
            data-testid="web-identity-open"
            onClick={() => setOpen(true)}
            type="button"
            variant="secondary"
          >
            {COPY.openButton}
          </Button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-3" data-testid="web-identity-panel">
          <p className="text-xs text-muted-foreground" role="note">
            {COPY.keyWarning}
          </p>

          {state.phase === "replaced" ? (
            <p
              className="mt-2 text-sm"
              data-testid="web-identity-done"
              role="status"
            >
              {COPY.replaced(state.npub)}
            </p>
          ) : (
            <>
              <input
                autoComplete="off"
                className="mt-2 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="web-identity-input"
                disabled={
                  state.phase === "checking" || state.phase === "replacing"
                }
                onChange={(event) => handleInput(event.target.value)}
                placeholder={COPY.inputPlaceholder}
                spellCheck={false}
                type="text"
                value={nsecInput}
              />

              {state.phase === "ready" ? (
                <div className="mt-2 rounded-md border border-border/60 bg-muted/30 p-2">
                  <p
                    className="font-mono text-xs break-all"
                    data-testid="web-identity-candidate"
                  >
                    {COPY.wouldSignAs(state.preview.npub)}
                  </p>
                  <p
                    className="mt-1 text-xs text-amber-700 dark:text-amber-400"
                    data-testid="web-identity-replace-warning"
                    role="alert"
                  >
                    {COPY.replacesLabel(state.preview.currentNpub)}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      data-testid="web-identity-replace"
                      onClick={() => void handoff.confirm()}
                      size="sm"
                      type="button"
                      variant="destructive"
                    >
                      {COPY.replaceButton}
                    </Button>
                    <Button
                      data-testid="web-identity-cancel"
                      onClick={closePanel}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {COPY.cancelButton}
                    </Button>
                  </div>
                </div>
              ) : null}

              {state.phase === "error" ? (
                <p
                  className="mt-2 text-sm text-destructive"
                  data-testid="web-identity-error"
                  role="alert"
                >
                  {state.message}
                </p>
              ) : null}

              {state.phase === "idle" ||
              state.phase === "checking" ||
              state.phase === "error" ? (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    aria-busy={state.phase === "checking"}
                    data-testid="web-identity-check"
                    disabled={
                      state.phase === "checking" ||
                      nsecInput.trim().length === 0
                    }
                    onClick={() => void handoff.check(nsecInput.trim())}
                    size="sm"
                    type="button"
                  >
                    {state.phase === "checking"
                      ? COPY.checking
                      : COPY.checkButton}
                  </Button>
                  <Button
                    data-testid="web-identity-close"
                    onClick={closePanel}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {COPY.cancelButton}
                  </Button>
                </div>
              ) : null}

              {state.phase === "replacing" ? (
                <p
                  className="mt-2 text-sm text-muted-foreground"
                  data-testid="web-identity-status"
                  role="status"
                >
                  {COPY.replacing}
                </p>
              ) : null}

              <p
                className="mt-2 text-xs text-muted-foreground/75"
                data-testid="web-identity-passkey-note"
              >
                {COPY.notThePasskey}
              </p>
            </>
          )}

          {state.phase === "replaced" ? (
            <div className="mt-2">
              <Button
                data-testid="web-identity-close"
                onClick={closePanel}
                size="sm"
                type="button"
                variant="ghost"
              >
                {COPY.closeLabel}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
