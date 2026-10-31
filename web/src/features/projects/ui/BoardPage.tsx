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
import { ArrowRight, LayoutGrid, Plus } from "lucide-react";
import { useState } from "react";

import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { useUserNames } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { errorMessage, QueryError } from "@/shared/ui/query-error";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import type { ProjectSummary } from "../lib/state";
import { PROJECT_EVENT_KINDS, useBoard } from "../use-projects";
import { PitchDialog } from "./PitchDialog";
import { ProjectCardFrame } from "./ProjectCardFrame";

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
    <ProjectCardFrame
      aside={
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
      }
      card={card}
      nameOf={nameOf}
      titleTestId="board-card-title"
    />
  );
}

export function BoardPage() {
  const { projects, isLoading, error, refetch } = useBoard();
  const [pitchOpen, setPitchOpen] = useState(false);
  const me = existingUserPubkey();
  const nameOf = useUserNames(projects.map((card) => card.founder));
  const myPending = projects.some((card) => card.myRequestPending);
  // A contributor-only build has no raise to carry shares over to and no percentage seats to pitch: starting something
  // there is a contributor project.
  const raises = raisesOffered();
  const startProject = (
    <Button asChild size="sm">
      <Link data-testid="board-start-project" to="/start/contributor">
        <Plus className="mr-1 h-4 w-4" aria-hidden /> Start a project
      </Link>
    </Button>
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <PageHeader
        action={
          raises ? (
            <Button onClick={() => setPitchOpen(true)} size="sm">
              <Plus className="mr-1 h-4 w-4" /> Pitch a project
            </Button>
          ) : (
            startProject
          )
        }
        description={
          raises
            ? "Founders pitch projects here. Pick a role and ask to join; if the founder agrees, your share is recorded. It is not a legal contract, and it can be undone until the project's DAO takes it on."
            : "Projects people have pitched, and the roles they need help with."
        }
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
          description="The server did not answer the project query, so nothing can be listed."
          error={error}
          kinds={PROJECT_EVENT_KINDS}
          message={errorMessage(error)}
          onRetry={refetch}
          recovery={(onUnlocked) => (
            <SignRecovery
              autoResume
              onUnlocked={onUnlocked}
              showHeadline={false}
            />
          )}
          relayUrl={relayWsUrl()}
          testId="projects-load-error"
          title="Couldn't load the board"
        />
      ) : projects.length === 0 ? (
        <div
          className="rounded-2xl border border-dashed border-black/15 px-5 py-12 text-center dark:border-white/15"
          data-testid="board-empty"
        >
          <p className="text-sm text-black/60 dark:text-white/60">
            {raises
              ? "No projects on the board yet. Founders, pitch the first one: the idea, the role you take, and the roles you need."
              : "No projects on the board yet."}
          </p>
          <div className="mt-4 flex justify-center">
            {raises ? (
              <Button onClick={() => setPitchOpen(true)} size="sm">
                <Plus className="mr-1 h-4 w-4" /> Pitch a project
              </Button>
            ) : (
              startProject
            )}
          </div>
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
          {raises ? (
            <Link
              className="flex items-center justify-between rounded-2xl border border-violet-500/30 bg-violet-500/5 px-4 py-3 text-sm transition-colors hover:bg-violet-500/10"
              to="/launchpad"
            >
              <span>
                Ready to raise money later? The agreed shares carry over to the
                project's launch.
              </span>
              <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
            </Link>
          ) : null}
        </>
      )}

      {raises ? (
        <PitchDialog onOpenChange={setPitchOpen} open={pitchOpen} />
      ) : null}
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
