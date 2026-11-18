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
import { toast } from "sonner";

import { droppedLinksNotice } from "../lib/project-boards";
import { useMyProjects, useTieBoards } from "../use-project-boards";
import { ProjectChoice } from "./ProjectChoice";

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
  const myProjects = useMyProjects();
  const tie = useTieBoards();
  const [projectId, setProjectId] = useState("");
  // A board made but not yet added to its project: asking again adds it, and does not make another.
  const [madeId, setMadeId] = useState<string | null>(null);
  const project = myProjects.find((launch) => launch.record.id === projectId);
  const [tying, setTying] = useState(false);
  const busy = create.isPending || tying;

  const submit = async () => {
    if (name.trim().replace(/^#+/, "") === "") {
      setProblem({ text: "Give the board a name.", detail: null });
      return;
    }
    setProblem(null);
    setTying(true);
    let made = madeId;
    try {
      if (made === null) {
        const result = await create.mutateAsync({
          name: name.trim(),
          topic: about.trim() || undefined,
          visibility: "open",
          channelType: "forum",
          members: [],
        });
        made = result.channelId;
        setMadeId(made);
        void queryClient.invalidateQueries({ queryKey: ["my-boards"] });
      }
      if (project) {
        const dropped = await tie(project, [made]);
        const notice = droppedLinksNotice(project.record.name, dropped);
        if (notice) toast.message(notice);
      }
      onStarted(made);
    } catch (error) {
      // The server's reason in plain words (`you can start 5 boards a day`); its internal failures and a dropped
      // connection as what did not happen, with its own words under Technical details.
      const words = failureWords(
        error,
        made === null ? "The board wasn't started. Try again." : "Try again.",
      );
      setProblem(
        made === null
          ? words
          : {
              ...words,
              text: `The board was started, but it wasn't added to ${project?.record.name ?? "the project"}. ${words.text}`,
            },
      );
    } finally {
      setTying(false);
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
      <ProjectChoice
        disabled={madeId !== null}
        id="start-board-project"
        onChange={setProjectId}
        projects={myProjects}
        value={projectId}
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
          disabled={busy}
          size="sm"
          type="submit"
        >
          {busy
            ? "Starting…"
            : madeId !== null
              ? "Add it to the project"
              : "Start the board"}
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
    </form>
  );
}
