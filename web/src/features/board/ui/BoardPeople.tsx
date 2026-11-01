/**
 * Who can read a private board or chat room, a way to add someone, and, for its owners and admins, a way to take someone
 * off it (they are told at once if they have it open).
 *
 * Shown only where it is private: an open board or room is for everyone in the
 * community. Anyone who can read it sees who else can. The form to add a
 * person is offered to everyone and the server decides, because its owner or
 * an admin is the only one it lets add people; its reason is shown. People can
 * be picked from those who have spoken in the community or named by pasting the
 * link to their profile, or the key they were given. The server applies the same
 * rule to boards and rooms, so this works the same for both.
 */

import { needAccountTo } from "@/features/identity/lib/account-copy";
import { useState } from "react";

import { useMentionCandidates } from "@/features/fleet/use-mention-candidates";
import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { failureWords } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Input } from "@/shared/ui/input";

import { canRemoveMember } from "../lib/members";
import { parsePersonOrLink } from "../lib/person-link";
import { useBoardMembers } from "../use-board-members";
import { AuthorChip } from "./AuthorChip";

export function BoardPeople({
  boardId,
  suggestFromChannelId,
  place = "board",
}: {
  /** The board's or room's id. */
  boardId: string;
  /** A channel whose speakers are offered as people to add. */
  suggestFromChannelId: string | null;
  /** What to call it, and the prefix of its test ids. */
  place?: "board" | "room";
}) {
  const { members, add, remove } = useBoardMembers(boardId, true);
  const [removing, setRemoving] = useState<string | null>(null);
  const me = existingUserPubkey();
  const profiles = useProfiles(members.map((m) => m.pubkey)).data;
  const candidates = useMentionCandidates(suggestFromChannelId);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const have = new Set(members.map((m) => m.pubkey));
  // Only people with a name: a short key tells the reader nothing about who they would be adding.
  const suggestions = candidates.filter(
    (c) => !c.agent && !c.me && !have.has(c.pubkey) && c.named === true,
  );

  const addPerson = async (pubkey: string) => {
    if (me === null) {
      setProblem(needAccountTo("add people"));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await add(pubkey);
      setText("");
    } catch (error) {
      setProblem(failureWords(error, "Couldn't add them. Try again.").text);
    } finally {
      setBusy(false);
    }
  };

  const removePerson = async (pubkey: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await remove(pubkey);
    } catch (error) {
      setProblem(failureWords(error, "Couldn't remove them. Try again.").text);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const pubkey = parsePersonOrLink(text);
    if (pubkey === null) {
      setProblem(
        "That isn't a profile link. Open their profile, copy the link from the address bar, and paste it here.",
      );
      return;
    }
    if (have.has(pubkey)) {
      setProblem(`They can already read this ${place}.`);
      return;
    }
    void addPerson(pubkey);
  };

  return (
    <section
      aria-label={`People who can read this ${place}`}
      className="border-b px-4 py-3"
      data-testid={`${place}-people`}
    >
      <p className="text-xs text-muted-foreground">
        Only the people below can read this {place}.
      </p>
      <ul
        className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"
        data-testid={`${place}-members`}
      >
        {members.map((member) => (
          <li className="flex items-center gap-1" key={member.pubkey}>
            <AuthorChip
              profile={profiles?.[member.pubkey]}
              pubkey={member.pubkey}
            />
            {member.role !== "member" ? (
              <span className="text-muted-foreground">({member.role})</span>
            ) : null}
            {canRemoveMember(members, me, member.pubkey) ? (
              <button
                aria-label={`Remove ${resolveUserName(profiles?.[member.pubkey], member.pubkey)} from this ${place}`}
                className="underline disabled:opacity-50"
                data-testid={`${place}-remove-person`}
                disabled={busy}
                onClick={() => setRemoving(member.pubkey)}
                type="button"
              >
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="sr-only" htmlFor={`${place}-add-person`}>
          Add someone by their profile link
        </label>
        <Input
          className="h-8 max-w-xs text-xs"
          id={`${place}-add-person`}
          onChange={(event) => setText(event.target.value)}
          placeholder="Add someone: paste their profile link"
          value={text}
        />
        <Button
          data-testid={`${place}-add-person`}
          disabled={busy || text.trim() === ""}
          size="sm"
          type="submit"
        >
          {busy ? "Adding…" : "Add"}
        </Button>
      </form>
      {suggestions.length > 0 ? (
        <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          People in this community:
          {suggestions.slice(0, 8).map((person) => (
            <button
              className="rounded-full border px-2 py-0.5 hover:bg-secondary"
              data-testid={`${place}-suggest-person`}
              disabled={busy}
              key={person.pubkey}
              onClick={() => void addPerson(person.pubkey)}
              type="button"
            >
              Add {person.name}
            </button>
          ))}
        </p>
      ) : null}
      {problem ? (
        <p
          className="mt-2 text-xs text-destructive"
          data-testid={`${place}-people-problem`}
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <ConfirmDialog
        confirmLabel="Remove"
        description={`They will no longer be able to read this ${place}. If they have it open, they are told at once.`}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const pubkey = removing;
          setRemoving(null);
          if (pubkey !== null) void removePerson(pubkey);
        }}
        open={removing !== null}
        title={`Remove ${removing ? resolveUserName(profiles?.[removing], removing) : ""} from this ${place}?`}
      />
    </section>
  );
}
