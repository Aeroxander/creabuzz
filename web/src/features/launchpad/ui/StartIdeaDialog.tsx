/**
 * Start an idea: a name, one sentence and (optionally) a cover. No token, no
 * split, no price. It publishes a public launch page and creates the team and
 * supporters rooms, then lands the founder on the page they just made.
 */

import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { ideaId, ideaIssue, ideaToInput, IDEA_PITCH_MAX } from "../lib/idea";
import { LAUNCH_CATEGORIES, type LaunchChat } from "../models";
import { EMPTY_CHAT, ensureRooms } from "../use-launch-chat";
import { useCreateLaunch, useLaunches } from "../use-launches";
import { CoverImageField } from "./create-wizard/CoverImageField";
import { LaunchCardPreview } from "./create-wizard/LaunchCardPreview";
import { Modal } from "./Modal";

export function StartIdeaDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateLaunch();
  const { data: launches } = useLaunches();
  const [name, setName] = useState("");
  const [pitch, setPitch] = useState("");
  const [image, setImage] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A retry after a failed publish reuses the rooms already made.
  const rooms = useRef<LaunchChat>(EMPTY_CHAT);
  const id = useRef<string | null>(null);

  const submit = async () => {
    if (busy) return;
    const issue = ideaIssue({ name, pitch });
    if (issue) {
      setError(issue);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = existingUserPubkey();
      const mine = (launches ?? [])
        .filter((launch) => launch.record.author === me)
        .map((launch) => launch.record.id);
      id.current ??= ideaId(name, mine);
      const ensured = await ensureRooms({
        launchName: name,
        chat: rooms.current,
        team: [],
        sale: false,
      });
      rooms.current = ensured.chat;
      const event = await create.mutateAsync(
        ideaToInput({
          id: id.current,
          name,
          pitch,
          image,
          category,
          chat: ensured.chat,
        }),
      );
      toast.success(
        ensured.incomplete
          ? "Your idea is live. Some chat rooms can be added from its page."
          : "Your idea is live.",
      );
      onClose();
      void navigate({
        to: "/launchpad/$launchId",
        params: { launchId: id.current },
        search: { author: event.pubkey, action: undefined },
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "That did not go through. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal label="Start an idea" onClose={onClose} wide>
      <h2 className="text-lg font-bold">Start an idea</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Nothing to commit to yet. Put it out there and see who is in.
      </p>
      <div className="mt-4 flex flex-col gap-3">
        <div>
          <label className="text-sm font-medium" htmlFor="idea-name">
            What is it called?
          </label>
          <Input
            autoFocus
            className="mt-1"
            data-testid="idea-name"
            id="idea-name"
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nebula"
            value={name}
          />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="idea-pitch">
            Say it in one sentence
          </label>
          <Input
            className="mt-1"
            data-testid="idea-pitch"
            id="idea-pitch"
            maxLength={IDEA_PITCH_MAX}
            onChange={(event) => setPitch(event.target.value)}
            placeholder="An open-source tool that maps the night sky for everyone."
            value={pitch}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <CoverImageField onChange={setImage} value={image} />
          <div>
            <label className="text-sm font-medium" htmlFor="idea-category">
              Category
            </label>
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              data-testid="idea-category"
              id="idea-category"
              onChange={(event) => setCategory(event.target.value)}
              value={category}
            >
              <option value="">Choose…</option>
              {LAUNCH_CATEGORIES.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          </div>
        </div>
        <LaunchCardPreview
          category={category}
          image={image}
          name={name}
          pitch={pitch}
        />
        <SignRecovery
          message={error}
          onUnlocked={() => void submit()}
          showHeadline
          testId="idea-sign-recovery"
        />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose} type="button" variant="ghost">
          Cancel
        </Button>
        <Button
          data-testid="idea-create"
          disabled={busy}
          onClick={() => void submit()}
          type="button"
        >
          {busy ? "Creating…" : "Put it out there"}
        </Button>
      </div>
    </Modal>
  );
}
