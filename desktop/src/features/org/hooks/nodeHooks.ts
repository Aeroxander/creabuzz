import { useMutation, useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { KIND_ORG_NODE } from "@/shared/constants/kinds";

import { deleteAddressableEvents } from "../lib/orgDeletion";
import { orgQueryKey } from "./shared";

// ── Node mutations ─────────────────────────────────────────────────────────

type OrgNodeInput = {
  dtag: string;
  name: string;
  kind: "role" | "team" | "agent_seat";
  parent?: string;
  holders?: string[];
  agentSeats?: string[];
};

async function publishOrgNodeEvent(input: OrgNodeInput): Promise<string> {
  const tags: string[][] = [["d", input.dtag]];
  if (input.holders) {
    for (const h of input.holders) tags.push(["p", h]);
  }
  if (input.agentSeats) {
    for (const a of input.agentSeats) tags.push(["p", a]);
  }
  const content = JSON.stringify({
    v: 1,
    name: input.name,
    kind: input.kind,
    parent: input.parent,
    holders: input.holders ?? [],
    agentSeats: input.agentSeats ?? [],
    scope: {},
  });
  const event = await signRelayEvent({ kind: KIND_ORG_NODE, content, tags });
  await relayClient.publishEvent(
    event,
    "Timed out creating org node.",
    "Failed to create org node.",
  );
  return event.id;
}

async function publishOrgNodeDeletion(dtag: string): Promise<string> {
  await deleteAddressableEvents(
    {
      kind: KIND_ORG_NODE,
      dtag,
      label: "org node",
      timeoutMessage: "Timed out deleting org node.",
      failureMessage: "Failed to delete org node.",
    },
    {
      fetchEvents: relayClient.fetchEvents.bind(relayClient),
      nowSeconds: () => Math.floor(Date.now() / 1_000),
      publishEvent: relayClient.publishEvent.bind(relayClient),
      signEvent: signRelayEvent,
    },
  );
  return dtag;
}

export function useCreateOrgNodeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishOrgNodeEvent,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "nodes"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}

export function useDeleteOrgNodeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishOrgNodeDeletion,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "nodes"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}
