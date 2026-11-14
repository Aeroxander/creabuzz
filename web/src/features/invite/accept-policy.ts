/**
 * Agreeing to a server's join terms from an invite (`POST /api/invites/accept-policy`): the receipt the claim carries.
 * Bounded like the terms load: a server that takes the request and never answers is said so after ten seconds, instead
 * of leaving the join button waiting for good.
 *
 * Alias-free: `accept-policy.test.mjs` drives it under `node --test`.
 */

import { InviteRequestError } from "./invite-errors.ts";

/** How long to wait for the server's terms, or for its answer to agreeing to them. */
export const POLICY_TIMEOUT_MS = 10_000;

export interface PolicyAgreement {
  code: string;
  /** The version of the terms the person read and agreed to. */
  version: string;
  ageConfirmed: boolean;
}

/**
 * Agree to the terms and return the server's receipt. Throws an `InviteRequestError` for a refusal (a 400 means the
 * terms changed since they were read) and the browser's `TimeoutError` when the server does not answer in time; both
 * are said in words by `inviteProblem`.
 */
export async function acceptJoinPolicy(
  agreement: PolicyAgreement,
  {
    request = fetch,
    timeoutMs = POLICY_TIMEOUT_MS,
  }: { request?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const response = await request("/api/invites/accept-policy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: agreement.code,
      policy_version: agreement.version,
      age_confirmed: agreement.ageConfirmed,
    }),
    // Covers reading the answer too: a server that sends headers and then stalls is the same wait.
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as {
      error?: unknown;
    };
    // A 400 here is the server saying this agreement is not to its terms as they are now.
    const reason =
      response.status === 400
        ? "join_policy_not_accepted"
        : typeof json.error === "string"
          ? json.error
          : `HTTP ${response.status}`;
    throw new InviteRequestError(reason, response.status);
  }
  return ((await response.json()) as { receipt: string }).receipt;
}
