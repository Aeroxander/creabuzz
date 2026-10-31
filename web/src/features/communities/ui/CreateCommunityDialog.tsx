/**
 * Start a community of your own: pick a name, get an address, and land in it as its owner.
 *
 * The community is empty on arrival and opens on its own prompt to start a project, so this dialog does not ask for
 * anything else. The server has the last word on a name (taken, or kept for the service itself) and says so in words.
 */

import { Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Modal } from "@/features/launchpad/ui/Modal";
import { needAccountTo } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import { setStoredRelayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { FailureNote } from "@/shared/ui/failure-note";
import { Input } from "@/shared/ui/input";

import { ACCESS_CHOICES, type Access } from "../lib/access";
import {
  finishName,
  nameProblem,
  previewHost,
  tidyName,
} from "../lib/community-name";
import { createCommunity, type SelfServeStatus } from "../use-self-serve";

export function CreateCommunityDialog({
  status,
  onClose,
}: {
  status: SelfServeStatus;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  // Open unless the owner asks for invite-only: a place for supporters is public, and a team's private rooms are
  // rooms inside it. Either is one press, and the owner can change it later.
  const [access, setAccess] = useState<Access>("open");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureWords | null>(null);
  const signedIn = existingUserPubkey() !== null;

  const name = finishName(typed);
  const problem = typed === "" ? null : nameProblem(name, status.limits);
  const canSubmit = signedIn && !busy && name !== "" && problem === null;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createCommunity(name, access);
      // Point this browser at the new community, then open it. A full load, like joining one, so nothing from the
      // community this browser was in carries over.
      setStoredRelayWsUrl(created.url);
      toast.success("Your community is ready.");
      window.location.assign(`/c/${encodeURIComponent(created.host)}`);
    } catch (cause) {
      setError(
        failureWords(
          cause,
          "Your community was not created. Try again in a moment.",
        ),
      );
      setBusy(false);
    }
  };

  return (
    <Modal label="Create a community" onClose={onClose}>
      <h2 className="text-lg font-bold">Create a community</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        A place for your team, your supporters and your work. You will own it,
        and you can start a project in it straight away.
      </p>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label className="text-sm font-medium" htmlFor="community-name">
            What is it called?
          </label>
          <Input
            autoFocus
            className="mt-1"
            data-testid="community-name"
            id="community-name"
            maxLength={status.limits.max + 8}
            onChange={(event) => {
              setTyped(tidyName(event.target.value));
              setError(null);
            }}
            placeholder="e.g. my-film"
            value={typed}
          />
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-testid="community-address"
          >
            {name === ""
              ? `Its address will be your name followed by ${status.domain}, like ${previewHost("my-film", status.domain ?? "")}.`
              : `Its address will be ${previewHost(name, status.domain ?? "")}`}
          </p>
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Who can join?</legend>
          <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {ACCESS_CHOICES.map((choice) => (
              <label
                className="group relative flex cursor-pointer flex-col gap-0.5 rounded-lg border border-black/10 p-3 pr-8 has-[:checked]:border-black/60 has-[:checked]:bg-black/[0.03] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring dark:border-white/10 dark:has-[:checked]:border-white/60 dark:has-[:checked]:bg-white/[0.06]"
                key={choice.value}
              >
                <input
                  checked={access === choice.value}
                  className="sr-only"
                  data-testid={`community-access-${choice.value}`}
                  name="new-community-access"
                  onChange={() => setAccess(choice.value)}
                  type="radio"
                  value={choice.value}
                />
                <Check
                  aria-hidden
                  className="absolute right-2.5 top-2.5 hidden h-4 w-4 group-has-[:checked]:block"
                />
                <span className="text-sm font-medium">{choice.title}</span>
                <span className="text-xs text-muted-foreground">
                  {choice.detail}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {problem ? (
          <p
            className="text-sm text-red-600 dark:text-red-400"
            data-testid="community-name-problem"
            role="alert"
          >
            {problem}
          </p>
        ) : null}
        {!signedIn ? (
          <p className="text-sm" data-testid="community-needs-account">
            {needAccountTo("create a community")}
          </p>
        ) : null}
        {error ? (
          <FailureNote failure={error} testId="community-create-error" />
        ) : null}
        <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
          {/* Why the button is not ready yet, beside it, until a name is typed. */}
          {signedIn && name === "" ? (
            <p
              className="mr-auto text-xs text-muted-foreground"
              data-testid="community-create-why"
              id="community-create-why"
            >
              Give it a name first.
            </p>
          ) : null}
          <Button onClick={onClose} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            aria-describedby={
              signedIn && name === "" ? "community-create-why" : undefined
            }
            data-testid="community-create-submit"
            disabled={!canSubmit}
            size="sm"
            type="submit"
          >
            {busy ? "Creating…" : "Create community"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
