import * as React from "react";

import { Button } from "@/shared/ui/button";
import type {
  ProjectTemplate,
  TemplateApplyReport,
} from "@/shared/api/tauriTemplates";
import {
  useProjectTemplateDetailsQuery,
  useProjectTemplatesQuery,
  useTemplateApplyMutation,
} from "@/features/templates/hooks";
import {
  deriveApplyUiState,
  whatYouGet,
  type ApplyUiState,
} from "@/features/templates/templatePlan";

/**
 * "Start a project" — the empty-community home affordance.
 *
 * Template cards (name / description / what-you-get) → "Create project" runs
 * the bundled `buzz templates apply <id>` sidecar and renders the per-step
 * checklist, the welcome message on full success, and an honest partial-
 * failure state with Resume (which re-runs `apply --resume`; the CLI's
 * idempotent marker plan completes the remainder).
 */
export function StartProjectSection() {
  const templatesQuery = useProjectTemplatesQuery();
  const summaries = templatesQuery.data;
  const detailsQuery = useProjectTemplateDetailsQuery(summaries);
  const applyMutation = useTemplateApplyMutation();

  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<TemplateApplyReport | null>(null);

  const detailsById = React.useMemo(() => {
    const map = new Map<string, ProjectTemplate>();
    for (const t of detailsQuery.data ?? []) {
      map.set(t.id, t);
    }
    return map;
  }, [detailsQuery.data]);

  const runApply = React.useCallback(
    (id: string, resume: boolean) => {
      setActiveId(id);
      setReport(null);
      applyMutation.mutate(
        { id, resume },
        {
          onSuccess: (result) => {
            setReport(result);
          },
        },
      );
    },
    // Depend on the stable mutate method, not the mutation object (AGENTS gotcha 6).
    [applyMutation.mutate],
  );

  const templates = summaries ?? [];
  const applyUi: ApplyUiState | null = report
    ? deriveApplyUiState(report)
    : null;
  const isRunning = applyMutation.isPending && report === null;
  const sidecarError =
    applyMutation.isError && report === null
      ? applyMutation.error instanceof Error
        ? applyMutation.error.message
        : "The project could not be created."
      : null;

  return (
    <section aria-labelledby="start-project-heading">
      <h2
        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        id="start-project-heading"
      >
        Start a project
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Pick a template and this community becomes a working project — channels,
        agents, workflows, and docs in one step.
      </p>

      {templatesQuery.isError ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          Templates could not be loaded from the bundled CLI.
        </p>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {templates.map((summary) => {
          const details = detailsById.get(summary.id);
          const isActive = activeId === summary.id;
          return (
            <article
              className="flex flex-col rounded-md border border-border/60 px-4 py-4"
              key={summary.id}
            >
              <h3 className="text-base font-medium">{summary.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {summary.description}
              </p>
              {details ? (
                <ul className="mt-2 list-inside list-disc text-2xs text-muted-foreground">
                  {whatYouGet(details).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-3">
                <Button
                  disabled={isRunning}
                  onClick={() => runApply(summary.id, false)}
                  type="button"
                >
                  {isRunning && isActive ? "Creating…" : "Create project"}
                </Button>
              </div>

              {isActive ? (
                <div className="mt-3" role="status" aria-live="polite">
                  {isRunning ? (
                    <p className="text-2xs text-muted-foreground">
                      Applying {summary.name}…
                    </p>
                  ) : null}
                  {sidecarError ? (
                    <p className="text-2xs text-destructive" role="alert">
                      {sidecarError}
                    </p>
                  ) : null}
                  {applyUi ? (
                    <>
                      <ul className="space-y-1">
                        {applyUi.steps.map((step) => (
                          <li
                            className="flex items-center gap-2 text-2xs"
                            key={step.label}
                          >
                            <StepGlyph state={step.state} />
                            <span
                              className={
                                step.state === "failed"
                                  ? "text-destructive"
                                  : "text-muted-foreground"
                              }
                            >
                              {step.label}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {applyUi.welcome !== null ? (
                        <div className="mt-2 rounded-md border border-border/60 px-3 py-2">
                          <p className="text-2xs font-medium">
                            {summary.name} is ready
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-2xs text-muted-foreground">
                            {applyUi.welcome}
                          </p>
                        </div>
                      ) : null}
                      {applyUi.error !== null ? (
                        <p
                          className="mt-2 text-2xs text-destructive"
                          role="alert"
                        >
                          {applyUi.error}
                        </p>
                      ) : null}
                      {applyUi.canResume ? (
                        <Button
                          className="mt-2"
                          onClick={() => runApply(summary.id, true)}
                          type="button"
                          variant="outline"
                        >
                          Resume
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {templatesQuery.isSuccess && templates.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No project templates are bundled with this build.
        </p>
      ) : null}
    </section>
  );
}

/** One checklist glyph; decorative — the label next to it owns the meaning. */
function StepGlyph({
  state,
}: {
  state: ApplyUiState["steps"][number]["state"];
}) {
  const glyph =
    state === "done"
      ? "✓"
      : state === "skipped"
        ? "→"
        : state === "failed"
          ? "✕"
          : "○";
  return (
    <span aria-hidden="true" className="w-3 text-center">
      {glyph}
    </span>
  );
}
