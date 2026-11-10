/**
 * A person's track record on their profile: the work projects accepted from them (each with its project and date),
 * how many of their tasks were sent back or given up, and for a founder the updates they posted, what came of their
 * promises, and how many of their own records they removed.
 *
 * Only records whose signers prove them count (`lib/track-record.ts`). There is no score and nobody is ranked. When
 * a read was cut short the numbers are not stated; when it failed the card says so, with a way to read again.
 */

import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";

import { agentLabel } from "../lib/agent-label";
import { promiseTotalsLine } from "../lib/promises";
import { removedLine } from "../lib/removed-records";
import { acceptedLine, missesLine, updatesLine } from "../lib/track-record";
import { useTrackRecord } from "../use-tasks";
import { day, EvidenceLinks } from "./TaskParts";

/** How many accepted pieces show at first, and how many more each press adds. */
const PAGE = 10;

export function PersonTrackRecord({
  pubkey,
  isSelf,
}: {
  pubkey: string;
  isSelf: boolean;
}) {
  const read = useTrackRecord(pubkey);
  const [shown, setShown] = useState(PAGE);
  const data = read.data;
  const names = useUserNames([
    ...(data?.helper.accepted.map((work) => work.confirmedBy) ?? []),
    ...(data?.helper.agent?.owner ? [data.helper.agent.owner] : []),
  ]);

  if (!data) {
    return (
      <section
        aria-busy={read.isError ? undefined : "true"}
        aria-label="Track record"
        className="px-4 py-4"
        data-testid="track-record"
      >
        {read.isError ? (
          <p className="text-sm" data-testid="track-record-failed" role="alert">
            Couldn't read this track record.{" "}
            <Button
              onClick={() => void read.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Reading the track record…
          </p>
        )}
      </section>
    );
  }

  const { helper, founder, removed, complete, projects } = data;
  const misses = missesLine(helper);
  const promises = promiseTotalsLine(founder.promises);
  const removedText = removedLine(removed, day);
  const nothing =
    helper.accepted.length === 0 &&
    !misses &&
    helper.open === 0 &&
    helper.unreadProjects === 0 &&
    founder.updates === 0;

  return (
    <section
      aria-labelledby="track-record-heading"
      className="px-4 py-4"
      data-testid="track-record"
    >
      <h2
        className="text-sm font-bold text-black dark:text-white"
        id="track-record-heading"
      >
        Track record
      </h2>
      <p className="text-xs text-muted-foreground">
        Counted only from signed records: work counts when someone else on that
        project's team confirmed it. Nobody is scored or ranked.
      </p>
      {helper.agent ? (
        <p className="mt-2">
          <Chip data-testid="track-record-agent" tone="info">
            {agentLabel(helper.agent.owner ? names(helper.agent.owner) : null)}
          </Chip>
        </p>
      ) : null}
      {read.isError ? (
        <p className="mt-2 text-sm" role="status">
          Couldn't check for newer records.{" "}
          <Button
            onClick={() => void read.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : null}

      {complete ? (
        nothing ? (
          <p
            className="mt-3 text-sm text-muted-foreground"
            data-testid="track-record-empty"
          >
            {isSelf
              ? "Nothing here yet. Work shows here once a project's team confirms it, and updates show once you post them on a project of your own."
              : "Nothing here yet. Work shows here once a project's team confirms it."}
          </p>
        ) : (
          <div className="mt-3 text-sm" data-testid="track-record-totals">
            <p className="font-semibold" data-testid="track-record-accepted">
              {acceptedLine(helper.accepted.length)}
            </p>
            {misses ? <p data-testid="track-record-misses">{misses}</p> : null}
            {helper.open > 0 ? (
              <p data-testid="track-record-open">
                {helper.open === 1
                  ? "1 task in progress"
                  : `${helper.open} tasks in progress`}
              </p>
            ) : null}
            {helper.unreadProjects > 0 ? (
              <p data-testid="track-record-unread-projects">
                {helper.unreadProjects === 1
                  ? "Tasks on 1 project are not counted: that project's record could not be read, so who is on its team is not known."
                  : `Tasks on ${helper.unreadProjects} projects are not counted: those projects' records could not be read, so who is on their teams is not known.`}
              </p>
            ) : null}
            {founder.updates > 0 ? (
              <p className="mt-2" data-testid="track-record-founder">
                <span className="font-semibold">As a founder:</span>{" "}
                {updatesLine(founder)}
                {promises ? `. Promises: ${promises}` : ""}
              </p>
            ) : null}
          </div>
        )
      ) : (
        <p className="mt-3 text-sm" data-testid="track-record-cut">
          This person has more records than could be read here, so the numbers
          could not be worked out. What was read is listed below.{" "}
          <Button
            onClick={() => void read.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      )}
      {removedText ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="track-record-removed"
        >
          {removedText
            .replace(/^The founder has/, "This person has")
            .replace(
              /^Whether the founder has/,
              "Whether this person has",
            )}{" "}
          Anyone can remove a record they signed, and a removed record is not
          counted here.
        </p>
      ) : null}

      {helper.accepted.length > 0 ? (
        <>
          <h3 className="mt-4 text-sm font-bold text-black dark:text-white">
            Work accepted
          </h3>
          <ol className="mt-2 flex flex-col gap-3" data-testid="track-work">
            {helper.accepted.slice(0, shown).map((work) => {
              const project = projects[work.coordinate];
              return (
                <li
                  className="min-w-0 text-sm"
                  data-testid="track-work-item"
                  key={work.taskId}
                >
                  <p className="break-words">{work.what}</p>
                  <p className="break-words text-xs text-muted-foreground">
                    {project ? (
                      <Link
                        className="text-foreground underline"
                        params={{ launchId: project.id }}
                        search={{ author: project.author }}
                        to="/launchpad/$launchId"
                      >
                        {project.name}
                      </Link>
                    ) : (
                      "A project"
                    )}
                    {" · "}confirmed by {names(work.confirmedBy)} on{" "}
                    {day(work.at)}
                  </p>
                  <EvidenceLinks files={work.files} links={work.links} />
                </li>
              );
            })}
          </ol>
          {helper.accepted.length > shown ? (
            <Button
              className="mt-2"
              onClick={() => setShown((n) => n + PAGE)}
              size="sm"
              type="button"
              variant="outline"
            >
              Show more
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
