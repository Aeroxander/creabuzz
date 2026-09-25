import { useMutation, useQuery } from "@tanstack/react-query";

import {
  applyProjectTemplate,
  listProjectTemplates,
  showProjectTemplate,
  type ProjectTemplate,
  type ProjectTemplateSummary,
  type TemplateApplyReport,
} from "@/shared/api/tauriTemplates";

/**
 * Project-template queries for the "Start a project" picker.
 *
 * Templates are embedded in the bundled CLI and change only with app
 * updates, so both queries cache hard and never poll — the picker is a
 * one-shot surface, and the apply mutation is the only write.
 */
export const PROJECT_TEMPLATES_STALE_TIME_MS = 30 * 60_000;

export const projectTemplatesQueryKey = ["project-templates"] as const;
export const projectTemplateDetailsQueryKey = [
  ...projectTemplatesQueryKey,
  "details",
] as const;

export function useProjectTemplatesQuery() {
  return useQuery({
    queryKey: projectTemplatesQueryKey,
    queryFn: listProjectTemplates,
    staleTime: PROJECT_TEMPLATES_STALE_TIME_MS,
  });
}

/** Full schema for every template — the card "what you get" lists. */
export function useProjectTemplateDetailsQuery(
  summaries: ProjectTemplateSummary[] | undefined,
) {
  return useQuery({
    queryKey: projectTemplateDetailsQueryKey,
    queryFn: (): Promise<ProjectTemplate[]> =>
      Promise.all((summaries ?? []).map((s) => showProjectTemplate(s.id))),
    enabled: (summaries?.length ?? 0) > 0,
    staleTime: PROJECT_TEMPLATES_STALE_TIME_MS,
  });
}

/**
 * Apply (or resume) a template via the bundled `buzz templates apply`.
 * Resolves to the CLI's apply report even on partial failure — the report's
 * `status` is authoritative and drives the resume UI.
 */
export function useTemplateApplyMutation() {
  return useMutation({
    mutationFn: (input: {
      id: string;
      resume: boolean;
    }): Promise<TemplateApplyReport> =>
      applyProjectTemplate(input.id, input.resume),
  });
}
