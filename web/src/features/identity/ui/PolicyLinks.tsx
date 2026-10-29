/**
 * "Terms of use" and "Privacy note" in the profile menu, so both, and the contact they name, can be found again after
 * sign-up. Each opens the page the server serves; a server that serves neither shows nothing here (`policyLinks`).
 */

import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";

import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

import { policyFromResponse } from "../lib/join-policy";
import { policyLinks } from "../lib/policy-links";

/** The server's HTTP address, or null when this browser has none to ask yet. */
function serverBase(): string | null {
  try {
    return relayHttpBaseUrl();
  } catch {
    return null;
  }
}

export function PolicyLinks() {
  const base = serverBase();
  // The same answer sign-up reads. A failure only hides the links: they are a way back to the pages, not a gate.
  const policy = useQuery({
    queryKey: ["join-policy", base],
    enabled: base !== null,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async ({ signal }) => {
      const response = await fetch(`${base}/api/join-policy`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return policyFromResponse(await response.json());
    },
  });
  const links =
    base !== null && policy.data ? policyLinks(policy.data, base) : [];
  if (links.length === 0) return null;
  return (
    <div
      className="mt-2 border-t border-black/10 pt-2 dark:border-white/10"
      data-testid="profile-policy-links"
    >
      {links.map((link) => (
        <a
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
          data-testid={`profile-policy-${link.key}`}
          href={link.href}
          key={link.key}
          rel="noopener noreferrer"
          target="_blank"
        >
          <FileText aria-hidden className="h-3.5 w-3.5" />
          {link.label}
        </a>
      ))}
    </div>
  );
}
