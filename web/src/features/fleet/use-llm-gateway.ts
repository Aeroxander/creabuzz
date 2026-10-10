/**
 * Does this server have an AI service a tab helper can use?
 *
 * The server forwards `/llm/chat/completions` to an AI provider only when its
 * operator has set one up; without one the address does not exist (404). An
 * empty, unsigned request is enough to tell the two apart without costing
 * anything: a server with the service answers it with some other refusal (the
 * request has no body and no signature), a server without it says it is not
 * there. Anything else (a network failure) is "unknown", never a guess.
 */

import { useEffect, useState } from "react";

import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

import type { GatewayStatus } from "./lib/helper-ways";

export async function probeLlmGateway(
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayStatus> {
  try {
    const response = await fetchImpl(
      `${relayHttpBaseUrl()}/llm/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    return response.status === 404 ? "missing" : "available";
  } catch {
    return "unknown";
  }
}

export function useLlmGateway(): GatewayStatus {
  const [status, setStatus] = useState<GatewayStatus>("unknown");
  useEffect(() => {
    let alive = true;
    void probeLlmGateway().then((result) => {
      if (alive) setStatus(result);
    });
    return () => {
      alive = false;
    };
  }, []);
  return status;
}
