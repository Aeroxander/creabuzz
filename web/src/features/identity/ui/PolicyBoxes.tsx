import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

import { AGE_CONFIRMATION, TERMS_NOT_LOADED } from "../lib/account-copy";
import { type PolicyState, policyRequirements } from "../lib/join-policy";

/**
 * The boxes the server's policy asks for, with its terms and privacy note one click away (each opens as a page).
 * Sign-up shows them, and so does the notice that asks a signed-in person to agree again when the terms change.
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
      <p className="mb-3 text-xs text-muted-foreground" role="status">
        Loading this server's terms…
      </p>
    );
  }
  if (state.status === "unavailable") {
    return (
      <div
        className="mb-3 text-xs text-muted-foreground"
        data-testid="onboarding-policy-unavailable"
      >
        <p>{TERMS_NOT_LOADED}</p>
        {onRetry ? (
          <button
            className="mt-1 font-medium text-foreground underline underline-offset-2"
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
      className="font-medium text-foreground underline underline-offset-2"
      href={`${base}/api/join-policy/${path}`}
      rel="noopener noreferrer"
      target="_blank"
    >
      {label}
    </a>
  );
  return (
    <div
      className="mb-3 space-y-2 rounded-xl border border-black/10 bg-black/[0.03] p-3 text-xs text-muted-foreground dark:border-white/10 dark:bg-white/[0.04]"
      data-testid="onboarding-policy"
    >
      {needs.age ? (
        <label className="flex items-start gap-2">
          <input
            checked={ageOk}
            className="mt-0.5"
            data-testid="onboarding-policy-age"
            onChange={(e) => onAgeOk(e.target.checked)}
            type="checkbox"
          />
          <span>{AGE_CONFIRMATION}</span>
        </label>
      ) : null}
      {needs.agreement ? (
        <label className="flex items-start gap-2">
          <input
            checked={agreed}
            className="mt-0.5"
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
