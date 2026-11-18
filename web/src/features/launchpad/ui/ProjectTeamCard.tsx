/**
 * A project's team, on its page (`lib/team.ts`).
 *
 * Everyone reads who is on the team (people who said yes), who was added and has not said yes yet, and who left and
 * when. The founder adds a person (found by name, or by a pasted account) and removes one; the person added answers
 * here with Join or No.
 *
 * The server lets someone act for the project from the moment the founder adds them, before they say yes. That is
 * said to the founder before they add anyone, and to every reader beside each person who has not answered.
 *
 * A new project does not show this card until it has someone on it, unless the founder opens "Set up more" on the
 * page (`ProjectSetUp.tsx`); the founder's "Add a person" button is on it from then on.
 *
 * What someone just did shows at once (the server can take seconds to show a record back) and gives way to what is
 * read back; a send that fails says so beside the button that sent it, and that button is the retry.
 */

import { useId, useState } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { PersonSearch } from "@/features/social/ui/PersonSearch";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { EmptyState } from "@/shared/ui/empty-state";
import { FailureNote } from "@/shared/ui/failure-note";

import {
  actsForProject,
  MAX_TEAM_MEMBERS,
  type MemberState,
  TEAM_ROLE_WORDS,
} from "../lib/team";
import { POST_UPDATE } from "../lib/first-week";
import type { Launch } from "../models";
import {
  useAnswerInvitation,
  useProjectTeam,
  useTeamChanges,
} from "../use-team";
import {
  LOST_CHANGE_WORDS,
  type LostChange,
  useRecordAgreement,
} from "../use-record-agreement";
import { AccountAgentBadge } from "./AccountAgentBadge";
import { CopyInviteLink, ProjectJoinRequests } from "./JoinRequests";
import { MODAL_FOOTER_CLASS, Modal } from "./Modal";

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** Said wherever someone is added: what the server does, exactly. */
const ACTS_AT_ONCE = "They can act for this project as soon as you add them.";

const STATE_WORDS: Record<Exclude<MemberState, "accepted">, string> = {
  invited:
    "Has not said yes yet. The server already lets them act for this project.",
  declined:
    "Said no. The server still lets them act for this project until the founder removes them.",
  left: "Left the team. The server still lets them act for this project until the founder removes them.",
};

export function ProjectTeamCard({
  launch,
  isFounder,
}: {
  launch: Launch;
  isFounder: boolean;
}) {
  const me = existingUserPubkey();
  const { record } = launch;
  const team = useProjectTeam(launch);
  const changes = useTeamChanges(launch);
  const answer = useAnswerInvitation();
  const headingId = useId();
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    pubkey: string;
    did: "add" | "remove";
    /** What the send failed with, or why a saved change did not last. */
    cause: unknown;
    lost?: LostChange;
  } | null>(null);
  // The viewer's own answer, shown until the answers read back hold it, and where they stood when they gave it.
  const [said, setSaid] = useState<"yes" | "no" | null>(null);
  const [saidAs, setSaidAs] = useState<MemberState | null>(null);
  const [answerFailure, setAnswerFailure] = useState<FailureWords | null>(null);

  const onRecord = new Set(record.team.map((m) => m.pubkey));
  // What the founder just did shows at once, and only until the record read back says the same. If a newer record
  // arrives without it (another save replaced it), or none arrives, the row goes back to what the record says and
  // the page says why.
  const mineToShow = useRecordAgreement(
    record.createdAt,
    (key) => {
      const [did, pubkey] = key.split(":");
      return did === "add" ? onRecord.has(pubkey) : !onRecord.has(pubkey);
    },
    (key, why) => {
      const [did, pubkey] = key.split(":");
      setFailure({
        pubkey,
        did: did === "add" ? "add" : "remove",
        cause: null,
        lost: why,
      });
    },
  );
  const justAdded = mineToShow.waiting
    .filter((key) => key.startsWith("add:"))
    .map((key) => key.slice(4));
  const justRemoved = mineToShow.waiting
    .filter((key) => key.startsWith("remove:"))
    .map((key) => key.slice(7));

  const rows: Array<{ pubkey: string; state: MemberState; saving: boolean }> = [
    ...team.view.members
      .filter((m) => !justRemoved.includes(m.pubkey))
      .map((m) => ({ pubkey: m.pubkey, state: m.state, saving: false })),
    ...justAdded
      .filter((p) => !onRecord.has(p))
      .map((pubkey) => ({
        pubkey,
        state: "invited" as const,
        saving: true,
      })),
  ];
  const former = team.view.former;
  const names = useUserNames([
    record.author,
    ...rows.map((r) => r.pubkey),
    ...former.map((f) => f.pubkey),
    ...(failure ? [failure.pubkey] : []),
  ]);

  const mine = team.view.members.find((m) => m.pubkey === me);
  const myState: MemberState | null = mine
    ? said === "yes" && mine.state === "invited"
      ? "accepted"
      : said === "no"
        ? // Saying no after a yes is leaving; saying no to the invitation is declining it.
          saidAs === "accepted" || mine.state === "left"
          ? "left"
          : "declined"
        : mine.state
    : null;
  const stateOf = (row: { pubkey: string; state: MemberState }) =>
    row.pubkey === me && myState ? myState : row.state;

  // Nothing to show a visitor when the founder works alone and nobody ever left.
  if (!isFounder && rows.length === 0 && former.length === 0) return null;

  const add = async (pubkey: string) => {
    setFailure(null);
    setAdding(false);
    mineToShow.drop(`remove:${pubkey}`);
    mineToShow.begin(`add:${pubkey}`);
    try {
      const done = await changes.add.mutateAsync(pubkey);
      mineToShow.saved(`add:${pubkey}`, done.signedAt);
    } catch (cause) {
      mineToShow.drop(`add:${pubkey}`);
      setFailure({ pubkey, did: "add", cause });
    }
  };
  const remove = async (pubkey: string) => {
    setFailure(null);
    setConfirmRemove(null);
    mineToShow.drop(`add:${pubkey}`);
    mineToShow.begin(`remove:${pubkey}`);
    try {
      const done = await changes.remove.mutateAsync(pubkey);
      mineToShow.saved(`remove:${pubkey}`, done.signedAt);
    } catch (cause) {
      mineToShow.drop(`remove:${pubkey}`);
      setFailure({ pubkey, did: "remove", cause });
    }
  };
  const say = async (word: "yes" | "no") => {
    if (!mine || answer.isPending) return;
    setAnswerFailure(null);
    setSaidAs(mine.state);
    setSaid(word);
    try {
      await answer.mutateAsync({
        project: record,
        invite: mine.invite,
        answer: word,
      });
    } catch (cause) {
      setSaid(null);
      setAnswerFailure(
        failureWords(cause, "Your answer was not saved. Try again."),
      );
    }
  };

  const accepted = rows.filter((r) => stateOf(r) === "accepted");
  const waiting = rows.filter((r) => stateOf(r) !== "accepted");
  const busy = changes.add.isPending || changes.remove.isPending;
  const full = record.team.length >= MAX_TEAM_MEMBERS;
  /** The founder, with nobody added and nobody who left: the card is one line and one button. */
  const onlyYou =
    isFounder && team.ready && rows.length === 0 && former.length === 0;

  /** They said yes at some point (and may have left since): only then does removing them leave a line on the page. */
  const wasOnTeam = (pubkey: string) => {
    const state = rows.find((r) => r.pubkey === pubkey)?.state;
    return state === "accepted" || state === "left";
  };
  const removeControls = (pubkey: string) =>
    !isFounder ? null : confirmRemove === pubkey ? (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-xs">
          Remove {names(pubkey)}? They will no longer be able to act for this
          project.{" "}
          {wasOnTeam(pubkey)
            ? "The page will say they were on the team until today."
            : "They never said yes, so nothing will say they were on the team."}
        </span>
        <Button
          data-testid="team-remove-confirm"
          onClick={() => void remove(pubkey)}
          size="sm"
          type="button"
          variant="destructive"
        >
          Remove
        </Button>
        <Button
          onClick={() => setConfirmRemove(null)}
          size="sm"
          type="button"
          variant="outline"
        >
          Keep
        </Button>
      </span>
    ) : (
      <Button
        aria-label={`Remove ${names(pubkey)} from the team`}
        data-testid="team-remove"
        disabled={busy}
        onClick={() => setConfirmRemove(pubkey)}
        size="sm"
        type="button"
        variant="outline"
      >
        Remove
      </Button>
    );

  return (
    <section
      aria-labelledby={headingId}
      className="glass rounded-2xl border p-4"
      data-testid="project-team"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold" id={headingId}>
          Team
        </h2>
        {isFounder && !onlyYou ? (
          <Button
            data-testid="team-add"
            disabled={busy || full}
            onClick={() => setAdding(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Add a person
          </Button>
        ) : null}
      </div>
      {isFounder ? (
        <div className="mt-2">
          <CopyInviteLink project={record} />
        </div>
      ) : null}
      {isFounder ? <ProjectJoinRequests record={record} /> : null}
      {isFounder && full ? (
        <p className="mt-1 text-xs text-muted-foreground">
          A team can have {MAX_TEAM_MEMBERS} people besides the founder.
        </p>
      ) : null}

      {myState === "invited" ||
      ((myState === "declined" || myState === "left") && said === null) ? (
        <div
          className="mt-3 rounded-lg border border-primary/60 bg-primary/5 p-3 text-sm"
          data-testid="team-invitation"
        >
          {myState === "invited" ? (
            <>
              <p>
                {names(record.author)} added you to this project's team. Team
                members can post updates and check handed-in work. The server
                already lets you act for this project; say yes to be shown as
                team, or no.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  data-testid="team-join"
                  disabled={answer.isPending}
                  onClick={() => void say("yes")}
                  size="sm"
                  type="button"
                >
                  Join the team
                </Button>
                <Button
                  data-testid="team-decline"
                  disabled={answer.isPending}
                  onClick={() => void say("no")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  No
                </Button>
              </div>
            </>
          ) : (
            <p>
              {myState === "left"
                ? "You left this project's team."
                : "You said no to this project's team."}{" "}
              The server still lets you act for it until the founder removes
              you.
            </p>
          )}
        </div>
      ) : null}
      {said !== null && mine ? (
        <p className="mt-2 text-sm" data-testid="team-answered" role="status">
          {said === "yes"
            ? "You joined the team."
            : myState === "left"
              ? "You left the team. The founder is shown that and can remove you."
              : "You said no. The founder is shown your answer and can remove you."}
        </p>
      ) : null}
      {answerFailure ? (
        <FailureNote
          className="mt-2"
          failure={answerFailure}
          testId="team-answer-failed"
        />
      ) : null}

      <ul
        className="mt-3 flex flex-col gap-2 text-sm"
        data-testid="team-members"
      >
        <li className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold">{names(record.author)}</span>
          <span className="text-xs text-muted-foreground">Founder</span>
        </li>
        {team.ready
          ? accepted.map((row) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2"
                data-testid="team-member"
                key={row.pubkey}
              >
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold">{names(row.pubkey)}</span>
                  <AccountAgentBadge pubkey={row.pubkey} />
                  <span className="text-xs text-muted-foreground">
                    {TEAM_ROLE_WORDS}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {row.pubkey === me && said !== "no" ? (
                    <Button
                      data-testid="team-leave"
                      disabled={answer.isPending}
                      onClick={() => void say("no")}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Leave the team
                    </Button>
                  ) : null}
                  {removeControls(row.pubkey)}
                </span>
              </li>
            ))
          : null}
      </ul>

      {onlyYou ? (
        <EmptyState
          action={
            <Button
              data-testid="team-add"
              disabled={busy || full}
              onClick={() => setAdding(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              Add a person
            </Button>
          }
          className="mt-3"
          line="You can run the project on your own. Add a person when you want a second pair of eyes."
          testId="team-alone"
          title="It is just you for now, and that is fine."
        />
      ) : null}

      {team.failed ? (
        <p className="mt-2 text-sm" data-testid="team-read-failed" role="alert">
          Couldn't read who said yes, so nobody is shown as having joined.{" "}
          <Button
            onClick={team.retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : !team.ready ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          Reading who said yes…
        </p>
      ) : null}

      {team.ready && waiting.length > 0 ? (
        <div className="mt-3">
          <h3 className="text-xs font-bold text-muted-foreground">
            Added by the founder
          </h3>
          <ul
            className="mt-1 flex flex-col gap-2 text-sm"
            data-testid="team-invited"
          >
            {waiting.map((row) => {
              const state = stateOf(row);
              return (
                <li
                  className="flex flex-wrap items-center justify-between gap-2"
                  data-state={state}
                  data-testid="team-invited-member"
                  key={row.pubkey}
                >
                  <span>
                    <span className="font-semibold">{names(row.pubkey)}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      {row.saving
                        ? "Added. Waiting for the server to show it."
                        : STATE_WORDS[state === "accepted" ? "invited" : state]}
                    </span>
                  </span>
                  {row.saving ? null : removeControls(row.pubkey)}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {team.cut ? (
        <p className="mt-2 text-xs" data-testid="team-cut" role="status">
          Not every answer could be read, so someone shown as not having said
          yes may have.
        </p>
      ) : null}

      {former.length > 0 ? (
        <ul
          className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground"
          data-testid="team-former"
        >
          {former.map((f) => (
            <li key={f.pubkey}>
              {names(f.pubkey)} was on the team until {day(f.until)}.
            </li>
          ))}
        </ul>
      ) : null}

      {failure ? (
        <FailureNote
          className="mt-2"
          failure={
            failure.lost
              ? {
                  text: `${
                    failure.did === "add"
                      ? `${names(failure.pubkey)} is not on the team.`
                      : `${names(failure.pubkey)} is still on the team.`
                  } ${LOST_CHANGE_WORDS[failure.lost]}`,
                  detail: null,
                }
              : failureWords(
                  failure.cause,
                  failure.did === "add"
                    ? `${names(failure.pubkey)} was not added: the change was not saved. Try again.`
                    : `${names(failure.pubkey)} is still on the team: the change was not saved. Try again.`,
                )
          }
          testId="team-failed"
        />
      ) : null}

      {adding && me ? (
        <AddPersonDialog
          alone={onlyYou}
          me={me}
          onAdd={(pubkey) => void add(pubkey)}
          onClose={() => setAdding(false)}
          taken={[record.author, ...record.team.map((m) => m.pubkey)]}
        />
      ) : null}
    </section>
  );
}

/** "Post this week's update" for a team member who said yes: the founder's own button is on the page already. */
export function TeamPostUpdate({
  launch,
  onOpen,
}: {
  launch: Launch;
  onOpen: () => void;
}) {
  const me = existingUserPubkey();
  const team = useProjectTeam(launch);
  if (!team.ready || !actsForProject(team.view, launch.record.author, me))
    return null;
  return (
    <Button data-testid="team-post-update" onClick={onOpen} variant="outline">
      {POST_UPDATE}
    </Button>
  );
}

function AddPersonDialog({
  me,
  taken,
  alone,
  onAdd,
  onClose,
}: {
  me: string;
  /** The founder has nobody else on the project: their own work is checked by them until someone joins. */
  alone: boolean;
  taken: readonly string[];
  onAdd: (pubkey: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const aboutId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const names = useUserNames(picked ? [picked] : []);
  const already = picked !== null && taken.includes(picked);
  return (
    <Modal
      describedBy={aboutId}
      label="Add a person to the team"
      labelledBy={titleId}
      onClose={onClose}
    >
      <h2 className="text-base font-bold" id={titleId}>
        Add a person to the team
      </h2>
      <div className="mt-2 flex flex-col gap-2 text-sm" id={aboutId}>
        <p data-testid="team-add-warning">
          <strong>{ACTS_AT_ONCE}</strong> They can post updates and check work.
          Goals and promises stay yours.
        </p>
        {alone ? (
          <p data-testid="team-add-alone">
            Once someone else is on the project, they check work instead of you.
          </p>
        ) : null}
      </div>
      <div className="mt-3">
        {picked === null ? (
          <PersonSearch
            inputId="team-add-search"
            inputTestId="team-add-search"
            label="Find a person by name, or paste their account"
            me={me}
            onPick={setPicked}
          />
        ) : (
          <p className="text-sm" data-testid="team-add-picked" role="status">
            {already
              ? `${names(picked)} is already on the team.`
              : `Add ${names(picked)} to the team?`}{" "}
            <Button
              className="h-auto p-0"
              onClick={() => setPicked(null)}
              size="sm"
              type="button"
              variant="link"
            >
              Choose someone else
            </Button>
          </p>
        )}
      </div>
      <div className={`mt-4 flex justify-end gap-2 ${MODAL_FOOTER_CLASS}`}>
        <Button onClick={onClose} type="button" variant="outline">
          Cancel
        </Button>
        <Button
          data-testid="team-add-confirm"
          disabled={picked === null || already}
          onClick={() => picked && onAdd(picked)}
          type="button"
        >
          Add to the team
        </Button>
      </div>
    </Modal>
  );
}
