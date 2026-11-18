/**
 * The work this person just accepted on a project, kept for the rest of this visit so the record can offer its share
 * picture. A task that is confirmed leaves the open list at once (the list holds open tasks only), so the offer cannot
 * live on the task's row: the row's send puts the task's id and words here, and the record, which stays, reads them.
 *
 * Nothing is written to the server and nothing outlives the page: the entry is cleared by "Not now" and is gone on a
 * reload. The key carries the server's address, so another community never reads it.
 */

import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { relayWsUrl } from "@/shared/lib/relay-url";

import { launchCoordinate, type Launch } from "./models";

export interface JustAccepted {
  id: string;
  /** The task's own words: the title of the picture. */
  what: string;
}

type Project = Pick<Launch["record"], "author" | "id">;

const key = (project: Project) =>
  [
    "launchpad",
    "just-accepted",
    relayWsUrl(),
    launchCoordinate(project.author, project.id),
  ] as const;

/** Remember that `task` was just accepted on `project`. */
export function markJustAccepted(
  queryClient: QueryClient,
  project: Project,
  task: { id: string; what: string },
) {
  const entry: JustAccepted = { id: task.id, what: task.what };
  queryClient.setQueryData(key(project), entry);
}

/** The work just accepted on this project in this visit, and a way to put the offer away. */
export function useJustAccepted(project: Project): {
  accepted: JustAccepted | null;
  dismiss: () => void;
} {
  const queryClient = useQueryClient();
  // Never fetched: the entry is only ever set by `markJustAccepted`.
  const read = useQuery<JustAccepted | null>({
    queryKey: key(project),
    queryFn: () => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  return {
    accepted: read.data ?? null,
    dismiss: () => queryClient.setQueryData(key(project), null),
  };
}
