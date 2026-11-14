/**
 * The server's terms of use and privacy note at sign-up.
 *
 * The operator sets them on the server (`BUZZ_TERMS_OF_SERVICE_MARKDOWN`, `BUZZ_PRIVACY_POLICY_MARKDOWN`, and
 * `BUZZ_AGE_ATTESTATION_REQUIRED`), which answers `GET /api/join-policy` and serves each as a page. Sign-up asks the
 * person to agree (and to confirm their age when the server asks) before any account is made. When no server can be
 * reached, which is normal before a first community answers, sign-up is not blocked; the dialog says the terms could
 * not be loaded. The version agreed to is kept in this browser (`policy-acceptance.ts`).
 *
 * Alias-free: `join-policy.test.mjs` drives it under `node --test`.
 */

interface JoinPolicy {
  terms_markdown?: string;
  privacy_markdown?: string;
  age_attestation_required: boolean;
  version: string;
}

/** What the server said: a policy, none set, or no answer. */
export type PolicyState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "unavailable" }
  | { status: "ready"; policy: JoinPolicy };

/** The server's answer to `GET /api/join-policy` as a state; anything malformed is "unavailable", never "none". */
export function policyFromResponse(body: unknown): PolicyState {
  if (body === null || typeof body !== "object")
    return { status: "unavailable" };
  const policy = (body as { policy?: unknown }).policy;
  if (policy === undefined) return { status: "none" };
  if (policy === null || typeof policy !== "object")
    return { status: "unavailable" };
  const p = policy as Record<string, unknown>;
  if (typeof p.version !== "string" || p.version === "")
    return { status: "unavailable" };
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value : undefined;
  return {
    status: "ready",
    policy: {
      terms_markdown: text(p.terms_markdown),
      privacy_markdown: text(p.privacy_markdown),
      age_attestation_required: p.age_attestation_required === true,
      version: p.version,
    },
  };
}

/** What the person has to tick before an account can be made. */
export function policyRequirements(state: PolicyState): {
  agreement: boolean;
  age: boolean;
} {
  if (state.status !== "ready") return { agreement: false, age: false };
  const { policy } = state;
  return {
    agreement: Boolean(policy.terms_markdown || policy.privacy_markdown),
    age: policy.age_attestation_required,
  };
}

/** Whether sign-up may go ahead: the policy has been read (or cannot be) and every box it asks for is ticked. */
export function mayCreateAccount(
  state: PolicyState,
  ticked: { agreement: boolean; age: boolean },
): boolean {
  if (state.status === "loading") return false;
  const needs = policyRequirements(state);
  return (!needs.agreement || ticked.agreement) && (!needs.age || ticked.age);
}
