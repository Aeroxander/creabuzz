/**
 * Create-channel state machine for the web client.
 *
 * One user action ("Create channel") publishes the kind 9007 create-group
 * event and then adds the picked members with sequential kind 9000
 * add-member events. Sequential on purpose: concurrent writes to the
 * replaceable membership event lose members to last-write-wins (the same
 * constraint desktop enforces when attaching managed agents).
 *
 * A membership failure never discards the created channel — the result
 * reports exactly which members still need attaching so the dialog can offer
 * a targeted retry.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { signAsUser } from "@/shared/lib/identity";
import { publishEvent } from "@/shared/lib/publish-event";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  type AddMemberEventInput,
  buildAddMemberEvent,
  buildCreateChannelEvent,
  type ChannelTypeChoice,
  type ChannelVisibilityChoice,
  type CreateChannelEventInput,
  type MemberRoleChoice,
} from "./lib/channel-create-events";

export type ChannelMemberInput = {
  /** 64-hex member pubkey. */
  pubkey: string;
  /** Display name, echoed back for retry reporting. */
  name: string;
  role?: MemberRoleChoice;
};

export type CreateChannelVariables = {
  name: string;
  topic?: string;
  visibility: ChannelVisibilityChoice;
  channelType: ChannelTypeChoice;
  /** Members to attach after the channel exists (agents join as bots). */
  members: ChannelMemberInput[];
};

export type AttachFailure = {
  pubkey: string;
  name: string;
  message: string;
};

export type CreateChannelResult = {
  channelId: string;
  attached: ChannelMemberInput[];
  /** Members whose add-member write failed — surfaced, never swallowed. */
  attachFailures: AttachFailure[];
};

async function publishTemplate(
  template: Parameters<typeof signAsUser>[0],
): Promise<void> {
  const signed = await signAsUser(template);
  const result = await publishEvent(relayWsUrl(), signed);
  if (!result.accepted) {
    throw new Error(
      result.message ?? "The server did not accept this write. Try again.",
    );
  }
}

async function attachMembersSequentially(
  channelId: string,
  members: readonly ChannelMemberInput[],
): Promise<{
  attached: ChannelMemberInput[];
  attachFailures: AttachFailure[];
}> {
  const attached: ChannelMemberInput[] = [];
  const attachFailures: AttachFailure[] = [];
  for (const member of members) {
    const input: AddMemberEventInput = {
      channelId,
      pubkey: member.pubkey,
      role: member.role ?? "bot",
    };
    try {
      await publishTemplate(buildAddMemberEvent(input));
      attached.push(member);
    } catch (error) {
      attachFailures.push({
        pubkey: member.pubkey,
        name: member.name,
        message:
          error instanceof Error ? error.message : "Failed to add member.",
      });
    }
  }
  return { attached, attachFailures };
}

/** Create the channel, then attach members. Rejects only on channel failure. */
export function useCreateChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      variables: CreateChannelVariables,
    ): Promise<CreateChannelResult> => {
      const channelId = crypto.randomUUID();
      const input: CreateChannelEventInput = {
        id: channelId,
        name: variables.name,
        visibility: variables.visibility,
        channelType: variables.channelType,
        about: variables.topic,
      };
      await publishTemplate(buildCreateChannelEvent(input));
      const { attached, attachFailures } = await attachMembersSequentially(
        channelId,
        variables.members,
      );
      // The channel-list read path (kind:39000) picks the new channel up on
      // this refetch — the server derives that metadata from our write.
      await queryClient.invalidateQueries({ queryKey: ["channels"] });
      return { channelId, attached, attachFailures };
    },
  });
}

/** Targeted retry for members that failed to attach after creation. */
export function useAttachChannelMembers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: {
      channelId: string;
      members: ChannelMemberInput[];
    }): Promise<{
      attached: ChannelMemberInput[];
      attachFailures: AttachFailure[];
    }> => {
      const result = await attachMembersSequentially(
        variables.channelId,
        variables.members,
      );
      await queryClient.invalidateQueries({
        queryKey: ["channels", variables.channelId, "members"],
      });
      return result;
    },
  });
}
