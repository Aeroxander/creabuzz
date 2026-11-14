/**
 * A person's track record on their profile: the work projects accepted from them (each with its project, who
 * confirmed it and how that person stands to the project), how many of their tasks were sent back or given up, and
 * for a founder the updates they posted, what came of their promises, and how many of their own records they removed.
 *
 * Only records whose signers prove them count (`lib/track-record.ts`), and a task counts only once the person signed
 * a step for it themselves. There is no score and nobody is ranked: anyone can start a project and confirm work on
 * it, so the page says who confirmed each piece and lets the reader judge.
 *
 * When a read was cut short the numbers are not stated and nothing is listed as accepted; when it failed the card
 * says so, with a way to read again.
 */

import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";

import { agentLabel } from "../lib/agent-label";
import { promiseTotalsLine } from "../lib/promises";
import { memberRemovedLine, removedLine } from "../lib/removed-records";
import { TRACK_PROJECTS } from "../lib/task-reads";
import {
  acceptedLine,
  confirmedByLine,
  missesLine,
  tieLine,
  updatesLine,
} from "../lib/track-record";
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
    ...(data?.helper.soleConfirmer.map((sole) => sole.by) ?? []),
    ...(data?.helper.agent?.owner ? [data.helper.agent.owner] : []),
    ...(data?.ownersRemoved.map((owner) => owner.pubkey) ?? []),
  ]);
  const again = (
    <Button
      onClick={() => void read.refetch()}
      size="sm"
      type="button"
      variant="outline"
    >
      Try again
    </Button>
  );

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
            Couldn't read this track record. {again}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Reading the track record…
          </p>
        )}
      </section>
    );
  }

  const { helper, founder, removed, projects } = data;
  const misses = missesLine(helper);
  const promises = promiseTotalsLine(founder.promises);
  const removedText = removedLine(removed, day);
  const helperKnown = data.helperComplete;
  const nothing =
    helper.accepted.length === 0 &&
    !misses &&
    helper.open === 0 &&
    helper.unreadProjects === 0 &&
    helper.stepsMissing === 0 &&
    helper.outsideTasks === 0 &&
    founder.updates === 0;
  const projectName = (coordinate: string) =>
    projects[coordinate]?.name ?? "a project";

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
      <p
        className="text-xs text-muted-foreground"
        data-testid="track-record-how"
      >
        Counted only from signed records, and only for tasks this account signed
        a step on. Work counts when someone on that project's team now, other
        than the person who did it, confirmed it. Anyone can start a project and
        confirm work on it, so read who confirmed each piece. A project's team
        can change. Nobody is scored or ranked.
      </p>
      {helper.agent ? (
        <p className="mt-2 text-sm">
          <Chip data-testid="track-record-agent" tone="info">
            {agentLabel(helper.agent.owner ? names(helper.agent.owner) : null)}
          </Chip>
          {helper.agent.owner ? null : (
            <span className="ml-2" data-testid="track-record-agent-unowned">
              This account does not say who runs it.
            </span>
          )}
        </p>
      ) : null}
      {read.isError ? (
        <p className="mt-2 text-sm" role="status">
          Couldn't check for newer records. {again}
        </p>
      ) : null}

      {helperKnown ? (
        nothing && data.founderComplete ? (
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
              {acceptedLine(helper)}
            </p>
            {helper.soleConfirmer.map((sole) => (
              <p data-testid="track-record-sole" key={sole.coordinate}>
                On {projectName(sole.coordinate)}, one person ({names(sole.by)})
                confirmed all {sole.pieces} pieces.
              </p>
            ))}
            {misses ? <p data-testid="track-record-misses">{misses}</p> : null}
            {helper.open > 0 ? (
              <p data-testid="track-record-open">
                {helper.open === 1
                  ? "1 task in progress"
                  : `${helper.open} tasks in progress`}
              </p>
            ) : null}
            {helper.stepsMissing > 0 ? (
              <p data-testid="track-record-steps-missing">
                {helper.stepsMissing === 1
                  ? "On 1 task a step was removed: the team recorded steps on it, and no step signed by this account is there. It is not counted either way."
                  : `On ${helper.stepsMissing} tasks a step was removed: the team recorded steps on them, and no step signed by this account is there. They are not counted either way.`}
              </p>
            ) : null}
            {helper.outsideTasks > 0 ? (
              <p data-testid="track-record-outside-tasks">
                {helper.outsideTasks === 1
                  ? "1 task this account took on was made by someone who is not on that project's team now. Only what this account signed itself is counted from it."
                  : `${helper.outsideTasks} tasks this account took on were made by people who are not on those projects' teams now. Only what this account signed itself is counted from them.`}
              </p>
            ) : null}
            {helper.outsideAnswers > 0 ? (
              <p data-testid="track-record-outside-answers">
                {helper.outsideAnswers === 1
                  ? "1 answer on this account's work is by someone who is not on that project's team now. It is not counted."
                  : `${helper.outsideAnswers} answers on this account's work are by people who are not on those projects' teams now. They are not counted.`}
              </p>
            ) : null}
            {helper.unreadProjects > 0 ? (
              <p data-testid="track-record-unread-projects">
                {helper.unreadProjects === 1
                  ? "Tasks on 1 project are counted only by what this account signed itself: that project's record could not be read, so who is on its team is not known."
                  : `Tasks on ${helper.unreadProjects} projects are counted only by what this account signed itself: those projects' records could not be read, so who is on their teams is not known.`}
              </p>
            ) : null}
            {data.tooManyProjects ? (
              <p data-testid="track-record-too-many">
                This account has tasks on more than {TRACK_PROJECTS} projects.
                Only the first {TRACK_PROJECTS} are read here, so these numbers
                leave the rest out.
              </p>
            ) : null}
          </div>
        )
      ) : (
        <p className="mt-3 text-sm" data-testid="track-record-cut">
          This account has more task records than could be read here, so the
          numbers could not be worked out and no work is listed as accepted.{" "}
          {again}
        </p>
      )}
      {founder.updates > 0 || !data.founderComplete ? (
        data.founderComplete ? (
          <p className="mt-2 text-sm" data-testid="track-record-founder">
            <span className="font-semibold">As a founder:</span>{" "}
            {updatesLine(founder)}
            {promises ? `. Promises: ${promises}` : ""}
          </p>
        ) : (
          <p className="mt-2 text-sm" data-testid="track-record-founder-cut">
            This account has more update records than could be read here, so its
            updates and promises could not be counted. {again}
          </p>
        )
      ) : null}
      {data.othersCut ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Answers from people who are not on the teams could not all be read.
          They are never counted.
        </p>
      ) : null}
      {removedText ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="track-record-removed"
        >
          {removedText
            .replace(/^The founder has/, "This account has")
            .replace(
              /^Whether the founder has/,
              "Whether this account has",
            )}{" "}
          Anyone can remove a record they signed, and a removed record is not
          counted here.
        </p>
      ) : null}
      {data.ownersRemoved.map((owner) => {
        const line = memberRemovedLine(
          `${names(owner.pubkey)}, who runs this account,`,
          owner.removed,
          day,
        );
        return line ? (
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-testid="track-record-owner-removed"
            key={owner.pubkey}
          >
            {line} Whoever runs an agent account can remove its records too, so
            their removals are counted here as well.
          </p>
        ) : null;
      })}

      {helperKnown && helper.accepted.length > 0 ? (
        <>
          <h3 className="mt-4 text-sm font-bold text-black dark:text-white">
            Work accepted
          </h3>
          <ol className="mt-2 flex flex-col gap-3" data-testid="track-work">
            {helper.accepted.slice(0, shown).map((work) => {
              const project = projects[work.coordinate];
              const tie = tieLine(work);
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
                    {" · "}
                    {confirmedByLine(work, names)}, dated {day(work.at)}
                  </p>
                  {tie ? (
                    <p
                      className="text-xs font-medium"
                      data-testid="track-work-tie"
                    >
                      {tie}.
                    </p>
                  ) : null}
                  {work.sameOffer > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {work.sameOffer === 1
                        ? "1 more accepted task was made from the same offer. It is counted once."
                        : `${work.sameOffer} more accepted tasks were made from the same offer. They are counted once.`}
                    </p>
                  ) : null}
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
