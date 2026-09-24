import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useIdentityQuery } from "@/shared/api/hooks";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_DELETION,
  type KIND_LAUNCH_PROPOSAL,
  type KIND_LAUNCH_RECEIPT,
  type KIND_LAUNCH_UPDATE,
} from "@/shared/constants/kinds";
import { fetchLaunches } from "@/features/launchpad/launchpadFetch";
import {
  launchCoordinate,
  type Launch,
} from "@/features/launchpad/launchpadModels";
import {
  buildLaunchRecordTemplate,
  type CreateLaunchInput,
} from "@/features/launchpad/lib/launchRecord";

export const launchesQueryKey = ["launchpad", "launches"] as const;

export function useLaunchesQuery() {
  return useQuery({
    queryKey: [...launchesQueryKey],
    queryFn: ({ signal }) => fetchLaunches(signal),
    staleTime: 30_000,
  });
}

export function useLaunchQuery(
  launchId: string | undefined,
  author: string | undefined,
) {
  const list = useLaunchesQuery();
  const launch = React.useMemo(
    () =>
      launchId === undefined
        ? undefined
        : list.data?.find(
            (l) =>
              l.record.id === launchId &&
              (author === undefined || l.record.author === author),
          ),
    [list.data, launchId, author],
  );
  return { ...list, launch };
}

export function useIsLaunchFounder(launch: Launch | undefined): boolean {
  const identity = useIdentityQuery();
  const pubkey = identity.data?.pubkey;
  return Boolean(launch && pubkey && launch.record.author === pubkey);
}

async function publishSignedEvent(input: {
  kind: number;
  content: string;
  tags: string[][];
}): Promise<RelayEvent> {
  const signed = await signRelayEvent(input);
  await relayClient.publishEvent(
    signed,
    "Launchpad publish timed out.",
    "Launchpad publish failed.",
  );
  return signed;
}

export type { CreateLaunchInput };

export { buildLaunchRecordTemplate };

export function useCreateLaunchMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLaunchInput) =>
      publishSignedEvent(buildLaunchRecordTemplate(input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...launchesQueryKey] });
    },
  });
}

export function useUpdateLaunchRecordMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLaunchInput) =>
      publishSignedEvent(buildLaunchRecordTemplate(input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...launchesQueryKey] });
    },
  });
}

export type PublishMirrorInput = {
  kind:
    | typeof KIND_LAUNCH_UPDATE
    | typeof KIND_LAUNCH_PROPOSAL
    | typeof KIND_LAUNCH_RECEIPT;
  author: string;
  launchId: string;
  extraTags?: string[][];
  content: Record<string, unknown>;
};

export function usePublishLaunchMirrorMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PublishMirrorInput) => {
      const tags: string[][] = [
        ["a", launchCoordinate(input.author, input.launchId)],
      ];
      if (input.extraTags) tags.push(...input.extraTags);
      return publishSignedEvent({
        kind: input.kind,
        content: JSON.stringify(input.content),
        tags,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...launchesQueryKey] });
    },
  });
}

export function useDeleteLaunchMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (launch: Launch) =>
      publishSignedEvent({
        kind: KIND_DELETION,
        content: "",
        tags: [["a", launchCoordinate(launch.record.author, launch.record.id)]],
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...launchesQueryKey] });
    },
  });
}
