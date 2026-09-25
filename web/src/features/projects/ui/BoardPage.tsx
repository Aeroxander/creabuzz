/**
 * Project Board — the browse surface.
 *
 * Paperclip stance (`docs/paperclip-ux-reference.md` §1): every card answers
 * what is happening (the pitch), does it need me (the "needs you" / "your
 * request" badges), and what do I do about it (open a project, or pitch one).
 * No hidden affordances: requests that need the founder are counted on the
 * card itself, not discoverable only inside the detail page.
 */

import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, LayoutGrid, Plus, Users } from "lucide-react";
import { useState } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { PageHeader } from "@/shared/ui/PageHeader";
import { errorMessage, QueryError } from "@/shared/ui/query-error";
import type { RoleDeclaration } from "../lib/manifest";
import type { ProjectSummary } from "../lib/state";
import { useBoard } from "../use-projects";
import { PitchDialog } from "./PitchDialog";

/**
 * The open/filled role chip. Exported for `features/discover` so the
 * directory prints the same `%` chip the board does — one component, one
 * label owner, no drift between two views of the same role.
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
          ? "bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/50"
          : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      }`}
      data-testid={filled ? "role-chip-filled" : "role-chip-open"}
    >
      {filled ? <Check className="h-3 w-3" aria-hidden /> : null}
      {role.label} · {role.pct}%
    </span>
  );
}

function ProjectCard({
  card,
  me,
  nameOf,
}: {
  card: ProjectSummary;
  me: string | null;
  nameOf: (pubkey: string) => string;
}) {
  return (
    <li>
      <Card className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <Link
            className="min-w-0 flex-1 truncate text-base font-semibold hover:underline"
            data-testid="board-card-title"
            search={{ action: undefined, author: card.founder }}
            to="/projects/$projectId"
            params={{ projectId: card.projectId }}
          >
            {card.name}
          </Link>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {needsFounderAttention(card, me) ? (
              <span
                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-2xs font-medium text-amber-700 dark:text-amber-300"
                data-testid="board-needs-you"
              >
                {card.pendingRequests} need you
              </span>
            ) : null}
            {card.myRequestPending ? (
              <span
                className="rounded-full bg-sky-500/15 px-2 py-0.5 text-2xs font-medium text-sky-700 dark:text-sky-300"
                data-testid="board-my-request"
              >
                Your request is waiting
              </span>
            ) : null}
          </div>
        </div>
        <p className="line-clamp-2 text-sm text-black/60 dark:text-white/60">
          {card.summary || "No pitch yet — open it and read the roles."}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {card.openRoles.map((role) => (
            <RoleChip filled={false} key={role.slug} role={role} />
          ))}
          {card.filledRoles > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-2xs font-medium text-black/50 dark:bg-white/10 dark:text-white/50">
              <Users className="h-3 w-3" aria-hidden />
              {card.members} {card.members === 1 ? "member" : "members"}
            </span>
          ) : null}
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 text-2xs text-black/50 dark:text-white/50">
          <span className="truncate" title={card.founder}>
            {nameOf(card.founder)}
          </span>
          <span className="shrink-0">
            Updated {relativeTime(card.updatedAt)}
          </span>
        </div>
      </Card>
    </li>
  );
}

export function BoardPage() {
  const { projects, isLoading, error, refetch } = useBoard();
  const [pitchOpen, setPitchOpen] = useState(false);
  const me = existingUserPubkey();
  const nameOf = useUserNames(projects.map((card) => card.founder));
  const myPending = projects.some((card) => card.myRequestPending);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <PageHeader
        action={
          <Button onClick={() => setPitchOpen(true)} size="sm">
            <Plus className="mr-1 h-4 w-4" /> Pitch a project
          </Button>
        }
        description="Projects pitch themselves here. Pick a role, ask for a stake, and the founder's approval becomes a recorded ownership grant — revocable until the project's DAO adopts it, never a legal contract."
        title={
          <span className="flex items-center gap-2">
            <LayoutGrid className="h-5 w-5" /> Project board
          </span>
        }
      />

      {isLoading ? (
        <p className="py-8 text-center text-sm text-black/60 dark:text-white/60">
          Loading projects…
        </p>
      ) : error ? (
        <QueryError
          description="The relay did not answer the project query, so nothing can be listed."
          message={errorMessage(error)}
          onRetry={refetch}
          testId="projects-load-error"
          title="Couldn't load the board"
        />
      ) : projects.length === 0 ? (
        <div
          className="rounded-2xl border border-dashed border-black/15 px-5 py-12 text-center dark:border-white/15"
          data-testid="board-empty"
        >
          <p className="text-sm text-black/60 dark:text-white/60">
            No projects on the board yet. Founders: pitch the first one — idea,
            the role you take, and the roles you need.
          </p>
          <Button className="mt-4" onClick={() => setPitchOpen(true)} size="sm">
            <Plus className="mr-1 h-4 w-4" /> Pitch a project
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-black/60 dark:text-white/60">
            <span>
              {projects.length} {projects.length === 1 ? "project" : "projects"}
            </span>
            {myPending ? (
              <span data-testid="board-my-pending-note">
                You have a request waiting for a founder's answer.
              </span>
            ) : null}
          </div>
          <ul
            className="grid grid-cols-1 gap-4 md:grid-cols-2"
            data-testid="board-grid"
          >
            {projects.map((card) => (
              <ProjectCard card={card} key={card.key} me={me} nameOf={nameOf} />
            ))}
          </ul>
          <Link
            className="flex items-center justify-between rounded-2xl border border-violet-500/30 bg-violet-500/5 px-4 py-3 text-sm transition-colors hover:bg-violet-500/10"
            search={{ action: undefined, author: undefined }}
            to="/launchpad"
          >
            <span>
              Form the DAO later — the launchpad turns a recorded ownership map
              into a TGE allocation.
            </span>
            <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
          </Link>
        </>
      )}

      <PitchDialog onOpenChange={setPitchOpen} open={pitchOpen} />
    </div>
  );
}

/**
 * The badge that says "does it need me". Bound by the e2e card test
 * (`tests/e2e/projects.spec.ts` — `board-needs-you`); kept as a pure
 * function so the predicate stays inspectable outside the component tree.
 */
export function needsFounderAttention(
  card: ProjectSummary,
  me: string | null,
): boolean {
  return me !== null && card.founder === me && card.pendingRequests > 0;
}
