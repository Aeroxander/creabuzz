import { Link } from "@tanstack/react-router";

import { existingUserPubkey } from "@/shared/lib/identity";

/**
 * "Start your own project": a quiet link for someone with no account on a project's page or scorecard. It is a text
 * link, never a green button: the page's one green button is the page's own next step. It shows nothing once the
 * browser has an account.
 */
export function StartYours() {
  if (existingUserPubkey() !== null) return null;
  return (
    <Link
      className="inline-flex min-h-8 items-center text-sm text-primary-ink underline-offset-4 hover:underline max-sm:min-h-11"
      data-testid="start-yours"
      to="/start"
    >
      Start your own project
    </Link>
  );
}
