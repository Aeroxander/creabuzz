/**
 * Starting a project from a template, from the browser.
 *
 * Reads what the server already holds, plans, then sends one record per step as
 * the signed-in person, stopping at the first the server refuses. Applying the
 * same template again resumes from the server's own records, so a failure in
 * the middle is never a mess to clean up. The bundled templates are loaded when
 * one is picked, so the page itself does not carry them.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import {
  describeStep,
  planApply,
  type PlanStep,
} from "@creaton/core/templates/apply.ts";
import type { TemplateEntry } from "@creaton/core/templates/schema.ts";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { openUserPublisher } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";

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

async function loadExisting(templateId: string, me: string) {
  const url = relayWsUrl();
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

export function useTemplateApply() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ApplyState>({ phase: "idle" });

  const apply = useCallback(
    async (templateId: string) => {
      const me = existingUserPubkey();
      let entry: TemplateEntry | null = null;
      try {
        if (!me)
          throw new Error("Create your account first, then start a project.");
        const { TEMPLATE_CATALOG } = await import(
          "@creaton/core/templates/catalog.generated.ts"
        );
        entry = TEMPLATE_CATALOG[templateId] ?? null;
        if (!entry) throw new Error("That template is not available.");
        setState({ phase: "reading", entry });
        const existing = await loadExisting(entry.template.id, me);
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
              : "Couldn't start the project. Check the connection, then try again.",
        });
      }
    },
    [queryClient],
  );

  const reset = useCallback(() => setState({ phase: "idle" }), []);
  return { state, apply, reset };
}
