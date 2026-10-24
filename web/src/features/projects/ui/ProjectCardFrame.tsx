/**
 * The project card both listings share: the Project Board and the Discover
 * directory show the same project the same way (pitch, roles, who and when),
 * and only differ in the badges beside the title and what sits under the card.
 */

import { Link } from "@tanstack/react-router";
import { Check, Users } from "lucide-react";
import type { ReactNode } from "react";

import { relativeTime } from "@/shared/lib/relative-time";
import { Card } from "@/shared/ui/card";
import type { RoleDeclaration } from "../lib/manifest";
import type { ProjectSummary } from "../lib/state";

/**
 * The open/filled role chip: one component, one label owner, so the board and
 * the directory print the same `%` chip for the same role.
 */
export function RoleChip({
  role,
  filled,
}: {
  role: RoleDeclaration;
  filled: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${
        filled
          ? "bg-black/5 text-black/70 dark:bg-white/10 dark:text-white/70"
          : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      }`}
      data-testid={filled ? "role-chip-filled" : "role-chip-open"}
    >
      {filled ? <Check className="h-3 w-3" aria-hidden /> : null}
      {role.label} · {role.pct}%
    </span>
  );
}

export function ProjectCardFrame({
  card,
  nameOf,
  cardTestId,
  titleTestId,
  aside,
  children,
}: {
  card: ProjectSummary;
  nameOf: (pubkey: string) => string;
  cardTestId?: string;
  titleTestId: string;
  /** Badges to the right of the title. */
  aside?: ReactNode;
  /** Anything that belongs under the card's footer (an action button). */
  children?: ReactNode;
}) {
  return (
    <li>
      <Card className="flex h-full flex-col gap-3 p-4" data-testid={cardTestId}>
        <div className="flex items-start justify-between gap-2">
          <Link
            className="min-w-0 flex-1 truncate text-base font-semibold hover:underline"
            data-testid={titleTestId}
            search={{ action: undefined, author: card.founder }}
            to="/projects/$projectId"
            params={{ projectId: card.projectId }}
          >
            {card.name}
          </Link>
          {aside}
        </div>
        <p className="line-clamp-2 text-sm text-black/60 dark:text-white/60">
          {card.summary || "No pitch yet. Open it and read the roles."}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {card.openRoles.map((role) => (
            <RoleChip filled={false} key={role.slug} role={role} />
          ))}
          {card.filledRoles > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-2xs font-medium text-black/70 dark:bg-white/10 dark:text-white/70">
              <Users className="h-3 w-3" aria-hidden />
              {card.members} {card.members === 1 ? "member" : "members"}
            </span>
          ) : null}
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 text-2xs text-black/70 dark:text-white/70">
          <span className="truncate" title={card.founder}>
            {nameOf(card.founder)}
          </span>
          <span className="shrink-0">
            Updated {relativeTime(card.updatedAt)}
          </span>
        </div>
        {children}
      </Card>
    </li>
  );
}
