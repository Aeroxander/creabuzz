import type {
  ProjectTemplate,
  TemplateApplyReport,
  TemplateApplyStep,
} from "@/shared/api/tauriTemplates";

/**
 * Pure UI-state derivations for the "Start a project" picker.
 *
 * Kept free of React/IPC so the report contract (the CLI's normalized JSON)
 * and the checklist/resume rendering can be table-tested directly — these are
 * the production seams `ui/StartProjectSection.tsx` renders from.
 */

/** Human label for one apply step (the "what you get" progress checklist). */
export function stepLabel(step: TemplateApplyStep): string {
  switch (step.step) {
    case "channel":
      return `Channel #${step.item}`;
    case "seed":
      return `First message in #${step.item.replace(/^seed:/, "")}`;
    case "skill":
      return `Skill ${step.item}`;
    case "persona":
      return `Agent ${step.item}`;
    case "workflow":
      return `Workflow ${step.item}`;
    case "doc":
      return `Doc ${step.item}`;
    case "welcome":
      return "Welcome message";
    default:
      return step.item;
  }
}

export type StepUiState = {
  label: string;
  state: "done" | "skipped" | "failed" | "pending" | "waiting";
};

export type ApplyUiState = {
  /** Overall: idle work, all-good, partial (resume), or failed before writes. */
  kind: "ok" | "partial" | "failed";
  steps: StepUiState[];
  /** The welcome message body for the success state (full success only). */
  welcome: string | null;
  /** The error to surface (failed_step error, or the failure summary). */
  error: string | null;
  /** Whether a Resume run can make progress (there is a remainder). */
  canResume: boolean;
};

/** Map one report step to its checklist state. */
export function stepUiState(step: TemplateApplyStep): StepUiState {
  const label = stepLabel(step);
  switch (step.action) {
    case "created":
      return { label, state: "done" };
    case "skipped":
      return { label, state: "skipped" };
    case "failed":
      return { label, state: "failed" };
    case "not-attempted":
      return { label, state: "waiting" };
  }
}

/**
 * Derive the picker's checklist + success/partial state from the apply
 * report. The report is authoritative — a partial run always enumerates its
 * full plan, so "Resume" is offered whenever anything failed or was left
 * not-attempted.
 */
export function deriveApplyUiState(report: TemplateApplyReport): ApplyUiState {
  const steps = report.steps.map(stepUiState);
  const hasFailed = report.steps.some((s) => s.action === "failed");
  const hasPending = report.steps.some((s) => s.action === "not-attempted");
  return {
    kind: report.status,
    steps,
    // Welcome is the UI success state — surfaced only on full success.
    welcome: report.status === "ok" ? (report.welcome?.content ?? null) : null,
    error:
      report.status === "ok"
        ? null
        : (report.failed_step?.error ??
          "The project could not be completed. Resume to retry the remainder."),
    canResume: hasFailed || hasPending,
  };
}

/** The "what you get" bullet list for a template card. */
export function whatYouGet(template: ProjectTemplate): string[] {
  const lines: string[] = [];
  const count = (n: number, one: string, many: string) =>
    lines.push(`${n} ${n === 1 ? one : many}`);
  if (template.channels.length > 0) {
    count(template.channels.length, "channel", "channels");
  }
  if (template.personas.length > 0) {
    count(template.personas.length, "agent", "agents");
  }
  if (template.workflows.length > 0) {
    count(template.workflows.length, "workflow", "workflows");
  }
  if (template.docs.length > 0) {
    count(template.docs.length, "doc", "docs");
  }
  if (template.skills.length > 0) {
    count(template.skills.length, "skill", "skills");
  }
  return lines;
}
