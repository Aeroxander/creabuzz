/**
 * The people who asked to join a project, with the founder's one press: Accept (`lib/join.ts`, `useAcceptJoin`).
 *
 * The same list is in the project's Team card (one project) and in Notifications (every project that has asks, each with
 * its name). Accepting adds the person to the project record; what the founder just did shows at once and gives way
 * to what is read back. A failed accept says so beside the person, and its button is the retry.
 *
 * Also here: "Copy link to invite people", the Team card's way to hand out the project's public link, where a person
 * presses Ask to join.
 */

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { FailureNote } from "@/shared/ui/failure-note";

import type { JoinAsk } from "../lib/join";
import { projectSharePath } from "../lib/share";
import type { LaunchRecord } from "../models";
import { useProjectAsks } from "../use-join";
import { useAcceptJoin } from "../use-team";

/**
 * The asks seen so far while this list is on the page. The list keeps being drawn after the last ask is accepted (the
 * read-back drops it at once), so "is on the team" can be said where the button was.
 */
function useSeenAsks(waiting: readonly JoinAsk[]) {
  const [seen, setSeen] = useState<readonly JoinAsk[]>([]);
  useEffect(() => {
    setSeen((was) => {
      const known = new Set(was.map((a) => a.id));
      const fresh = waiting.filter((a) => !known.has(a.id));
      return fresh.length === 0 ? was : [...was, ...fresh];
    });
  }, [waiting]);
  return seen;
}

/**
 * The asks of one project, each with Accept: the ones waiting now, and the ones just accepted as "is on the team".
 * `withProject` names the project on each line (Notifications). Nothing is drawn when nothing was ever waiting.
 */
export function JoinRequestsList({
  record,
  waiting,
  withProject = false,
  heading = false,
}: {
  record: LaunchRecord;
  waiting: readonly JoinAsk[];
  withProject?: boolean;
  /** Put "Asked to join" above the list (the Team card; Notifications has its own heading). */
  heading?: boolean;
}) {
  const seen = useSeenAsks(waiting);
  const asks = seen.length > 0 ? seen : waiting;
  const current = new Set(waiting.map((a) => a.id));
  const accept = useAcceptJoin(record.id);
  const [added, setAdded] = useState<readonly string[]>([]);
  const [failure, setFailure] = useState<{
    pubkey: string;
    words: FailureWords;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const names = useUserNames([
    ...asks.map((a) => a.author),
    ...added,
    record.author,
  ]);

  const press = async (ask: JoinAsk) => {
    if (busy !== null) return;
    setBusy(ask.author);
    setFailure(null);
    try {
      await accept.mutateAsync({ author: ask.author, invite: ask.invite });
      setAdded((was) => [...was, ask.author]);
    } catch (cause) {
      setFailure({
        pubkey: ask.author,
        words: failureWords(
          cause,
          `${names(ask.author)} was not added: the change was not saved. Press Accept to try again.`,
        ),
      });
    } finally {
      setBusy(null);
    }
  };
  // People just added show as added until the read-back drops them from the waiting list.
  const open = asks.filter(
    (a) => current.has(a.id) && !added.includes(a.author),
  );
  if (open.length === 0 && added.length === 0) return null;
  return (
    <>
      {heading ? (
        <h3 className="text-xs font-bold text-muted-foreground">
          Asked to join
        </h3>
      ) : null}
      <ul
        className="mt-1 flex flex-col gap-2 text-sm"
        data-testid="join-requests"
      >
        {added.map((pubkey) => (
          <li data-testid="join-added" key={`added-${pubkey}`} role="status">
            {names(pubkey)} is on the team.
          </li>
        ))}
        {open.map((ask) => (
          <li
            className="flex flex-wrap items-center justify-between gap-2"
            data-testid="join-request"
            key={ask.id}
          >
            <span className="min-w-0 break-words">
              <span className="font-semibold">{names(ask.author)}</span> asked
              to join
              {withProject ? (
                <>
                  {" "}
                  <Link
                    className="font-semibold underline"
                    params={{ launchId: record.id }}
                    search={{ author: record.author }}
                    to="/launchpad/$launchId"
                  >
                    {record.name}
                  </Link>
                </>
              ) : null}
              .
            </span>
            <Button
              aria-label={`Accept ${names(ask.author)}${withProject ? ` to ${record.name}` : ""}`}
              data-testid="join-accept"
              disabled={busy !== null}
              onClick={() => void press(ask)}
              size="sm"
              type="button"
            >
              Accept
            </Button>
            {failure?.pubkey === ask.author ? (
              <FailureNote
                className="basis-full"
                failure={failure.words}
                testId="join-accept-failed"
              />
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The founder's list in the Team card: the asks waiting on this project, or nothing when there are none. */
export function ProjectJoinRequests({ record }: { record: LaunchRecord }) {
  const asks = useProjectAsks(record, true);
  if (asks.failed)
    return (
      <p className="mt-3 text-sm" data-testid="join-read-failed" role="alert">
        Couldn't check who asked to join.{" "}
        <Button onClick={asks.retry} size="sm" type="button" variant="outline">
          Try again
        </Button>
      </p>
    );
  return (
    <div className="mt-3 empty:hidden" data-testid="join-section">
      <JoinRequestsList heading record={record} waiting={asks.pending} />
      {asks.cut ? (
        <p className="mt-1 text-xs text-muted-foreground" role="note">
          More people asked than could be read, so someone may be missing here.
        </p>
      ) : null}
    </div>
  );
}

/** "Copy link to invite people": the project's public link, where a person presses Ask to join. */
export function CopyInviteLink({
  project,
}: {
  project: Pick<LaunchRecord, "id" | "author">;
}) {
  const [copied, setCopied] = useState<"no" | "copied" | "manual">("no");
  const link = `${window.location.origin}${projectSharePath(project)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("copied");
    } catch {
      setCopied("manual");
    }
  };
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        data-testid="team-copy-link"
        onClick={() => void copy()}
        size="sm"
        type="button"
        variant="outline"
      >
        Copy link to invite people
      </Button>
      <p
        className="min-h-4 text-xs text-muted-foreground"
        data-testid="team-copy-status"
        role="status"
      >
        {copied === "copied"
          ? "Copied. People who open it can ask to join."
          : ""}
      </p>
      {copied === "manual" ? (
        <input
          aria-label="Your project's link"
          className="h-9 w-full rounded-lg border bg-background px-2 text-sm"
          data-testid="team-copy-link-field"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={link}
        />
      ) : null}
    </div>
  );
}
