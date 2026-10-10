/**
 * Who can read a private board, and a way to add someone.
 *
 * Shown only on a private board: an open board is for everyone in the
 * community. Anyone who can read the board sees who else can. The form to add a
 * person is offered to everyone and the server decides, because a board's
 * owner or an admin is the only one it lets add people; its reason is shown.
 * People can be picked from those who have spoken in the community or named by
 * pasting the public key or `npub…` address they were given.
 */

import { useState } from "react";

import { useMentionCandidates } from "@/features/fleet/use-mention-candidates";
import { useProfiles } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { parsePersonInput } from "../lib/members";
import { useBoardMembers } from "../use-board-members";
import { AuthorChip } from "./AuthorChip";

export function BoardPeople({
  boardId,
  suggestFromChannelId,
}: {
  boardId: string;
  /** A channel whose speakers are offered as people to add. */
  suggestFromChannelId: string | null;
}) {
  const { members, add } = useBoardMembers(boardId, true);
  const me = existingUserPubkey();
  const profiles = useProfiles(members.map((m) => m.pubkey)).data;
  const candidates = useMentionCandidates(suggestFromChannelId);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const have = new Set(members.map((m) => m.pubkey));
  const suggestions = candidates.filter(
    (c) => !c.agent && !c.me && !have.has(c.pubkey),
  );

  const addPerson = async (pubkey: string) => {
    if (me === null) {
      setProblem("Create your account (top right) to add people.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await add(pubkey);
      setText("");
    } catch (error) {
      setProblem(
        error instanceof Error && error.message
          ? error.message
          : "Couldn't add them. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const pubkey = parsePersonInput(text);
    if (pubkey === null) {
      setProblem(
        "That doesn't look like a public key. Paste the one that starts with npub or is 64 letters and numbers long.",
      );
      return;
    }
    if (have.has(pubkey)) {
      setProblem("They can already read this board.");
      return;
    }
    void addPerson(pubkey);
  };

  return (
    <section
      aria-label="People who can read this board"
      className="border-b px-4 py-3"
      data-testid="board-people"
    >
      <p className="text-xs text-muted-foreground">
        Only the people below can read this board.
      </p>
      <ul
        className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"
        data-testid="board-members"
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
        <label className="sr-only" htmlFor="board-add-person">
          Add someone by their public key
        </label>
        <Input
          className="h-8 max-w-xs text-xs"
          id="board-add-person"
          onChange={(event) => setText(event.target.value)}
          placeholder="Add someone: paste their public key (npub…)"
          value={text}
        />
        <Button
          data-testid="board-add-person"
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
              data-testid="board-suggest-person"
              disabled={busy}
              key={person.pubkey}
              onClick={() => void addPerson(person.pubkey)}
              title={truncatePubkey(person.pubkey)}
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
          data-testid="board-people-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </section>
  );
}
