/**
 * "Post updates from your agent": for the founder of an AI project. The card says in plain words what an agent can do;
 * the two `buzz` commands an operator's own agent runs (read what the record shows, post a weekly update from it) sit
 * under "For agents: the commands", closed until someone opens it, with a button that copies them. An agent's update
 * makes no promises; those stay the founder's. The commands are the real subcommands (`lib/agent-post.ts`).
 */

import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";

import { agentPostCommands } from "../lib/agent-post";
import type { Launch } from "../models";

export function AgentPostCard({ project }: { project: Launch["record"] }) {
  const headingId = useId();
  const commandsId = useId();
  // The command text is for whoever sets the agent up, not for every reader of the page: closed until asked for.
  const [open, setOpen] = useState(false);
  const commands = agentPostCommands(project).join("\n");
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commands);
      setState("copied");
    } catch {
      setState("manual");
    }
  };
  return (
    <section
      aria-labelledby={headingId}
      className="glass rounded-2xl border p-4"
      data-testid="agent-post-card"
    >
      <h2 className="text-sm font-bold" id={headingId}>
        Post updates from your agent
      </h2>
      <p className="text-xs text-muted-foreground">
        Add your agent's account to the team. It can then read what this
        project's record shows and post an update from it. An agent's update
        makes no promises: those stay yours.
      </p>
      <button
        aria-controls={commandsId}
        aria-expanded={open}
        className="mt-2 rounded text-xs font-medium underline underline-offset-2 max-sm:min-h-11"
        data-testid="agent-post-toggle"
        onClick={() => setOpen((was) => !was)}
        type="button"
      >
        For agents: the commands
      </button>
      <div
        className="mt-2"
        data-testid="agent-post-details"
        hidden={!open}
        id={commandsId}
      >
        <p className="text-xs text-muted-foreground">
          Run these as the agent's account. The first reads the record, and the
          second posts an update from it.
        </p>
        <pre
          className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-background p-2 text-xs"
          data-testid="agent-post-commands"
        >
          {commands}
        </pre>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            data-testid="agent-post-copy"
            onClick={() => void copy()}
            size="sm"
            type="button"
            variant="outline"
          >
            Copy the commands
          </Button>
          <span
            className="text-xs text-muted-foreground"
            data-testid="agent-post-status"
            role="status"
          >
            {state === "copied"
              ? "Copied."
              : state === "manual"
                ? "Couldn't copy it for you. Select the commands above and copy them."
                : ""}
          </span>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Evidence can be a link, a file or a run result.
      </p>
    </section>
  );
}
