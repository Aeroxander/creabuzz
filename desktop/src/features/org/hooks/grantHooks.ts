import { useMutation, useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { KIND_ORG_GRANT } from "@/shared/constants/kinds";

import {
  buildGrantContent,
  buildGrantRevocation,
  nextCreatedAt,
} from "../lib/orgPublish";
import { orgQueryKey, fetchOwnRecord } from "./shared";

// ── Grant mutations ────────────────────────────────────────────────────────

type OrgGrantInput = {
  dtag: string;
  grantee: string;
  via: string;
  verbs: string[];
  parentGrant?: string;
  expires?: number;
};

async function publishOrgGrantEvent(input: OrgGrantInput): Promise<string> {
  const tags: string[][] = [
    ["d", input.dtag],
    ["p", input.grantee],
  ];
  // The relay refuses a grant whose signer is not its `issuer`.
  const { pubkey } = await getIdentity();
  const content = buildGrantContent({
    issuer: pubkey,
    grantee: input.grantee,
    via: input.via,
    verbs: input.verbs,
    parentGrant: input.parentGrant,
    expires: input.expires,
  });
  const event = await signRelayEvent({ kind: KIND_ORG_GRANT, content, tags });
  await relayClient.publishEvent(
    event,
    "Timed out creating grant.",
    "Failed to create grant.",
  );
  return event.id;
}

async function publishOrgGrantRevocation(dtag: string): Promise<string> {
  // Revocation republishes the FULL grant with `revoked: true`; the relay
  // parses every grant as a whole body, so a bare stub would be refused.
  const { pubkey } = await getIdentity();
  const existing = await fetchOwnRecord(KIND_ORG_GRANT, dtag, pubkey);
  if (!existing) {
    throw new Error(
      "Only the issuer can revoke a grant, and it was not found among yours.",
    );
  }
  const tags: string[][] =
    existing.tags.length > 0 ? existing.tags : [["d", dtag]];
  const content = buildGrantRevocation(existing.content, pubkey);
  const event = await signRelayEvent({
    kind: KIND_ORG_GRANT,
    content,
    tags,
    createdAt: nextCreatedAt(
      existing.created_at,
      Math.floor(Date.now() / 1000),
    ),
  });
  await relayClient.publishEvent(
    event,
    "Timed out revoking grant.",
    "Failed to revoke grant.",
  );
  return event.id;
}

export function useCreateOrgGrantMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishOrgGrantEvent,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "grants"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}

export function useRevokeOrgGrantMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishOrgGrantRevocation,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "grants"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}
