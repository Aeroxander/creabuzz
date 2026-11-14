/**
 * Work: one place for what there is to do. Signed in, what is waiting on you comes first (every item, each with its
 * one action); then every open request for help across the listed projects, with its size, and "I can do this" as
 * the one tap. It replaces looking for work one project at a time.
 *
 * Reads are bounded: the requests come from the projects read so far and one check of which are still open. When
 * either could not be read in full the page says so; a failed read is said with a retry, never shown as "no work".
 */

import { Link } from "@tanstack/react-router";
import { Hammer } from "lucide-react";
import { useMemo, useState } from "react";

import { needWords } from "@/features/launchpad/lib/project-state";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { HELP_SIZE_LABEL } from "@/features/launchpad/lib/weekly-update";
import { NeedLink } from "@/features/launchpad/ui/NeedLink";
import { useStillOpen } from "@/features/launchpad/use-help-requests";
import { useLaunches } from "@/features/launchpad/use-launches";
import { useMyNeeds } from "@/features/launchpad/use-my-projects";
import { railHelpCandidates } from "@/features/social/lib/rail";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { PageHeader, SectionHeader } from "@/shared/ui/PageHeader";

import {
  bySize,
  openCountLine,
  SIZE_FILTERS,
  type SizeFilter,
} from "../lib/open-work";
import { YourWork } from "./YourWork";

/** How many requests the page checks and lists: the newest, one per project. */
const REQUESTS = 60;

const ACTION_CLASS =
  "inline-flex shrink-0 items-center rounded-full bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 max-sm:min-h-11 max-sm:px-4";

function WaitingOnYou() {
  const mine = useMyNeeds();
  return (
    <section
      aria-labelledby="work-waiting-heading"
      className="flex flex-col gap-3"
      data-testid="work-waiting"
    >
      <SectionHeader
        description="Things only you can move forward, the ones other people are waiting for first."
        title={<span id="work-waiting-heading">Waiting on you</span>}
      />
      {mine.failed ? (
        <p className="text-sm" data-testid="work-waiting-failed" role="alert">
          Couldn't check what is waiting on you.{" "}
          <Button
            onClick={mine.retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : !mine.ready ? (
        <p className="text-sm text-muted-foreground" role="status">
          Checking your projects and tasks…
        </p>
      ) : mine.needs.length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="work-waiting-none"
        >
          {mine.partial
            ? "Nothing found, but not all of your projects could be read here."
            : "Nothing is waiting on you."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {mine.needs.map(({ need, project }) => {
            const words = needWords(need, project.name);
            return (
              <li
                data-kind={need.kind}
                data-testid="work-waiting-item"
                key={`${need.kind}:${need.coordinate}:${"taskId" in need ? need.taskId : "updateId" in need ? need.updateId : ""}`}
              >
                <Card className="flex flex-wrap items-center gap-3 p-3">
                  <p className="min-w-0 flex-1 break-words text-sm">
                    {words.text}
                  </p>
                  <NeedLink
                    className={ACTION_CLASS}
                    need={need}
                    project={project}
                  >
                    {words.action}
                  </NeedLink>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function WorkPage() {
  const me = existingUserPubkey();
  const launches = useLaunches();
  const raises = raisesOffered();
  const [size, setSize] = useState<SizeFilter>("all");
  const candidates = useMemo(
    () => railHelpCandidates(launches.data ?? [], raises, REQUESTS),
    [launches.data, raises],
  );
  const open = useStillOpen(candidates, REQUESTS);
  const shown = bySize(open.requests, size);
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8"
      data-testid="work-page"
    >
      <PageHeader
        description="Real projects asking for a hand. Pick something, say you can do it, and your accepted work goes on your record."
        title={
          <span className="flex items-center gap-2">
            <Hammer aria-hidden className="h-5 w-5" /> Work
          </span>
        }
      />
      {me ? <WaitingOnYou /> : null}
      {me ? <YourWork me={me} /> : null}
      <section
        aria-labelledby="work-open-heading"
        className="flex flex-col gap-3"
        data-testid="work-open"
      >
        <SectionHeader
          description="Each project's newest request for help."
          title={<span id="work-open-heading">Open work</span>}
        />
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Show work of this size</legend>
          {SIZE_FILTERS.map((filter) => (
            <Button
              aria-pressed={size === filter.id}
              className="max-sm:h-11"
              data-testid={`work-size-${filter.id}`}
              key={filter.id}
              onClick={() => setSize(filter.id)}
              size="sm"
              type="button"
              variant={size === filter.id ? "default" : "outline"}
            >
              {filter.label}
            </Button>
          ))}
        </fieldset>
        {launches.isError && !launches.data ? (
          <p className="text-sm" data-testid="work-open-failed" role="alert">
            Couldn't load the projects, so their requests can't be shown.{" "}
            <Button
              onClick={() => void launches.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </p>
        ) : open.failed ? (
          <p className="text-sm" data-testid="work-open-failed" role="alert">
            Couldn't check which requests are still open.{" "}
            <Button
              onClick={open.retry}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </p>
        ) : open.cut ? (
          <p className="text-sm" data-testid="work-open-unknown" role="status">
            There are too many answers to these requests to tell here which are
            still open, so none is listed. A project's own page shows its
            request.
          </p>
        ) : launches.isLoading || (candidates.length > 0 && !open.known) ? (
          <p className="text-sm text-muted-foreground" role="status">
            Looking for open work…
          </p>
        ) : shown.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="work-open-empty"
          >
            {size === "all"
              ? "No project is asking for help right now. "
              : "Nothing of that size right now. "}
            <Link className="underline" to="/discover">
              Follow a project
            </Link>{" "}
            and you'll see when it asks.
          </p>
        ) : (
          <>
            <p
              className="text-xs text-muted-foreground"
              data-testid="work-open-count"
            >
              {openCountLine(shown.length)}
            </p>
            <ul className="flex flex-col gap-3">
              {shown.map(({ project, updateId, ask, at }) => (
                <li data-testid="work-open-item" key={updateId}>
                  <Card className="flex flex-col gap-2 p-4">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <Link
                        className="inline-flex items-center font-bold hover:underline max-sm:min-h-11"
                        params={{ launchId: project.id }}
                        search={{ author: project.author }}
                        to="/launchpad/$launchId"
                      >
                        {project.name}
                      </Link>
                      <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-bold text-primary-ink">
                        {HELP_SIZE_LABEL[ask.size]}
                        {ask.time ? ` · ${ask.time}` : ""}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        asked {relativeTime(at)}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {ask.text}
                    </p>
                    <div>
                      <Link
                        aria-label={`I can do this: ${project.name}`}
                        className={ACTION_CLASS}
                        data-testid="work-open-do"
                        hash={`update-${updateId}`}
                        params={{ launchId: project.id }}
                        search={{ author: project.author, tab: "updates" }}
                        to="/launchpad/$launchId"
                      >
                        I can do this
                      </Link>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          </>
        )}
        {launches.hasMore || launches.cut || launches.newsCut ? (
          <p className="text-xs" data-testid="work-open-partial" role="status">
            These come from the newest projects and their newest news. An older
            project may be asking too: its own page shows it.
          </p>
        ) : null}
      </section>
    </div>
  );
}
