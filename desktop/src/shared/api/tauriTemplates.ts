import { invokeTauri } from "@/shared/api/tauri";

/**
 * Project-template sidecar surface (`buzz templates …` via the bundled CLI).
 *
 * The Rust commands pass the CLI's JSON through verbatim, so these types are
 * the CLI's normalized output contract (snake_case) — one source of truth.
 */

export type ProjectTemplateSummary = {
  id: string;
  name: string;
  description: string;
};

export type ProjectTemplateChannel = {
  id: string;
  name: string;
  purpose: string;
  seed?: string;
};

export type ProjectTemplateSkill = {
  name: string;
  source: string;
  applies_to: "developers" | "all";
};

export type ProjectTemplate = {
  id: string;
  name: string;
  description: string;
  channels: ProjectTemplateChannel[];
  personas: { id: string; name: string; prompt: string }[];
  workflows: { file: string }[];
  docs: { file: string; title: string }[];
  skills: ProjectTemplateSkill[];
  welcome: string;
};

export type TemplateApplyStep = {
  step: string;
  item: string;
  action: "created" | "skipped" | "failed" | "not-attempted";
  reason?: string;
  error?: string;
  event_id?: string;
  accepted?: boolean;
  message?: string;
  channel_id?: string;
};

export type TemplateApplyReport = {
  status: "ok" | "partial" | "failed";
  template_id: string;
  resumed: boolean;
  steps: TemplateApplyStep[];
  failed_step?: { step: string; item: string; error: string };
  welcome?: { channel_id: string; event_id: string; content: string };
};

export async function listProjectTemplates(): Promise<
  ProjectTemplateSummary[]
> {
  return invokeTauri<ProjectTemplateSummary[]>("templates_list");
}

export async function showProjectTemplate(
  id: string,
): Promise<ProjectTemplate> {
  return invokeTauri<ProjectTemplate>("templates_show", { id });
}

export async function applyProjectTemplate(
  id: string,
  resume: boolean,
): Promise<TemplateApplyReport> {
  return invokeTauri<TemplateApplyReport>("templates_apply", { id, resume });
}
