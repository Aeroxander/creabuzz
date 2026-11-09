/**
 * Boards that belong to a project: reading which they are, naming a board in a project's record, and making a
 * project's supporters and founders boards.
 *
 * The tie is the project's record (see `lib/project-boards.ts`), so only the person who published the project can
 * name boards in it. Reading is for everyone.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { useChannels } from "@/features/channels/use-channels";
import { recordToInput } from "@/features/launchpad/lib/record-input";
import {
  launchesQueryKey,
  useCreateLaunch,
  useLaunches,
} from "@/features/launchpad/use-launches";
import type { Launch } from "@/features/launchpad/models";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { openUserPublisher } from "@/shared/lib/publish-as-user";
import { failureWords } from "@/shared/lib/readable-error";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  type BoardProject,
  boardProject,
  boardsOfProject,
  tieBoards,
} from "./lib/project-boards";
import {
  createProjectStarterBoards,
  type StarterMemoStore,
} from "./lib/project-starter";
import { starterDrafts } from "./lib/starter-boards";

const KIND_CHANNEL_METADATA = 39000;

/** Every project on this server, with the channels its record names. Empty while they load or when they cannot be read. */
export function useBoardProjects(): {
  projects: BoardProject[];
  isLoading: boolean;
  failed: boolean;
} {
  const launches = useLaunches();
  const projects = useMemo(
    () => (launches.data ?? []).map((launch) => boardProject(launch.record)),
    [launches.data],
  );
  return {
    projects,
    isLoading: launches.isLoading,
    failed: launches.isError,
  };
}

/** The projects the signed-in person published: the ones they can add boards to. */
export function useMyProjects(): Launch[] {
  const launches = useLaunches();
  const me = existingUserPubkey();
  return useMemo(
    () =>
      me === null
        ? []
        : (launches.data ?? []).filter((launch) => launch.record.author === me),
    [launches.data, me],
  );
}

/** One project's boards, as the server lists them. */
export function useProjectBoardsOf(launch: Launch) {
  const { channels, isLoading, error, refetch } = useChannels();
  const project = useMemo(() => boardProject(launch.record), [launch.record]);
  const boards = useMemo(
    () =>
      boardsOfProject(
        project,
        channels.filter((channel) => channel.type === "forum"),
      ),
    [project, channels],
  );
  return {
    boards,
    loading: isLoading,
    error,
    retry: () => void refetch(),
  };
}

/** The browser's storage, or one that keeps nothing when it is refused (a private window). */
function memoStore(): StarterMemoStore {
  try {
    return localStorage;
  } catch {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
}

async function boardExists(id: string): Promise<boolean> {
  const records = await queryEvents(relayWsUrl(), {
    kinds: [KIND_CHANNEL_METADATA],
    "#d": [id],
    limit: 1,
  });
  return records.length > 0;
}

/**
 * Name boards in a project's record: `save` is the record's save, `boardIds` the boards the project already names.
 * Resolves with how many channels the founder had picked that no longer fit.
 */
function useNameBoards() {
  const save = useCreateLaunch();
  const { channels } = useChannels();
  const forums = useMemo(
    () =>
      new Set(
        channels
          .filter((channel) => channel.type === "forum")
          .map((channel) => channel.id.toLowerCase()),
      ),
    [channels],
  );
  return useCallback(
    async (launch: Launch, ids: readonly string[]): Promise<number> => {
      const { channels: named, dropped } = tieBoards(
        launch.record,
        ids.map((id) => id.toLowerCase()),
        forums,
      );
      await save.mutateAsync(recordToInput(launch.record, { channels: named }));
      return dropped;
    },
    [save, forums],
  );
}

/** Put boards that exist under a project. Throws with the server's reason when the record is refused. */
export function useTieBoards() {
  return useNameBoards();
}

export type StarterState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "error"; message: string };

/**
 * Make the project's supporters and founders boards inside it. `boardNames` are the project's boards by name; only the
 * missing ones are made. `create` resolves with how many of the founder's other picked channels no longer fit in the
 * record (0 when all did), or null when it stopped on a problem, which `state` then says.
 */
export function useProjectStarterBoards(
  launch: Launch,
  boardNames: readonly string[],
) {
  const client = useQueryClient();
  const name = useNameBoards();
  const [state, setState] = useState<StarterState>({ phase: "idle" });

  const create = useCallback(async (): Promise<number | null> => {
    setState({ phase: "working" });
    const publisher = openUserPublisher();
    let dropped = 0;
    try {
      await createProjectStarterBoards({
        scope: {
          relay: relayWsUrl(),
          founder: launch.record.author,
          projectId: launch.record.id,
        },
        existingNames: boardNames,
        store: memoStore(),
        newId: () => crypto.randomUUID(),
        exists: boardExists,
        create: async (board, id) => {
          await publisher.publish(
            starterDrafts(board, id).create,
            `The server didn't create the ${board.name} board. Try again.`,
          );
        },
        seed: async (board, id) => {
          await publisher.publish(
            starterDrafts(board, id).seed,
            `The ${board.name} board was created, but its first post wasn't accepted.`,
          );
        },
        tie: async (ids) => {
          dropped = await name(launch, ids);
        },
      });
      setState({ phase: "idle" });
      return dropped;
    } catch (error) {
      setState({
        phase: "error",
        message: failureWords(error, "Couldn't set up the boards. Try again.")
          .text,
      });
      return null;
    } finally {
      publisher.close();
      await client.invalidateQueries({ queryKey: ["channels"] });
      await client.invalidateQueries({ queryKey: launchesQueryKey });
    }
  }, [launch, boardNames, client, name]);

  return { state, create };
}
