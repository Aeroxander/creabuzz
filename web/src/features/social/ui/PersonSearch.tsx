/**
 * Find a person to message: the people you follow first, then everyone on this server whose name matches, or the
 * person whose public key was pasted. Picking one hands their key to `onPick`. Shared by Messages on Home and the
 * community's notices and messages, so both find people the same way.
 */

import { type RefObject, useState } from "react";

import {
  resolveUserName,
  resolveUserSecondaryName,
} from "@/features/profiles/use-profiles";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { parsePersonOrLink } from "@/features/board/lib/person-link";

import { parseEntity } from "../lib/entity";
import { useUserSearch } from "../use-discovery";
import { usePeople } from "../use-people";
import { useFollowing } from "../use-social-data";

const SHOWN = 8;

export function PersonSearch({
  me,
  onPick,
  inputId,
  inputTestId,
  inputRef,
  label = "Send a message to",
  disabled = false,
}: {
  me: string;
  onPick: (pubkey: string) => void;
  inputId: string;
  inputTestId: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  label?: string;
  /** While a pick is being acted on: the list stays, but nothing more can be picked. */
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const following = useFollowing(me).data ?? [];
  const q = query.trim();
  // A pasted key or profile link finds that person too, without the box asking for one.
  const entity = parseEntity(q);
  const directKey =
    entity?.type === "pubkey" ? entity.pubkey : parsePersonOrLink(q);
  const found = useUserSearch(q);
  const followedPeople = usePeople(following.slice(0, 100));

  const matches = [
    ...(directKey ? [directKey] : []),
    ...Object.entries(followedPeople)
      .filter(([, p]) =>
        q === ""
          ? true
          : [p.name, p.display_name].some((n) =>
              n?.toLowerCase().includes(q.toLowerCase()),
            ),
      )
      .map(([pubkey]) => pubkey),
    ...Object.keys(found.data ?? {}),
  ].filter((pk, i, all) => pk !== me && all.indexOf(pk) === i);
  const people = usePeople(matches);
  const searched = q !== "" && !q.startsWith("#") && !found.isFetching;

  return (
    <div>
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      <input
        className="h-10 w-full rounded-full bg-black/5 px-4 text-sm text-black outline-none placeholder:text-black/50 focus:ring-1 focus:ring-primary dark:bg-white/10 dark:text-white dark:placeholder:text-white/50"
        data-testid={inputTestId}
        id={inputId}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name"
        ref={inputRef}
        value={query}
      />
      {found.isError ? (
        <p
          className="mt-2 px-2 text-xs text-red-700 dark:text-red-300"
          role="alert"
        >
          Couldn't search just now. Try again, or paste their profile link.
        </p>
      ) : searched && matches.length === 0 ? (
        <p
          className="mt-2 px-2 text-xs text-black/60 dark:text-white/60"
          role="status"
        >
          No one by that name here. Check the spelling, or paste their profile
          link.
        </p>
      ) : null}
      <ul className="mt-2 max-h-72 overflow-y-auto">
        {matches.slice(0, SHOWN).map((pubkey) => (
          <li key={pubkey}>
            <button
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/10"
              data-testid="person-search-result"
              disabled={disabled}
              onClick={() => onPick(pubkey)}
              type="button"
            >
              <UserAvatar
                avatarUrl={people[pubkey]?.picture ?? null}
                displayName={resolveUserName(people[pubkey], pubkey)}
              />
              <span className="min-w-0 text-sm leading-5">
                <span className="block truncate font-bold text-black dark:text-white">
                  {resolveUserName(people[pubkey], pubkey)}
                </span>
                <span className="block truncate text-black/60 dark:text-white/60">
                  {resolveUserSecondaryName(people[pubkey], pubkey)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
