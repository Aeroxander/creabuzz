import * as React from "react";
import { useWebIdentityHandoff } from "@/features/identity/useWebIdentityHandoff";
import { WEB_IDENTITY_HANDOFF_COPY as COPY } from "@/features/identity/webIdentityHandoff";
import { DEFAULT_WEB_ORIGIN } from "@/shared/constants/brand";
import { Button } from "@/shared/ui/button";

/**
 * Onboarding's "Sign in with browser" — the SAME controller the Settings row
 * uses (`useWebIdentityHandoff`), presented as a compact step affordance so a
 * fresh install can adopt its web account instead of minting a throwaway key.
 * When no community is connected yet the flow signs in against the hosted web
 * app; a connected community's own web app always wins.
 */
export function WebIdentitySignInButton({
  onLinked,
}: {
  /**
   * Called once the browser handoff has committed and the desktop is signing
   * as the new key. Onboarding passes the flow's own advance action so the
   * user lands on the next step instead of sitting on a confirmation;
   * surfaces with no next step (Settings) omit it and confirm in place.
   */
  onLinked?: () => void;
}) {
  const { handoff, state } = useWebIdentityHandoff({
    fallbackOrigin: DEFAULT_WEB_ORIGIN,
  });

  // Advance exactly once when the key lands. A ref guards React 18 StrictMode's
  // development double-invoke, which would otherwise skip a whole step.
  const advancedRef = React.useRef(false);
  React.useEffect(() => {
    if (state.phase !== "linked" || !onLinked || advancedRef.current) {
      return;
    }
    advancedRef.current = true;
    onLinked();
  }, [state.phase, onLinked]);

  return (
    <div className="w-full" data-testid="onboarding-web-sign-in">
      <p className="text-center text-xs text-muted-foreground">
        {COPY.onboardingHint}
      </p>
      {state.phase === "idle" || state.phase === "error" ? (
        <Button
          className="mt-1 w-full text-muted-foreground hover:text-accent-foreground"
          data-testid="onboarding-web-sign-in-open"
          onClick={() => void handoff.start()}
          type="button"
          variant="ghost"
        >
          {COPY.openButton}
        </Button>
      ) : null}

      {state.phase === "starting" ? (
        <p
          aria-busy="true"
          className="mt-2 text-center text-xs text-muted-foreground"
          data-testid="onboarding-web-sign-in-status"
          role="status"
        >
          {COPY.starting}
        </p>
      ) : null}

      {state.phase === "waiting" ? (
        <div className="mt-2 text-center">
          <p
            className="text-xs text-muted-foreground"
            data-testid="onboarding-web-sign-in-status"
            role="status"
          >
            {COPY.waiting}
          </p>
          <Button
            className="mt-1"
            data-testid="onboarding-web-sign-in-cancel"
            onClick={() => handoff.cancel()}
            size="sm"
            type="button"
            variant="ghost"
          >
            {COPY.cancelButton}
          </Button>
        </div>
      ) : null}

      {state.phase === "linked" ? (
        <div className="mt-2 text-center">
          <p
            className="break-all font-mono text-xs"
            data-testid="onboarding-web-sign-in-status"
            role="status"
          >
            {COPY.linked(state.npub)}
          </p>
          <Button
            className="mt-1"
            data-testid="onboarding-web-sign-in-close"
            onClick={() => handoff.cancel()}
            size="sm"
            type="button"
            variant="ghost"
          >
            {COPY.closeLabel}
          </Button>
        </div>
      ) : null}

      {state.phase === "error" ? (
        <div className="mt-2 text-center">
          <p
            className="text-xs text-destructive"
            data-testid="onboarding-web-sign-in-error"
            role="alert"
          >
            {state.message}
          </p>
          <div className="mt-1 flex items-center justify-center gap-2">
            <Button
              data-testid="onboarding-web-sign-in-retry"
              onClick={() => void handoff.start()}
              size="sm"
              type="button"
            >
              {COPY.tryAgainButton}
            </Button>
            <Button
              data-testid="onboarding-web-sign-in-cancel"
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
    </div>
  );
}
