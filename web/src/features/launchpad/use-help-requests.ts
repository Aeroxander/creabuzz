/**
 * Sending and reading help: "I can help" on an update that asks for it, taking an offer back, the team's reply, and
 * "Help found". Each is one signed record (`lib/help-request.ts`); the project list is read again once the server took
 * it, so every card shows what the server has.
 *
 * No state is kept outside React and the shared project read: nothing here outlives a change of community.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";

import {
  foundEvent,
  helpNotices,
  type HelpNotice,
  offerEvent,
  replyEvent,
} from "./lib/help-request";
import { launchCoordinate, type Launch } from "./models";
import { launchesQueryKey, publishMirror, useLaunches } from "./use-launches";

type Project = Pick<Launch["record"], "author" | "id">;

function sendSignal(
  project: Project,
  signal: { content: Record<string, unknown>; tags: string[][] },
) {
  return publishMirror({
    kind: KIND_LAUNCH_UPDATE,
    tags: [["a", launchCoordinate(project.author, project.id)], ...signal.tags],
    content: signal.content,
  });
}

/** The four things a help card can send. Each is its own mutation, so one failing or pending never hides another. */
export function useHelpActions(project: Project) {
  const queryClient = useQueryClient();
  const onSuccess = () =>
    queryClient.invalidateQueries({ queryKey: launchesQueryKey });

  const offer = useMutation({
    mutationFn: (input: {
      updateId: string;
      updateAuthor: string;
      note: string;
    }) => sendSignal(project, offerEvent(input)),
    onSuccess,
  });
  const reply = useMutation({
    mutationFn: (input: {
      offerId: string;
      offerAuthor: string;
      note: string;
    }) => sendSignal(project, replyEvent(input)),
    onSuccess,
  });
  const found = useMutation({
    mutationFn: (input: { updateId: string }) =>
      sendSignal(project, foundEvent(input)),
    onSuccess,
  });
  /** Takes an offer back: the person's own record is deleted, so it is gone for everyone. */
  const withdraw = useMutation({
    mutationFn: (input: { offerId: string }) =>
      publishMirror({
        kind: 5,
        tags: [
          ["e", input.offerId],
          ["k", String(KIND_LAUNCH_UPDATE)],
        ],
        content: {},
      }),
    onSuccess,
  });
  return { offer, reply, found, withdraw };
}

const NO_NOTICES: HelpNotice[] = [];

/**
 * Offers to help on the viewer's projects and replies to the viewer's own offers, newest first, from the project read
 * the app already makes (no read of its own).
 */
export function useHelpNotices(): HelpNotice[] {
  const me = existingUserPubkey();
  const launches = useLaunches().data;
  return useMemo(
    () => (me && launches ? helpNotices(launches, me) : NO_NOTICES),
    [me, launches],
  );
}
