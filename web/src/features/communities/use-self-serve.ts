/**
 * Starting a community of your own: whether this server offers it, and the call that makes one.
 *
 * The create call is signed with the person's account (NIP-98), so the server knows who will own the new community. The
 * account must be one that survives a reload: a community owned by a key that is gone with the tab could never be
 * opened again.
 */

import { useQuery } from "@tanstack/react-query";

import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import {
  isServerTimeout,
  SERVER_DID_NOT_ANSWER,
  timedFetchStreamed,
} from "@/shared/lib/timed-fetch";
import type { Access } from "./lib/access";
import {
  DEFAULT_LIMITS,
  type NameLimits,
  pickApiOrigin,
} from "./lib/community-name";

const PATH = "/self-serve/communities";

function apiOrigin(): string | null {
  return pickApiOrigin(
    import.meta.env.VITE_COMMUNITY_API_ORIGIN as string | undefined,
    window.location.origin,
  );
}

export interface SelfServeStatus {
  enabled: boolean;
  /** What a name is put in front of: `acme` + `creaton.example`. */
  domain: string | null;
  limits: NameLimits;
}

const OFF: SelfServeStatus = {
  enabled: false,
  domain: null,
  limits: DEFAULT_LIMITS,
};

async function fetchStatus({
  signal,
}: {
  signal?: AbortSignal;
} = {}): Promise<SelfServeStatus> {
  const origin = apiOrigin();
  if (!origin) return OFF;
  const response = await timedFetchStreamed(`${origin}${PATH}`, { signal });
  // A server that predates the feature has no such route. That is "not offered", not a failure.
  if (response.status === 404) return OFF;
  if (!response.ok) throw new Error(`server responded ${response.status}`);
  const body = (await response.json()) as {
    enabled?: boolean;
    domain?: string;
    min_name_length?: number;
    max_name_length?: number;
  };
  if (!body.enabled || typeof body.domain !== "string") return OFF;
  return {
    enabled: true,
    domain: body.domain,
    limits: {
      min: body.min_name_length ?? DEFAULT_LIMITS.min,
      max: body.max_name_length ?? DEFAULT_LIMITS.max,
    },
  };
}

/** Whether this server lets people start their own community, and under which domain. */
export function useSelfServe() {
  return useQuery({
    queryKey: ["self-serve", "status", window.location.origin],
    queryFn: fetchStatus,
    staleTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/** A refusal or failure, in words to show. `code` says which, for the few the screen treats differently. */
class CreateCommunityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface CreatedCommunity {
  /** The community's address, as `/c/<host>` names it. */
  host: string;
  /** The WebSocket address to connect to. */
  url: string;
}

/** Make a community called `name` (already tidied) and own it, open to anyone or only to people it invites. */
export async function createCommunity(
  name: string,
  access: Access,
): Promise<CreatedCommunity> {
  const origin = apiOrigin();
  if (!origin) {
    throw new CreateCommunityError(
      "setup",
      "This app is not set up to start communities. Ask whoever runs it.",
    );
  }
  const url = `${origin}${PATH}`;
  const body = JSON.stringify({ name, access });

  let auth: string;
  try {
    auth = await makeNip98AuthHeader(url, "POST", {
      body,
      requireDurable: true,
    });
  } catch (cause) {
    throw new CreateCommunityError(
      "signing",
      cause instanceof Error && cause.message
        ? cause.message
        : "Could not sign in to start the community. Try again.",
    );
  }

  let response: Response;
  try {
    response = await timedFetchStreamed(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body,
    });
  } catch (error) {
    throw new CreateCommunityError(
      "network",
      isServerTimeout(error)
        ? SERVER_DID_NOT_ANSWER
        : "Could not reach the server. Check your connection and try again.",
    );
  }

  const json = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    host?: string;
    url?: string;
  };
  if (!response.ok) {
    throw new CreateCommunityError(
      json.code ?? `http_${response.status}`,
      json.error && json.code
        ? json.error
        : "The server did not accept that. Try again in a moment.",
    );
  }
  if (typeof json.host !== "string" || typeof json.url !== "string") {
    throw new CreateCommunityError(
      "bad_answer",
      "The server's answer was not what we expected. Reload and check your communities.",
    );
  }
  return { host: json.host, url: json.url };
}
