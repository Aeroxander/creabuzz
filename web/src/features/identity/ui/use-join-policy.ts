import { useCallback, useEffect, useState } from "react";

import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

import { type PolicyState, policyFromResponse } from "../lib/join-policy";

/** How long to wait for the server's terms before going ahead without them. */
const POLICY_TIMEOUT_MS = 5_000;

/**
 * The server's terms of use and privacy note (`lib/join-policy.ts`), and a way to ask again. With `enabled` false
 * nothing is fetched and the state stays "loading".
 */
export function useJoinPolicy(enabled = true): {
  state: PolicyState;
  reload: () => void;
} {
  const [state, setState] = useState<PolicyState>({ status: "loading" });
  const [round, setRound] = useState(0);
  const reload = useCallback(() => {
    setState({ status: "loading" });
    setRound((n) => n + 1);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` is the trigger for asking again.
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let base = "";
    try {
      base = relayHttpBaseUrl();
    } catch {
      setState({ status: "unavailable" });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLICY_TIMEOUT_MS);
    fetch(`${base}/api/join-policy`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return policyFromResponse(await response.json());
      })
      .catch((): PolicyState => ({ status: "unavailable" }))
      .then((next) => {
        if (active) setState(next);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, round]);
  return { state, reload };
}
