import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

import { profileQueryKey } from "@/features/profile/hooks";
import {
  createWebIdentityHandoff,
  type WebIdentityHandoff,
  WEB_IDENTITY_HANDOFF_COPY as COPY,
} from "@/features/identity/webIdentityHandoff";
import { relayClient } from "@/shared/api/relayClient";
import {
  cancelIdentityLink,
  getIdentity,
  startIdentityLink,
  takeIdentityLinkResult,
  type IdentityLinkResult,
} from "@/shared/api/tauriIdentity";
import { Button } from "@/shared/ui/button";

/**
 * Settings row that adopts the web account's identity via the browser:
 * "Sign in with browser" opens the web app with a one-time link, and the
 * completed sign-in returns through a `creaton://identity` deep link. There
 * is no key to paste — the account key is encrypted end-to-end and stored by
 * the existing keyring-first identity storage inside Rust.
 *
 * Outcomes are fenced to the request that produced them (the controller in
 * `webIdentityHandoff.ts`), so a stale or stray deep link never applies to a
 * newer sign-in attempt.
 */
export function WebIdentityHandoffCard() {
  const queryClient = useQueryClient();
  const [handoff] = React.useState<WebIdentityHandoff>(() =>
    createWebIdentityHandoff({
      start: () => startIdentityLink(),
      cancel: () => cancelIdentityLink(),
      results: (listener) => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void listen<IdentityLinkResult>("deep-link-identity", (event) => {
          listener(event.payload);
        }).then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        });
        return () => {
          disposed = true;
          unlisten?.();
        };
      },
      onLinked: () => {
        // Mirror the manual import's post-commit re-scope: drop the socket
        // authenticated as the previous key, then rekey the identity query —
        // App.tsx's replacement sentinel watches it and rebuilds the
        // community boundary so no cached state leaks across.
        relayClient.disconnect();
        queryClient.removeQueries({ queryKey: profileQueryKey });
        void getIdentity()
          .then((identity) => queryClient.setQueryData(["identity"], identity))
          .catch(() =>
            // If the refresh read fails, refetch through the query layer so
            // the failure is retried there instead of vanishing here.
            queryClient.invalidateQueries({ queryKey: ["identity"] }),
          );
      },
    }),
  );

  React.useEffect(() => () => handoff.dispose(), [handoff]);

  // Pick up a result that raced the event subscription (e.g. the deep link
  // landed before this surface mounted). Consuming it here is safe: the
  // controller ignores results that match no live request.
  React.useEffect(() => {
    // Best-effort race catcher: the live event is the primary path, and a
    // failed pickup leaves the result queued (Rust only consumes on success)
    // so the next mount or the retry picks it up.
    void takeIdentityLinkResult()
      .then((result) => {
        if (result) handoff.handleResult(result);
      })
      .catch(() => {});
  }, [handoff]);

  const state = React.useSyncExternalStore(
    handoff.subscribe,
    handoff.getState,
    handoff.getState,
  );

  return (
    <div className="px-4 py-3" data-testid="web-identity-handoff">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{COPY.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{COPY.intro}</p>
          <p className="mt-1 text-xs text-muted-foreground/75">
            {COPY.replacesWarning}
          </p>
        </div>
        {state.phase === "idle" || state.phase === "error" ? (
          <Button
            data-testid="web-identity-open"
            onClick={() => void handoff.start()}
            type="button"
            variant="secondary"
          >
            {COPY.openButton}
          </Button>
        ) : null}
      </div>

      {state.phase === "starting" ? (
        <p
          aria-busy="true"
          className="mt-2 text-sm text-muted-foreground"
          data-testid="web-identity-status"
          role="status"
        >
          {COPY.starting}
        </p>
      ) : null}

      {state.phase === "waiting" ? (
        <div className="mt-2">
          <p
            className="text-sm text-muted-foreground"
            data-testid="web-identity-waiting"
            role="status"
          >
            {COPY.waiting}
          </p>
          <div className="mt-2">
            <Button
              data-testid="web-identity-cancel"
              onClick={() => handoff.cancel()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {COPY.cancelButton}
            </Button>
          </div>
        </div>
      ) : null}

      {state.phase === "linked" ? (
        <div className="mt-2">
          <p
            className="break-all font-mono text-sm"
            data-testid="web-identity-done"
            role="status"
          >
            {COPY.linked(state.npub)}
          </p>
          <div className="mt-2">
            <Button
              data-testid="web-identity-close"
              onClick={() => handoff.cancel()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {COPY.closeLabel}
            </Button>
          </div>
        </div>
      ) : null}

      {state.phase === "error" ? (
        <div className="mt-2">
          <p
            className="text-sm text-destructive"
            data-testid="web-identity-error"
            role="alert"
          >
            {state.message}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              data-testid="web-identity-retry"
              onClick={() => void handoff.start()}
              size="sm"
              type="button"
            >
              {COPY.tryAgainButton}
            </Button>
            <Button
              data-testid="web-identity-cancel"
              onClick={() => handoff.cancel()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {COPY.cancelButton}
            </Button>
          </div>
        </div>
      ) : null}

      <details className="mt-2" data-testid="web-identity-technical">
        <summary className="cursor-pointer text-xs text-muted-foreground/75">
          {COPY.technicalTitle}
        </summary>
        <p className="mt-1 text-xs text-muted-foreground/75">
          {COPY.technical}
        </p>
      </details>
    </div>
  );
}
