/**
 * Budgets (kind:37012): read the community's active budgets and publish new
 * ones. Plain hooks to match the rest of the web client; reads are bounded
 * and always carry explicit kinds.
 */

import { useCallback, useEffect, useState } from "react";

import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { signAsUser } from "@/shared/lib/identity";
import { publishEvent } from "@/shared/lib/publish-event";
import {
  buildOrgBudgetContent,
  describeBudgetLimits,
  isCommunityDefaultSubject,
  type BudgetLimits,
  type BudgetWindow,
  type OrgBudgetContentInput,
} from "./lib/budgetForm";

/** Mirrors the server's org budget kind. */
const KIND_ORG_BUDGET = 37012;

/** Bounded read: never fetch more budgets than this. */
const BUDGETS_FETCH_LIMIT = 50;

export type WebBudget = {
  id: string;
  dtag: string;
  subject: string | null;
  window: BudgetWindow;
  limits: BudgetLimits;
  onExceed: string;
  onchain: unknown;
};

function budgetFromEvent(event: {
  id: string;
  tags: string[][];
  content: string;
}): WebBudget | null {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(event.content);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const windowValue = parsed.window;
  if (
    typeof windowValue !== "string" ||
    !["epoch", "day", "week", "month"].includes(windowValue)
  ) {
    return null;
  }
  const dtag = event.tags.find((t) => t[0] === "d")?.[1] ?? event.id;
  return {
    id: event.id,
    dtag,
    subject: typeof parsed.subject === "string" ? parsed.subject : null,
    window: windowValue as BudgetWindow,
    limits: (parsed.limits ?? {}) as BudgetLimits,
    onExceed:
      typeof parsed.onExceed === "string"
        ? parsed.onExceed
        : "require-approval",
    onchain: parsed.onchain,
  };
}

export function useBudgets(): {
  budgets: WebBudget[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [budgets, setBudgets] = useState<WebBudget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    queryEvents(relayWsUrl(), {
      kinds: [KIND_ORG_BUDGET],
      limit: BUDGETS_FETCH_LIMIT,
    })
      .then((events) => {
        setBudgets(
          events
            .map(budgetFromEvent)
            .filter((b): b is WebBudget => b !== null)
            .sort((a, b) => a.dtag.localeCompare(b.dtag)),
        );
        setError(null);
      })
      .catch(() => {
        setError(
          "The server did not answer the budget query. Check the connection, then retry.",
        );
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { budgets, loading, error, reload };
}

/**
 * Publish a new budget. Throws locally on a subject the server would reject;
 * a server rejection is returned as a message so the form can offer a retry.
 */
export async function publishBudget(
  input: OrgBudgetContentInput & { dtag: string },
): Promise<void> {
  const content = buildOrgBudgetContent(input);
  const event = await signAsUser({
    kind: KIND_ORG_BUDGET,
    content,
    tags: [["d", input.dtag]],
  });
  const result = await publishEvent(relayWsUrl(), event);
  if (!result.accepted) {
    throw new Error(
      result.message ||
        "The server did not accept the budget. Check the values, then try again.",
    );
  }
}

export { describeBudgetLimits, isCommunityDefaultSubject };
