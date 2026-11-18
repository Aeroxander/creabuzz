/**
 * Team invitations in Notifications: each project whose founder added the person and still waits for their yes or no.
 * Each opens the project's page, where the answer is given. A read that fails is said, never shown as "none".
 */

import { Link } from "@tanstack/react-router";
import { Users } from "lucide-react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { Button } from "@/shared/ui/button";

import { useMyTeams } from "../use-team";

export function TeamInvitationsSection() {
  const read = useMyTeams();
  const invitations = read.data?.invitations ?? [];
  const names = useUserNames(invitations.map((i) => i.record.author));
  if (read.isError && !read.data)
    return (
      <p
        className="border-b border-black/10 px-4 py-3 text-sm dark:border-white/10"
        data-testid="social-team-invitations-failed"
        role="alert"
      >
        Couldn't check whether a project added you to its team.{" "}
        <Button
          onClick={() => void read.refetch()}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </p>
    );
  if (invitations.length === 0) return null;
  return (
    <section
      aria-label="Team invitations"
      className="border-b border-black/10 dark:border-white/10"
      data-testid="social-team-invitations"
    >
      <h2 className="flex items-center gap-2 px-4 pt-3 text-sm font-bold text-black dark:text-white">
        <Users aria-hidden className="h-4 w-4" /> Team invitations
      </h2>
      <ul>
        {invitations.map(({ record }) => (
          <li
            className="relative px-4 py-3 text-sm transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
            data-testid="social-team-invitation"
            key={`${record.author}:${record.id}`}
          >
            <p className="break-words text-black dark:text-white">
              <span className="font-bold">{names(record.author)}</span> added
              you to the team of{" "}
              <span className="font-bold">{record.name}</span>. Say yes or no on
              its page.
            </p>
            <Link
              aria-label={`Open ${record.name} to answer the invitation`}
              className="absolute inset-0"
              params={{ launchId: record.id }}
              search={{ author: record.author }}
              to="/launchpad/$launchId"
            />
          </li>
        ))}
      </ul>
      {read.data?.cut ? (
        <p
          className="px-4 pb-3 text-xs text-black/60 dark:text-white/60"
          role="note"
        >
          There are more projects naming you than could be read, so an
          invitation may be missing here.
        </p>
      ) : null}
    </section>
  );
}
