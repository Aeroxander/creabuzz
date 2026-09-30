import { WEB_IDENTITY_HANDOFF_COPY as COPY } from "@/features/identity/webIdentityHandoff";
import { useWebIdentityHandoff } from "@/features/identity/useWebIdentityHandoff";
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
  // Settings passes no fallback origin: sign-in targets the connected
  // community's own web app. The shared hook owns the request fencing.
  const { handoff, state } = useWebIdentityHandoff();

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
