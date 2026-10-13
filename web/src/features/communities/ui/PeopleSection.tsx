/**
 * People and access: who is in this community, who may join, and invite links.
 *
 * Everyone sees who is in. Owners and admins make invite links; only the owner decides whether people need one. What
 * is offered follows the person's role, and the server refuses anyone it should regardless, with a reason that is shown
 * as it is said.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { useUserNames } from "@/features/profiles/use-profiles";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { existingUserPubkey } from "@/shared/lib/identity";

import {
  ACCESS_CHOICES,
  type Access,
  type ActiveInvite,
  CLOSING_WARNING,
  INVITE_LIFETIMES,
  INVITE_USES,
  type MintedInvite,
  type Person,
  accessSummary,
  describeActiveInvite,
  describeInvite,
  mayChangeAccess,
  mayInvite,
  mayRemove,
  roleOfferedFor,
} from "../lib/access";
import {
  changeRole,
  mintInvite,
  removePerson,
  revokeInvite,
  setCommunityAccess,
  useCommunityAccess,
  useCommunityPeople,
  useInvites,
} from "../use-access";

const OPENING_WARNING =
  "Anyone with the address will be able to read what is here and join.";

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** The owner's choice of who may join, with a plain warning before either change. */
function AccessControl({ current }: { current: Access }) {
  const client = useQueryClient();
  const [pending, setPending] = useState<Access | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (next: Access) => {
    setBusy(true);
    setError(null);
    try {
      await setCommunityAccess(next);
      await client.invalidateQueries({ queryKey: ["community-access"] });
      setPending(null);
      toast.success(
        next === "invite_only"
          ? "Only people you invite can join now."
          : "Anyone with the address can join now.",
      );
    } catch (cause) {
      setError(errorText(cause, "That did not go through."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="space-y-2" data-testid="access-control">
      <legend className="text-sm font-medium">Who can join?</legend>
      {ACCESS_CHOICES.map((choice) => (
        <label
          className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-black/10 p-2.5 has-[:checked]:border-black/40 dark:border-white/10 dark:has-[:checked]:border-white/40"
          key={choice.value}
        >
          <input
            checked={(pending ?? current) === choice.value}
            className="mt-1"
            data-testid={`access-${choice.value}`}
            disabled={busy}
            name="community-access"
            onChange={() => {
              setError(null);
              setPending(choice.value === current ? null : choice.value);
            }}
            type="radio"
            value={choice.value}
          />
          <span>
            <span className="block text-sm font-medium">{choice.title}</span>
            <span className="block text-xs text-muted-foreground">
              {choice.detail}
            </span>
          </span>
        </label>
      ))}
      {pending ? (
        <div
          className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
          data-testid="access-confirm"
        >
          <p className="text-sm">
            {pending === "invite_only" ? CLOSING_WARNING : OPENING_WARNING}
          </p>
          <div className="flex gap-2">
            <Button
              data-testid="access-confirm-yes"
              disabled={busy}
              onClick={() => void apply(pending)}
              size="sm"
              type="button"
            >
              {busy
                ? "Saving…"
                : pending === "invite_only"
                  ? "Make it invite-only"
                  : "Open it to anyone"}
            </Button>
            <Button
              disabled={busy}
              onClick={() => setPending(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p
          className="text-sm text-red-600 dark:text-red-400"
          data-testid="access-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Make a link to share. The link is shown once, with what it allows. */
function InviteMaker({ onMade }: { onMade: () => void }) {
  const [lifetime, setLifetime] = useState("week");
  const [uses, setUses] = useState("one");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<MintedInvite | null>(null);

  const make = async () => {
    const secs = INVITE_LIFETIMES.find((l) => l.id === lifetime)?.secs;
    const limit = INVITE_USES.find((u) => u.id === uses);
    if (secs === undefined || limit === undefined) return;
    setBusy(true);
    setError(null);
    try {
      setMade(await mintInvite(secs, limit.uses));
      onMade();
    } catch (cause) {
      setMade(null);
      setError(errorText(cause, "Could not make an invite."));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.url);
      toast.success("Link copied.");
    } catch {
      toast.error("Could not copy. Select the link and copy it by hand.");
    }
  };

  return (
    <div className="space-y-2" data-testid="invite-maker">
      <h3 className="text-sm font-medium">Invite people</h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted-foreground">
          Lasts
          <select
            className="mt-1 block rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
            data-testid="invite-lifetime"
            onChange={(event) => setLifetime(event.target.value)}
            value={lifetime}
          >
            {INVITE_LIFETIMES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Who can use it
          <select
            className="mt-1 block rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
            data-testid="invite-uses"
            onChange={(event) => setUses(event.target.value)}
            value={uses}
          >
            {INVITE_USES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          data-testid="invite-make"
          disabled={busy}
          onClick={() => void make()}
          size="sm"
          type="button"
        >
          {busy ? "Making…" : "Make invite link"}
        </Button>
      </div>
      {error ? (
        <p
          className="text-sm text-red-600 dark:text-red-400"
          data-testid="invite-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {made ? (
        <div className="space-y-1.5" data-testid="invite-made">
          <div className="flex gap-2">
            <input
              aria-label="Invite link"
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
              data-testid="invite-link"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={made.url}
            />
            <Button
              data-testid="invite-copy"
              onClick={() => void copy()}
              size="sm"
              type="button"
              variant="outline"
            >
              Copy
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" role="status">
            {describeInvite(made, Math.floor(Date.now() / 1000))}
          </p>
        </div>
      ) : null}
    </div>
  );
}

const ROLE_WORDS = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
} as const;

/** The invites that can still be used, with a way to end each. A link made earlier cannot be shown again. */
function ActiveInvites({
  invites,
  nameOf,
  onChanged,
}: {
  invites: ActiveInvite[];
  nameOf: (pubkey: string) => string;
  onChanged: () => void;
}) {
  const [ending, setEnding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Math.floor(Date.now() / 1000);

  const end = async (id: string) => {
    setEnding(id);
    setError(null);
    try {
      await revokeInvite(id);
      toast.success("That invite no longer works.");
      onChanged();
    } catch (cause) {
      setError(errorText(cause, "Could not end that invite."));
    } finally {
      setEnding(null);
    }
  };

  if (invites.length === 0) return null;
  return (
    <div className="space-y-1.5" data-testid="active-invites">
      <h3 className="text-sm font-medium">
        Invites that still work ({invites.length})
      </h3>
      <ul className="space-y-1.5">
        {invites.map((invite) => (
          <li
            className="flex items-center gap-2 rounded-lg border border-black/10 p-2 dark:border-white/10"
            data-testid="active-invite"
            key={invite.id}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">
                Made by {nameOf(invite.madeBy)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {describeActiveInvite(invite, now)}
              </span>
            </span>
            <Button
              data-testid="invite-end"
              disabled={ending !== null}
              onClick={() => void end(invite.id)}
              size="sm"
              type="button"
              variant="outline"
            >
              {ending === invite.id ? "Ending…" : "End invite"}
            </Button>
          </li>
        ))}
      </ul>
      {error ? (
        <p
          className="text-sm text-red-600 dark:text-red-400"
          data-testid="invite-end-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** One person in the list, with Remove when this person may and the community is invite-only. */
function PersonRow({
  person,
  name,
  canRemove,
  offerRole,
  onRemoved,
  onRoleChanged,
}: {
  person: Person;
  name: string;
  canRemove: boolean;
  /** The role the viewer may give this person, when any. */
  offerRole: "admin" | "member" | null;
  onRemoved: () => void;
  onRoleChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const giveRole = async (role: "admin" | "member") => {
    setBusy(true);
    setError(null);
    try {
      await changeRole(person.pubkey, role);
      toast.success(
        role === "admin"
          ? `${name} is an admin now.`
          : `${name} is a member now.`,
      );
      onRoleChanged();
    } catch (cause) {
      setError(errorText(cause, "Could not change their role."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await removePerson(person.pubkey);
      toast.success(`${name} was removed.`);
      onRemoved();
    } catch (cause) {
      setError(errorText(cause, "Could not remove them."));
      setBusy(false);
    }
  };

  return (
    <li
      className="rounded-lg border border-black/10 p-2 dark:border-white/10"
      data-role={person.role}
      data-testid="person"
    >
      <div className="flex items-center gap-2">
        <UserAvatar avatarUrl={null} displayName={name} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm" title={person.pubkey}>
          {name}
        </span>
        <Badge className="px-1.5 py-0 text-2xs" variant="outline">
          {ROLE_WORDS[person.role]}
        </Badge>
        {offerRole && !confirming ? (
          <Button
            data-testid="person-role"
            disabled={busy}
            onClick={() => void giveRole(offerRole)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {offerRole === "admin" ? "Make admin" : "Make member"}
          </Button>
        ) : null}
        {canRemove && !confirming ? (
          <Button
            data-testid="person-remove"
            onClick={() => setConfirming(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Remove
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <div className="mt-2 space-y-2" data-testid="person-confirm">
          <p className="text-xs">
            {name} will be signed out right away and will need a new invite to
            come back.
          </p>
          <div className="flex gap-2">
            <Button
              data-testid="person-remove-yes"
              disabled={busy}
              onClick={() => void remove()}
              size="sm"
              type="button"
            >
              {busy ? "Removing…" : `Remove ${name}`}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p
          className="mt-1 text-sm text-red-600 dark:text-red-400"
          data-testid="person-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function PeopleSection() {
  const client = useQueryClient();
  const access = useCommunityAccess();
  const { people, myRole, isLoading } = useCommunityPeople();
  const keys = useMemo(() => {
    return people.map((person) => person.pubkey);
  }, [people]);
  const invites = useInvites(mayInvite(myRole));
  const nameOf = useUserNames(
    useMemo(
      () => [...keys, ...(invites.data ?? []).map((invite) => invite.madeBy)],
      [keys, invites.data],
    ),
  );
  const known = access.data ?? null;
  const me = existingUserPubkey();
  // Removing someone matters where membership is required; in an open community the list does not gate anything.
  const removalOffered = known === "invite_only";

  const refreshPeople = () =>
    void client.invalidateQueries({ queryKey: ["community-people"] });
  const refreshInvites = () =>
    void client.invalidateQueries({ queryKey: ["community-invites"] });

  return (
    <section
      className="space-y-4 border-t border-black/10 p-3 dark:border-white/10"
      data-testid="org-people-section"
    >
      <div>
        <h2 className="text-sm font-semibold text-black dark:text-white">
          People and access
        </h2>
        {known && !mayChangeAccess(myRole) ? (
          <p
            className="mt-0.5 text-xs text-muted-foreground"
            data-testid="access-summary"
          >
            {accessSummary(known)}
          </p>
        ) : null}
      </div>

      {known && mayChangeAccess(myRole) ? (
        <AccessControl current={known} />
      ) : null}
      {mayInvite(myRole) ? <InviteMaker onMade={refreshInvites} /> : null}
      {mayInvite(myRole) ? (
        <ActiveInvites
          invites={invites.data ?? []}
          nameOf={nameOf}
          onChanged={refreshInvites}
        />
      ) : null}

      <div className="space-y-1.5">
        <h3 className="text-sm font-medium">
          In this community{people.length > 0 ? ` (${people.length})` : ""}
        </h3>
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : people.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            The list of people is not available here.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {people.map((person) => (
              <PersonRow
                canRemove={removalOffered && mayRemove(myRole, me, person)}
                key={person.pubkey}
                name={nameOf(person.pubkey)}
                offerRole={roleOfferedFor(myRole, me, person)}
                onRemoved={refreshPeople}
                onRoleChanged={refreshPeople}
                person={person}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
