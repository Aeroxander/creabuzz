import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

import { profileQueryKey } from "@/features/profile/hooks";
import {
  createWebIdentityHandoff,
  type WebIdentityHandoff,
  type WebIdentityHandoffState,
} from "@/features/identity/webIdentityHandoff";
import { relayClient } from "@/shared/api/relayClient";
import {
  cancelIdentityLink,
  getIdentity,
  startIdentityLink,
  takeIdentityLinkResult,
  type IdentityLinkResult,
} from "@/shared/api/tauriIdentity";

export type UseWebIdentityHandoffOptions = {
  /**
   * Web app address to sign in against when no community is connected yet.
   * A connected community's relay-derived web app always wins (Rust derives
   * it); this only fills the no-community gap. Settings passes nothing.
   */
  fallbackOrigin?: string;
};

/**
 * The "Sign in with browser" controller wired to the Tauri identity-link
 * commands — the single seam every surface (Settings, onboarding) reuses, so
 * the request fencing and post-link re-scope live in exactly one place.
 */
export function useWebIdentityHandoff(options?: { fallbackOrigin?: string }): {
  handoff: WebIdentityHandoff;
  state: WebIdentityHandoffState;
} {
  const fallbackOrigin = options?.fallbackOrigin;
  const queryClient = useQueryClient();
  const [handoff] = React.useState<WebIdentityHandoff>(() =>
    createWebIdentityHandoff({
      start: () =>
        startIdentityLink(fallbackOrigin ? { fallbackOrigin } : undefined),
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

  return { handoff, state };
}
