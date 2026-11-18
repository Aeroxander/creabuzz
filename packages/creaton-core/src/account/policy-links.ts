/**
 * Links back to the server's terms of use and privacy note, for after sign-up: the profile menu shows them so the
 * terms, and the contact they give, are not something a person can only find while making an account.
 *
 * A link is shown only for a page the server really serves (it said so in `GET /api/join-policy`, as sign-up reads it).
 * While the answer is loading, or when there is none, nothing is shown: a link to a page that is not there helps nobody.
 *
 * Alias-free: `policy-links.test.mjs` drives it under `node --test`.
 */

import type { PolicyState } from "./join-policy.ts";

export interface PolicyLink {
  key: "terms" | "privacy";
  label: string;
  href: string;
}

/** The links for `state`, against the server at `base` (its HTTP address, no trailing slash). */
export function policyLinks(state: PolicyState, base: string): PolicyLink[] {
  if (state.status !== "ready") return [];
  const links: PolicyLink[] = [];
  if (state.policy.terms_markdown) {
    links.push({
      key: "terms",
      label: "Terms of use",
      href: `${base}/api/join-policy/terms`,
    });
  }
  if (state.policy.privacy_markdown) {
    links.push({
      key: "privacy",
      label: "Privacy note",
      href: `${base}/api/join-policy/privacy`,
    });
  }
  return links;
}
