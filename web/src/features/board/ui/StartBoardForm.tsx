/**
 * Start a board from Home. Anyone in the community can: the board is open (anyone here reads and posts on it) and the
 * person who starts it runs it, so they can remove posts. The server allows a few new boards per person a day; when it
 * says no, the reason is shown in plain words and the draft is kept.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useCreateChannel } from "@/features/channels/use-create-channel";
import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { TechnicalDetails } from "@/shared/ui/technical-details";

export function StartBoardForm({
  onCancel,
  onStarted,
}: {
  onCancel: () => void;
  onStarted: (boardId: string) => void;
}) {
  const create = useCreateChannel();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [problem, setProblem] = useState<FailureWords | null>(null);

  const submit = async () => {
    if (name.trim().replace(/^#+/, "") === "") {
      setProblem({ text: "Give the board a name.", detail: null });
      return;
    }
    setProblem(null);
    try {
      const result = await create.mutateAsync({
        name: name.trim(),
        topic: about.trim() || undefined,
        visibility: "open",
        channelType: "forum",
        members: [],
      });
      void queryClient.invalidateQueries({ queryKey: ["my-boards"] });
      onStarted(result.channelId);
    } catch (error) {
      // The server's reason in plain words (`you can start 5 boards a day`); its internal failures and a dropped
      // connection as what did not happen, with its own words under Technical details.
      setProblem(failureWords(error, "The board wasn't started. Try again."));
    }
  };

  return (
    <form
      aria-labelledby="start-board-title"
      className="flex flex-col gap-2 rounded-xl border p-3"
      data-testid="start-board-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="text-sm font-semibold" id="start-board-title">
        Start a board
      </h2>
      <label className="sr-only" htmlFor="start-board-name">
        Board name
      </label>
      <Input
        autoComplete="off"
        autoFocus
        id="start-board-name"
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name, for example Indie games"
        value={name}
      />
      <label className="sr-only" htmlFor="start-board-about">
        What it is for (optional)
      </label>
      <Input
        autoComplete="off"
        id="start-board-about"
        maxLength={200}
        onChange={(event) => setAbout(event.target.value)}
        placeholder="What it is for (optional)"
        value={about}
      />
      <p className="text-xs text-muted-foreground">
        Anyone here can read it and post on it. You run it, so you can remove
        posts that don't belong.
      </p>
      {problem ? (
        <>
          <p
            className="text-xs text-destructive"
            data-testid="start-board-problem"
            role="alert"
          >
            {problem.text}
          </p>
          <TechnicalDetails
            detail={problem.detail}
            testId="start-board-problem-details"
          />
        </>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-testid="start-board-submit"
          disabled={create.isPending}
          size="sm"
          type="submit"
        >
          {create.isPending ? "Starting…" : "Start the board"}
        </Button>
        <Button
          disabled={create.isPending}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
