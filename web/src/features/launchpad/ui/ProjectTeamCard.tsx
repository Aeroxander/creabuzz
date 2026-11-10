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
 * What someone just did shows at once (the server can take seconds to show a record back) and gives way to what is
 * read back; a send that fails says so beside the button that sent it, and that button is the retry.
 */

import { useEffect, useId, useState } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { PersonSearch } from "@/features/social/ui/PersonSearch";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { FailureNote } from "@/shared/ui/failure-note";

import {
  actsForProject,
  MAX_TEAM_MEMBERS,
  type MemberState,
  TEAM_ROLE_WORDS,
} from "../lib/team";
import type { Launch } from "../models";
import {
  useAnswerInvitation,
  useProjectTeam,
  useTeamChanges,
} from "../use-team";
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
  // What the founder just did, shown until the record read back says the same.
  const [justAdded, setJustAdded] = useState<string[]>([]);
  const [justRemoved, setJustRemoved] = useState<string[]>([]);
  const [failure, setFailure] = useState<{
    pubkey: string;
    did: "add" | "remove";
    cause: unknown;
  } | null>(null);
  // The viewer's own answer, shown until the answers read back hold it.
  const [said, setSaid] = useState<"yes" | "no" | null>(null);
  const [answerFailure, setAnswerFailure] = useState<FailureWords | null>(null);

  const onRecord = new Set(record.team.map((m) => m.pubkey));
  useEffect(() => {
    const names = new Set(record.team.map((m) => m.pubkey));
    setJustAdded((was) => {
      const left = was.filter((p) => !names.has(p));
      return left.length === was.length ? was : left;
    });
    setJustRemoved((was) => {
      const left = was.filter((p) => names.has(p));
      return left.length === was.length ? was : left;
    });
  }, [record.team]);

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
        ? "declined"
        : mine.state
    : null;
  const stateOf = (row: { pubkey: string; state: MemberState }) =>
    row.pubkey === me && myState ? myState : row.state;

  // Nothing to show a visitor when the founder works alone and nobody ever left.
  if (!isFounder && rows.length === 0 && former.length === 0) return null;

  const add = async (pubkey: string) => {
    setFailure(null);
    setAdding(false);
    setJustAdded((was) => [...was.filter((p) => p !== pubkey), pubkey]);
    try {
      await changes.add.mutateAsync(pubkey);
    } catch (cause) {
      setJustAdded((was) => was.filter((p) => p !== pubkey));
      setFailure({ pubkey, did: "add", cause });
    }
  };
  const remove = async (pubkey: string) => {
    setFailure(null);
    setConfirmRemove(null);
    setJustRemoved((was) => [...was.filter((p) => p !== pubkey), pubkey]);
    try {
      await changes.remove.mutateAsync(pubkey);
    } catch (cause) {
      setJustRemoved((was) => was.filter((p) => p !== pubkey));
      setFailure({ pubkey, did: "remove", cause });
    }
  };
  const say = async (word: "yes" | "no") => {
    if (!mine || answer.isPending) return;
    setAnswerFailure(null);
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

  const removeControls = (pubkey: string) =>
    !isFounder ? null : confirmRemove === pubkey ? (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-xs">
          Remove {names(pubkey)}? They will no longer be able to act for this
          project, and the page will say they were on the team until today.
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
        {isFounder ? (
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
      {isFounder && full ? (
        <p className="mt-1 text-xs text-muted-foreground">
          A team can have {MAX_TEAM_MEMBERS} people besides the founder.
        </p>
      ) : null}

      {myState === "invited" || (myState === "declined" && said === null) ? (
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
              You said no to this project's team. The server still lets you act
              for it until the founder removes you.
            </p>
          )}
        </div>
      ) : null}
      {said !== null && mine ? (
        <p className="mt-2 text-sm" data-testid="team-answered" role="status">
          {said === "yes"
            ? "You joined the team."
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
                        : STATE_WORDS[
                            state === "declined" ? "declined" : "invited"
                          ]}
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
              {names(f.pubkey)} was on the team
              {f.until === null ? "." : ` until ${day(f.until)}.`}
            </li>
          ))}
        </ul>
      ) : null}

      {failure ? (
        <FailureNote
          className="mt-2"
          failure={failureWords(
            failure.cause,
            failure.did === "add"
              ? `${names(failure.pubkey)} was not added: the change was not saved. Try again.`
              : `${names(failure.pubkey)} is still on the team: the change was not saved. Try again.`,
          )}
          testId="team-failed"
        />
      ) : null}

      {adding && me ? (
        <AddPersonDialog
          me={me}
          onAdd={(pubkey) => void add(pubkey)}
          onClose={() => setAdding(false)}
          taken={[record.author, ...record.team.map((m) => m.pubkey)]}
        />
      ) : null}
    </section>
  );
}

/** "Post update" for a team member who said yes: the founder's own button is on the page already. */
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
      Post update
    </Button>
  );
}

function AddPersonDialog({
  me,
  taken,
  onAdd,
  onClose,
}: {
  me: string;
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
          <strong>{ACTS_AT_ONCE}</strong> A team member{" "}
          {TEAM_ROLE_WORDS.toLowerCase()}: they can post weekly updates, make
          and check tasks, and reply to offers of help.
        </p>
        <p>
          They are asked to say yes, and are shown as team once they do. Until
          then the page says they have not said yes yet. Goals and promises stay
          yours alone.
        </p>
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
