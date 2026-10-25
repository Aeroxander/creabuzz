/**
 * Setting up an existing community from a template, from the browser.
 *
 * Checks the viewer's role, reads what the server already holds, plans, then
 * sends one record per step as the signed-in person, stopping at the first the
 * server refuses. Applying the
 * same template again resumes from the server's own records, so a failure in
 * the middle is never a mess to clean up. The bundled templates are loaded when
 * one is picked, so the page itself does not carry them.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import {
  describeStep,
  planApply,
  type PlanStep,
} from "@creaton/core/templates/apply.ts";
import type { TemplateEntry } from "@creaton/core/templates/schema.ts";
import { markFirstStep } from "@/shared/lib/first-steps";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { openUserPublisher } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";
import {
  isAdminRole,
  KIND_NIP43_MEMBERSHIP_LIST,
  viewerRoleFromEvents,
} from "@/features/wiki/lib/live-members";

import { explainStepFailure } from "./lib/explain";
import {
  buildExistingState,
  CHANNEL_METADATA_KIND,
  MARKED_KINDS,
  ORG_KINDS,
  type ServerRecord,
} from "./lib/existing-state";
import { runPlan, type RunReport, type StepResult } from "./lib/run-plan";

export type ApplyState =
  | { phase: "idle" }
  | { phase: "reading"; entry: TemplateEntry }
  | { phase: "running"; entry: TemplateEntry; results: StepResult[] }
  | { phase: "done"; entry: TemplateEntry; report: RunReport }
  | { phase: "stopped"; entry: TemplateEntry; report: RunReport }
  | { phase: "error"; entry: TemplateEntry | null; message: string };

/** Bounded reads: a community never makes us pull more than this of anything. */
const READ_LIMIT = 500;

async function loadExisting(url: string, templateId: string, me: string) {
  const [channelRecords, markerRecords, orgRecords] = await Promise.all([
    queryEvents(url, { kinds: [CHANNEL_METADATA_KIND], limit: READ_LIMIT }),
    queryEvents(url, {
      kinds: [...MARKED_KINDS],
      authors: [me],
      "#t": [templateId],
      limit: READ_LIMIT,
    }),
    queryEvents(url, {
      kinds: [...ORG_KINDS],
      authors: [me],
      limit: READ_LIMIT,
    }),
  ]);
  const records = (events: typeof channelRecords): ServerRecord[] =>
    events.map((e) => ({
      id: e.id,
      kind: e.kind,
      created_at: e.created_at,
      tags: e.tags as string[][],
    }));
  return buildExistingState({
    templateId,
    channelRecords: records(channelRecords),
    markerRecords: records(markerRecords),
    orgRecords: records(orgRecords),
  });
}

function initialResults(entry: TemplateEntry, plan: PlanStep[]): StepResult[] {
  return plan.map((step) => ({
    step,
    label: describeStep(entry, step),
    status: "not-attempted" as const,
  }));
}

/**
 * Whether the viewer is this community's owner or an admin, read from the relay's member list (which carries
 * community roles): `allowed`, `denied` (listed with another role), `unknown` (not listed, or no list), `error`,
 * `checking`, or `anonymous` for someone without an account. A missing list is never read as permission.
 */
export function useCommunitySetupAccess() {
  const me = existingUserPubkey();
  const url = relayWsUrl();
  // Scoped to both relay and identity.
  const accessQuery = useQuery({
    queryKey: ["template-setup-access", url, me],
    queryFn: async () => {
      const events = await queryEvents(url, {
        kinds: [KIND_NIP43_MEMBERSHIP_LIST],
        limit: 5,
      });
      const role = viewerRoleFromEvents(events, me);
      return isAdminRole(role) ? "allowed" : role ? "denied" : "unknown";
    },
    enabled: me !== null,
    retry: false,
  });
  const access = !me
    ? "anonymous"
    : accessQuery.isFetching
      ? "checking"
      : accessQuery.isError
        ? "error"
        : (accessQuery.data ?? "checking");
  return { access, refreshAccess: accessQuery.refetch };
}

export function useTemplateApply() {
  const queryClient = useQueryClient();
  const me = existingUserPubkey();
  const url = relayWsUrl();
  const [state, setState] = useState<ApplyState>({ phase: "idle" });
  const applying = useRef(false);
  const { access, refreshAccess } = useCommunitySetupAccess();

  const apply = useCallback(
    async (templateId: string) => {
      if (applying.current) return;
      applying.current = true;
      let entry: TemplateEntry | null = null;
      try {
        if (!me)
          throw new Error(
            "Create your account first, then set up your community.",
          );
        const { TEMPLATE_CATALOG } = await import(
          "@creaton/core/templates/catalog.generated.ts"
        );
        entry = TEMPLATE_CATALOG[templateId] ?? null;
        if (!entry) throw new Error("That template is not available.");
        setState({ phase: "reading", entry });
        // Always check again at the action boundary: the role shown by the
        // picker may have changed since it opened. No writes precede this.
        const permission = await refreshAccess({ throwOnError: true });
        if (permission.data !== "allowed") {
          setState({ phase: "idle" });
          return;
        }
        const existing = await loadExisting(url, entry.template.id, me);
        if (existingUserPubkey() !== me || relayWsUrl() !== url) {
          throw new Error(
            "Your account or community changed. Reopen community setup and try again.",
          );
        }
        const plan = planApply(entry, existing);
        setState({
          phase: "running",
          entry,
          results: initialResults(entry, plan),
        });
        // One connection for the whole run: thirty records, one login.
        const publisher = openUserPublisher();
        let report: RunReport;
        try {
          report = await runPlan({
            entry,
            plan,
            existing,
            me,
            publish: async (draft) => {
              await publisher.publish(draft, "The server did not accept this.");
            },
            explain: explainStepFailure,
            onProgress: (results) =>
              setState({
                phase: "running",
                entry: entry as TemplateEntry,
                results,
              }),
          });
        } finally {
          publisher.close();
        }
        // Whatever was made shows up in the channel list, the wiki and the chart.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["channels"] }),
          queryClient.invalidateQueries({ queryKey: ["wiki-pages"] }),
          queryClient.invalidateQueries({ queryKey: ["knowledge-pages"] }),
        ]);
        if (report.status === "done") markFirstStep(localStorage, "project");
        setState({
          phase: report.status === "done" ? "done" : "stopped",
          entry,
          report,
        });
      } catch (error) {
        setState({
          phase: "error",
          entry,
          message:
            error instanceof Error && error.message
              ? error.message
              : "Couldn't set up the community. Check the connection, then try again.",
        });
      } finally {
        applying.current = false;
      }
    },
    [queryClient, me, url, refreshAccess],
  );

  const reset = useCallback(() => setState({ phase: "idle" }), []);
  return { state, apply, reset, access, refreshAccess };
}
