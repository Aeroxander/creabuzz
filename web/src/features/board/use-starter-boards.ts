/**
 * Create the starter boards: each board's creation and its first post, sent as
 * the reader on one connection, board by board. A failure stops there and says
 * so; the boards already made stay, and asking again makes only the missing ones.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { openUserPublisher } from "@/shared/lib/publish-as-user";
import { failureWords } from "@/shared/lib/readable-error";

import { missingStarterBoards, starterDrafts } from "./lib/starter-boards";

export type StarterState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "error"; message: string };

export function useStarterBoards(existingNames: readonly string[]) {
  const client = useQueryClient();
  const [state, setState] = useState<StarterState>({ phase: "idle" });

  const create = useCallback(async () => {
    const missing = missingStarterBoards(existingNames);
    setState({ phase: "working" });
    const publisher = openUserPublisher();
    try {
      for (const board of missing) {
        const { create: made, seed } = starterDrafts(
          board,
          crypto.randomUUID(),
        );
        await publisher.publish(
          made,
          `The server didn't create the ${board.name} board. Try again.`,
        );
        await publisher.publish(
          seed,
          `The ${board.name} board was created, but its first post wasn't accepted.`,
        );
      }
      setState({ phase: "idle" });
    } catch (error) {
      setState({
        phase: "error",
        message: failureWords(error, "Couldn't set up the boards. Try again.")
          .text,
      });
    } finally {
      publisher.close();
      await client.invalidateQueries({ queryKey: ["channels"] });
    }
  }, [existingNames, client]);

  return { state, create };
}
