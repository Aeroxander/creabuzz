/**
 * Banning from the People list: the form that asks how long and why, the list of who is banned with a way to lift
 * each ban, and the list of who moderators have muted everywhere with a way to end each mute early. What is offered follows the person's role (an owner or admin), and the server refuses anyone it should
 * regardless, with a reason that is shown as it is said.
 */

import { useState } from "react";
import { toast } from "sonner";

import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { FailureNote } from "@/shared/ui/failure-note";

import {
  BAN_LENGTHS,
  type Ban,
  describeBan,
  describeTimeout,
  type Timeout,
} from "../lib/bans";
import { banPerson, endTimeout, liftBan } from "../use-bans";

/** Ask how long and why, say plainly what a ban does, and send it. */
export function BanForm({
  name,
  pubkey,
  onDone,
  onCancel,
}: {
  name: string;
  pubkey: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  // No length is chosen at first: a default of "For good" banned people forever when a moderator only typed a reason.
  const [length, setLength] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureWords | null>(null);

  const ban = async () => {
    if (length === null) return;
    setBusy(true);
    setError(null);
    try {
      await banPerson(pubkey, BAN_LENGTHS[length].secs, reason);
      toast.success(`${name} was banned.`);
      onDone();
    } catch (cause) {
      setError(
        failureWords(
          cause,
          "The server did not ban them. Try again, or ask the community's owner.",
        ),
      );
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 space-y-2" data-testid="ban-form">
      <p className="text-xs">
        {name} will be signed out right away and cannot get back in, even with
        an invite link, until the ban ends or you lift it. Only moderators see
        the reason you give.
      </p>
      <label className="flex items-center gap-2 text-xs">
        How long
        <select
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          data-testid="ban-length"
          onChange={(event) => setLength(Number(event.target.value))}
          value={length ?? ""}
        >
          <option disabled value="">
            Choose
          </option>
          {BAN_LENGTHS.map((choice, index) => (
            <option key={choice.label} value={index}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <input
        aria-label="Reason, seen only by moderators"
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
        data-testid="ban-reason"
        maxLength={200}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (only moderators see it)"
        value={reason}
      />
      <div className="flex gap-2">
        <Button
          data-testid="ban-yes"
          disabled={busy || length === null}
          onClick={() => void ban()}
          size="sm"
          type="button"
        >
          {busy ? "Banning…" : `Ban ${name}`}
        </Button>
        <Button
          disabled={busy}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
      {error ? <FailureNote failure={error} testId="ban-error" /> : null}
    </div>
  );
}

/** One current ban, with its reason and a way to lift it. */
function BannedRow({
  ban,
  name,
  by,
  onLifted,
}: {
  ban: Ban;
  name: string;
  by: string;
  onLifted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureWords | null>(null);

  const lift = async () => {
    setBusy(true);
    setError(null);
    try {
      await liftBan(ban.pubkey);
      toast.success(`${name} can use the community again.`);
      onLifted();
    } catch (cause) {
      setError(
        failureWords(
          cause,
          "The server did not lift the ban, so it is still in place. Try again, or ask the community's owner.",
        ),
      );
      setBusy(false);
    }
  };

  return (
    <li
      className="rounded-lg border border-black/10 p-2 dark:border-white/10"
      data-testid="banned-person"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm" title={ban.pubkey}>
          {name}
        </span>
        <Button
          data-testid="ban-lift"
          disabled={busy}
          onClick={() => void lift()}
          size="sm"
          type="button"
          variant="ghost"
        >
          {busy ? "Lifting…" : "Lift ban"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {describeBan(ban, Math.floor(Date.now() / 1000))}
        {ban.by ? ` · by ${by}` : ""}
        {ban.reason ? ` · “${ban.reason}”` : ""}
      </p>
      {error ? (
        <FailureNote className="mt-1" failure={error} testId="ban-lift-error" />
      ) : null}
    </li>
  );
}

/** Who is banned right now. Not shown at all while nobody is. */
export function BannedList({
  bans,
  nameOf,
  onChanged,
}: {
  bans: readonly Ban[];
  nameOf: (pubkey: string) => string;
  onChanged: () => void;
}) {
  if (bans.length === 0) return null;
  return (
    <div className="space-y-1.5" data-testid="banned-list">
      <h3 className="text-sm font-medium">Banned ({bans.length})</h3>
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {bans.map((ban) => (
          <BannedRow
            ban={ban}
            by={nameOf(ban.by)}
            key={ban.pubkey}
            name={nameOf(ban.pubkey)}
            onLifted={onChanged}
          />
        ))}
      </ul>
    </div>
  );
}

/** One current community-wide mute, with its reason and a way to end it early. */
function MutedRow({
  timeout,
  name,
  by,
  banned,
  onEnded,
}: {
  timeout: Timeout;
  name: string;
  by: string;
  /** They are banned as well: ending the mute does not let them post. */
  banned: boolean;
  onEnded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureWords | null>(null);

  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      await endTimeout(timeout.pubkey);
      toast.success(
        banned
          ? `${name}'s mute has ended. They are still banned.`
          : `${name} can post again.`,
      );
      onEnded();
    } catch (cause) {
      const words = failureWords(
        cause,
        "The server did not end the mute, so it is still in place. Try again, or ask the community's owner.",
      );
      // It ran out, or someone else ended it, since the list was read: say so and read the list again.
      if (/not timed out/i.test(words.detail ?? words.text)) {
        toast.success(`${name}'s mute had already ended.`);
        onEnded();
        return;
      }
      setError(words);
    } finally {
      // Ready again if the row is still listed (the list could not be read again, or the server refused).
      setBusy(false);
    }
  };

  return (
    <li
      className="rounded-lg border border-black/10 p-2 dark:border-white/10"
      data-testid="muted-person"
    >
      <div className="flex items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate text-sm"
          title={timeout.pubkey}
        >
          {name}
        </span>
        <Button
          aria-label={`End the mute on ${name}`}
          data-testid="mute-end"
          disabled={busy}
          onClick={() => void end()}
          size="sm"
          type="button"
          variant="ghost"
        >
          {busy ? "Ending…" : "End mute"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {describeTimeout(timeout, Math.floor(Date.now() / 1000))}
        {/* The server keeps one name per person for a ban and a mute together: for someone also banned, it may be who banned them. */}
        {timeout.by ? ` · ${banned ? "last changed" : "muted"} by ${by}` : ""}
        {timeout.reason ? ` · “${timeout.reason}”` : ""}
      </p>
      {error ? (
        <FailureNote className="mt-1" failure={error} testId="mute-end-error" />
      ) : null}
    </li>
  );
}

/**
 * Who moderators have muted everywhere in the community right now: they can read but not post until the mute ends. Not
 * shown at all while nobody is.
 */
export function MutedList({
  timeouts,
  banned,
  nameOf,
  onChanged,
}: {
  timeouts: readonly Timeout[];
  /** Who is banned as well, by key. */
  banned: ReadonlySet<string>;
  nameOf: (pubkey: string) => string;
  onChanged: () => void;
}) {
  if (timeouts.length === 0) return null;
  return (
    <div className="space-y-1.5" data-testid="muted-list">
      <h3 className="text-sm font-medium">
        Muted by moderators ({timeouts.length})
      </h3>
      <p className="text-xs text-muted-foreground">
        They can read, but not post anywhere here, until the mute ends.
      </p>
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {timeouts.map((timeout) => (
          <MutedRow
            banned={banned.has(timeout.pubkey)}
            by={nameOf(timeout.by)}
            key={timeout.pubkey}
            name={nameOf(timeout.pubkey)}
            onEnded={onChanged}
            timeout={timeout}
          />
        ))}
      </ul>
    </div>
  );
}
