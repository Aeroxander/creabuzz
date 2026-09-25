/**
 * Project Board data plane: one-shot relay queries + the five writes.
 *
 * Reads are a single `queryEvents` over the four org-plane kinds this feature
 * owns (37010 node, 37011 grant, 37015 pitch, 37016 join request) — the same
 * shape the launchpad uses (`use-launches.ts`), so the board and the detail
 * page derive from one snapshot and cannot disagree with each other. Writes
 * sign with the durable identity and publish over the existing relay path
 * (`signAsUser` → `publishEvent`); no feature-private transport.
 *
 * Write inventory, each exactly one durable event:
 * - publish pitch → kind:37015 (+ the kind:37010 org node when the project
 *   is new; a node-landed/pitch-failed outcome surfaces as
 *   {@link PitchPublishError} so the UI can offer a pitch-only retry instead
 *   of implying success)
 * - request a role → kind:37016
 * - approve → kind:37011 ownership grant (the equity record)
 * - decline → kind:37016 republication with `decision: "declined"`
 *
 * Sources: `web/src/features/launchpad/use-launches.ts` (query + mutation
 * conventions), `web/src/shared/lib/identity.ts` (signing),
 * `crates/buzz-core/src/kind.rs` (kinds).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  KIND_ORG_GRANT,
  KIND_ORG_JOIN_REQUEST,
  KIND_ORG_NODE,
  KIND_ORG_PITCH,
} from "@/shared/constants/kinds";
import {
  existingUserPubkey,
  userPubkey,
  signAsUser,
} from "@/shared/lib/identity";
import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { publishEvent } from "@/shared/lib/publish-event";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { parseOwnershipGrant, type OwnershipGrant } from "./lib/grant";
import { parseJoinRequest, type JoinRequest } from "./lib/join-request";
import {
  buildPitchTemplate,
  parsePitch,
  type PitchInput,
  type PitchManifest,
} from "./lib/manifest";
import {
  deriveBoard,
  deriveProjectState,
  type ProjectState,
  type ProjectSummary,
} from "./lib/state";

/** The org-plane kinds the board reads. */
export const PROJECT_EVENT_KINDS = [
  KIND_ORG_NODE,
  KIND_ORG_GRANT,
  KIND_ORG_PITCH,
  KIND_ORG_JOIN_REQUEST,
] as const;

const PROJECTS_KEY = "projects" as const;

/** Everything the board and detail pages derive from. */
export interface ProjectEvents {
  pitches: PitchManifest[];
  nodes: NostrEvent[];
  requests: JoinRequest[];
  grants: OwnershipGrant[];
}

/** One org node: the project's seat structure, `holders` = the founder. */
export function buildOrgNodeTemplate(input: {
  nodeId: string;
  name: string;
  holder: string;
  blurb: string;
}): { kind: number; tags: string[][]; content: string } {
  return {
    kind: KIND_ORG_NODE,
    tags: [
      ["d", input.nodeId],
      ["name", input.name],
      ["seat", input.holder],
    ],
    content: JSON.stringify({
      v: 1,
      name: input.name,
      kind: "team",
      holders: [input.holder],
      agent_seats: [],
      ui: { blurb: input.blurb },
    }),
  };
}

async function fetchProjectEvents(): Promise<ProjectEvents> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: [...PROJECT_EVENT_KINDS],
    limit: 500,
  });
  const parsed = {
    pitches: [] as PitchManifest[],
    nodes: [] as NostrEvent[],
    requests: [] as JoinRequest[],
    grants: [] as OwnershipGrant[],
  };
  for (const event of events) {
    if (event.kind === KIND_ORG_PITCH) {
      const pitch = parsePitch(event);
      if (pitch) parsed.pitches.push(pitch);
    } else if (event.kind === KIND_ORG_NODE) {
      parsed.nodes.push(event);
    } else if (event.kind === KIND_ORG_JOIN_REQUEST) {
      const request = parseJoinRequest(event);
      if (request) parsed.requests.push(request);
    } else if (event.kind === KIND_ORG_GRANT) {
      const grant = parseOwnershipGrant(event);
      if (grant) parsed.grants.push(grant);
    }
  }
  return parsed;
}

/** The one query behind every surface in this feature. */
export function useProjectEvents() {
  return useQuery({
    queryKey: [PROJECTS_KEY, "events"],
    queryFn: fetchProjectEvents,
  });
}

export interface BoardResult {
  projects: ProjectSummary[];
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

/** Board cards for everyone, with "needs me" flags when signed in. */
export function useBoard(): BoardResult {
  const query = useProjectEvents();
  const projects = query.data
    ? deriveBoard({
        pitches: query.data.pitches,
        nodes: query.data.nodes,
        requests: query.data.requests,
        grants: query.data.grants,
        me: existingUserPubkey(),
      })
    : [];
  return {
    projects,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

export interface ProjectResult {
  project: ProjectState | null;
  hasNode: boolean;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * One project's state. `author` disambiguates: node ids are unique per
 * author, so without it a shared id would resolve to whichever pitch the
 * query returned first (the launchpad's detail pages take the same param).
 */
export function useProject(projectId: string, author?: string): ProjectResult {
  const query = useProjectEvents();
  const pitches = (query.data?.pitches ?? []).filter(
    (pitch) =>
      pitch.nodeId === projectId &&
      (author === undefined || pitch.author === author),
  );
  pitches.sort(
    (a, b) => b.createdAt - a.createdAt || (a.eventId < b.eventId ? -1 : 1),
  );
  const manifest = pitches[0] ?? null;
  const founder = manifest?.author;
  const project = manifest
    ? deriveProjectState({
        manifest,
        requests: (query.data?.requests ?? []).filter(
          (request) => request.projectId === projectId,
        ),
        grants: (query.data?.grants ?? []).filter(
          (grant) => grant.via === projectId,
        ),
      })
    : null;
  const hasNode = (query.data?.nodes ?? []).some(
    (node) => node.pubkey === founder && dTag(node) === projectId,
  );
  return {
    project,
    hasNode,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

function dTag(event: { tags: string[][] }): string | null {
  const tag = event.tags.find((t) => t[0] === "d");
  return tag?.[1] ? tag[1] : null;
}

/** An unsigned template ready to sign and publish (see `lib/*` builders). */
export interface EventTemplate {
  kind: number;
  tags: string[][];
  content: string;
}

/** Sign a template with the durable identity and publish it over the relay. */
async function publishTemplate(template: EventTemplate): Promise<NostrEvent> {
  const signed = await signAsUser(template);
  const result = await publishEvent(relayWsUrl(), signed, {
    signAuth: signAsUser,
  });
  if (!result.accepted) {
    throw new Error(result.message ?? "The relay rejected this event.");
  }
  return signed;
}

/**
 * Sign + publish one event and refresh the board. The generic write path for
 * join requests, approvals, and declines — each is exactly one event, so
 * there is no partial outcome to reconcile.
 */
export function usePublishProjectEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishTemplate,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [PROJECTS_KEY] });
    },
  });
}

/** Failure of a two-write create, carrying what already landed (Rule 1). */
export class PitchPublishError extends Error {
  readonly nodeId: string;
  /** True when the org node reached the relay and only the pitch failed. */
  readonly nodePublished: boolean;

  constructor(message: string, nodeId: string, nodePublished: boolean) {
    super(message);
    this.name = "PitchPublishError";
    this.nodeId = nodeId;
    this.nodePublished = nodePublished;
  }
}

export interface CreatePitchInput {
  pitch: PitchInput;
  /** `null` attaches the pitch to an already-published org node. */
  node: { nodeId: string; name: string; blurb: string } | null;
  /** Set on retry: the node landed, send only the pitch. */
  skipNode?: boolean;
}

/**
 * Create a project: org node first (identity), then the pitch (board card).
 * The ordering and the error type are the honest partial state — a failure
 * between the two writes is reported as exactly that, never as success.
 */
export function useCreatePitch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: CreatePitchInput,
    ): Promise<{ nodeId: string }> => {
      // Validate first: a field-level rejection must happen before ANY event
      // is published, or a bad form would leave an org node behind.
      const pitchTemplate = buildPitchTemplate(input.pitch);
      const holder = userPubkey();
      // Attach mode and retries both mean: the node is already on the relay.
      let nodeExists = input.node === null || Boolean(input.skipNode);
      if (input.node && !nodeExists) {
        try {
          await publishTemplate(
            buildOrgNodeTemplate({
              nodeId: input.node.nodeId,
              name: input.node.name,
              holder,
              blurb: input.node.blurb,
            }),
          );
        } catch (error) {
          throw new PitchPublishError(
            `The project's org node did not publish: ${messageOf(error)}`,
            input.pitch.nodeId,
            false,
          );
        }
        nodeExists = true;
      }
      try {
        await publishTemplate(pitchTemplate);
      } catch (error) {
        throw new PitchPublishError(
          `The pitch did not publish: ${messageOf(error)}`,
          input.pitch.nodeId,
          nodeExists,
        );
      }
      void queryClient.invalidateQueries({ queryKey: [PROJECTS_KEY] });
      return { nodeId: input.pitch.nodeId };
    },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
