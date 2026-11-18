import {
  AGE_CONFIRMATION,
  TERMS_NOT_LOADED,
} from "@creaton/core/account/account-copy.ts";
import {
  type PolicyState,
  policyRequirements,
} from "@creaton/core/account/join-policy.ts";
import { relayHttpBaseUrl } from "@creaton/core/client/relay-url.ts";

/**
 * The boxes the server's policy asks for, with its terms and privacy note one tap away (each opens as a page). The
 * words are web/'s `PolicyBoxes.tsx`, word for word: the legal text is never reworded here, only restyled.
 */
export function PolicyBoxes({
  state,
  agreed,
  ageOk,
  onAgreed,
  onAgeOk,
  onRetry,
}: {
  state: PolicyState;
  agreed: boolean;
  ageOk: boolean;
  onAgreed: (value: boolean) => void;
  onAgeOk: (value: boolean) => void;
  /** Ask the server for its terms again; the "Try again" button shows only when this is given. */
  onRetry?: () => void;
}) {
  if (state.status === "loading") {
    return (
      <p className="text-sm text-muted" role="status">
        Loading this server's terms…
      </p>
    );
  }
  if (state.status === "unavailable") {
    return (
      <div
        className="glass rounded-xl p-3 text-sm text-muted"
        data-testid="onboarding-policy-unavailable"
      >
        <p>{TERMS_NOT_LOADED}</p>
        {onRetry ? (
          <button
            className="link mt-2 min-h-11 font-semibold"
            data-testid="onboarding-policy-retry"
            onClick={onRetry}
            type="button"
          >
            Try again
          </button>
        ) : null}
      </div>
    );
  }
  const needs = policyRequirements(state);
  if (state.status !== "ready" || (!needs.agreement && !needs.age)) return null;
  const base = relayHttpBaseUrl();
  const { policy } = state;
  const link = (path: string, label: string) => (
    <a
      className="link font-semibold"
      href={`${base}/api/join-policy/${path}`}
      rel="noopener noreferrer"
      target="_blank"
    >
      {label}
    </a>
  );
  return (
    <div
      className="glass flex flex-col gap-1 rounded-xl p-3 text-sm text-muted"
      data-testid="onboarding-policy"
    >
      {needs.age ? (
        <label className="flex min-h-11 items-center gap-3">
          <input
            checked={ageOk}
            className="check"
            data-testid="onboarding-policy-age"
            onChange={(e) => onAgeOk(e.target.checked)}
            type="checkbox"
          />
          <span>{AGE_CONFIRMATION}</span>
        </label>
      ) : null}
      {needs.agreement ? (
        <label className="flex min-h-11 items-center gap-3">
          <input
            checked={agreed}
            className="check"
            data-testid="onboarding-policy-agree"
            onChange={(e) => onAgreed(e.target.checked)}
            type="checkbox"
          />
          <span>
            I agree to the{" "}
            {policy.terms_markdown
              ? link("terms", "Terms of use")
              : "Terms of use"}
            {policy.privacy_markdown ? (
              <> and have read the {link("privacy", "Privacy note")}</>
            ) : null}
            . Posts and votes are public.
          </span>
        </label>
      ) : null}
    </div>
  );
}
