/**
 * Under the reviewers box: who the founder has named, by name where an account is linked to one, how many must agree,
 * and what to do when nobody can be picked by name. A reviewer is chosen once, and changing the panel later takes a
 * vote, so the founder sees who each address is before the project is made, not after.
 */

import { useMemo } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { usePeopleWithWallets } from "@/features/launchpad/use-people";
import { Button } from "@/shared/ui/button";

import {
  everyReviewerMustAgree,
  reviewerList,
  quorumSentence,
  reviewQuorum,
} from "../lib/contributor-project";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const short = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

export function ReviewersPicked({
  reviewers,
  quorum,
  me,
  onEitherDecides,
}: {
  /** The reviewers box, as typed or picked. */
  reviewers: string;
  /** The "how many must agree" box. */
  quorum: string;
  /** The founder, who is never offered as a reviewer. */
  me: string | null;
  /** Set "how many must agree" to 1. */
  onEitherDecides: () => void;
}) {
  const people = usePeopleWithWallets();
  const named = useMemo(
    () => reviewerList(reviewers).filter((entry) => ADDRESS.test(entry)),
    [reviewers],
  );
  const linked = useMemo(() => {
    const byAddress = new Map<string, string>();
    for (const person of people.data ?? [])
      byAddress.set(person.address.toLowerCase(), person.pubkey);
    return byAddress;
  }, [people.data]);
  const keys = useMemo(
    () =>
      named
        .map((address) => linked.get(address.toLowerCase()))
        .filter((key): key is string => key !== undefined),
    [named, linked],
  );
  const nameOf = useUserNames(keys);
  const others = (people.data ?? []).filter((person) => person.pubkey !== me);
  const mustAgree = reviewQuorum(named.length, quorum);
  const everyone = everyReviewerMustAgree(named.length, quorum);

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="contributor-reviewers-picked"
    >
      {people.isError ? (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="contributor-people-unread"
          role="alert"
        >
          <span>
            Names could not be read just now, so reviewers cannot be picked by
            name.
          </span>
          <Button
            data-testid="contributor-people-retry"
            onClick={() => void people.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : people.isSuccess && others.length === 0 ? (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          data-testid="contributor-people-none"
        >
          <span>
            Nobody here has linked an account to their name yet. Ask each
            reviewer to press &ldquo;Show your name with this account&rdquo;,
            then try again.
          </span>
          <Button
            data-testid="contributor-people-retry"
            onClick={() => void people.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : null}
      {named.length > 0 ? (
        <ul
          className="flex flex-col gap-1 text-xs"
          aria-label="Reviewers named"
        >
          {named.map((address) => {
            const key = linked.get(address.toLowerCase());
            return (
              <li
                className="flex flex-wrap items-center gap-x-1.5"
                data-linked={key ? "yes" : "no"}
                data-testid="contributor-reviewer-picked"
                key={address.toLowerCase()}
              >
                {key ? (
                  <span className="font-medium">{nameOf(key)}</span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-300">
                    Not linked to anyone here
                  </span>
                )}
                <span className="font-mono text-muted-foreground">
                  {short(address)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {named.length > 0 && Number.isInteger(mustAgree) && mustAgree >= 1 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="contributor-quorum-said"
        >
          {quorumSentence(named.length, mustAgree)}
        </p>
      ) : null}
      {everyone ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="contributor-quorum-all"
        >
          <span>
            If they split, or one doesn&apos;t answer, that piece of work stays
            stuck until its deadline passes. Name another reviewer, or let any
            one of them decide: then the first answer decides, a turn-down as
            much as an approval.
          </span>
          <Button
            data-testid="contributor-quorum-one"
            onClick={onEitherDecides}
            size="sm"
            type="button"
            variant="outline"
          >
            Let any one decide
          </Button>
        </div>
      ) : null}
    </div>
  );
}
