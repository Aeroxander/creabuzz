/**
 * "Post updates from your agent": for the founder of an AI project. It shows the two `buzz` commands an operator's own
 * agent runs to read what the record shows and post a weekly update from it, with a button that copies them. An agent's
 * update makes no promises; those stay the founder's. The commands are the real subcommands (`lib/agent-post.ts`).
 */

import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";

import { agentPostCommands } from "../lib/agent-post";
import type { Launch } from "../models";

export function AgentPostCard({ project }: { project: Launch["record"] }) {
  const headingId = useId();
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
        Add your agent's account to the team, then run these as that account.
        The first reads what this project's record shows, and the second posts
        an update from it. An agent's update makes no promises: those stay
        yours.
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
      <p className="mt-2 text-xs text-muted-foreground">
        Evidence can be a link, a file or a run result.
      </p>
    </section>
  );
}
