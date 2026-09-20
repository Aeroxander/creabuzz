// Org onboarding wizard state machine (paperclip-ux-reference.md §3, P2 item
// 8). Pure and framework-free: the position/outcome bookkeeping lives here so
// node --test units can pin the strip semantics — positions are *counted,
// not indexed* (a skipped seat keeps its number; the strip stays truthful),
// each step records its real-publish outcome, and the review step derives
// its rows from what was actually created vs. skipped.
import type { OrgNodeKind } from "../orgModels";

export const WIZARD_STEP_IDS = [
  "root",
  "seat",
  "grant",
  "budget",
  "review",
] as const;
export type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

export type WizardStepMeta = {
  id: WizardStepId;
  /** 1-based position in the strip — counted, never derived from array index. */
  position: number;
  title: string;
  /** Step 1 (the root) is the only required publish. */
  required: boolean;
};

export const WIZARD_STEPS: WizardStepMeta[] = [
  { id: "root", position: 1, title: "Name the org root", required: true },
  {
    id: "seat",
    position: 2,
    title: "Add a role or agent seat",
    required: false,
  },
  { id: "grant", position: 3, title: "First grant", required: false },
  { id: "budget", position: 4, title: "First budget", required: false },
  { id: "review", position: 5, title: "Review", required: false },
];

/** Steps 2–4 are skippable; the root and the review are not. */
export const SKIPPABLE_STEP_IDS: ReadonlySet<WizardStepId> = new Set([
  "seat",
  "grant",
  "budget",
]);

/** Created-entity outcome of a completed wizard step. */
export type WizardCreated =
  | {
      kind: "node";
      /** Root node (step 1) or child seat (step 2). */
      dtag: string;
      name: string;
      nodeKind: OrgNodeKind;
      parent?: string;
    }
  | {
      kind: "grant";
      dtag: string;
      grantee: string;
      via: string;
      verbs: string[];
    }
  | {
      kind: "budget";
      dtag: string;
      subject: string;
      window: string;
      limitsText: string;
    };

export type WizardOutcome =
  | ({ step: "root" | "seat" | "grant" | "budget" } & WizardCreated)
  | { step: "skipped"; skippedStep: "seat" | "grant" | "budget" };

export type OrgWizardState = {
  /** 1-based position of the step the wizard is currently on. */
  position: number;
  outcomes: Partial<Record<WizardStepId, WizardOutcome>>;
};

export type WizardStepStatus = "pending" | "active" | "complete" | "skipped";

export type WizardReviewRow = {
  position: number;
  title: string;
  /** null = the step was skipped (root can never be null at review time). */
  outcome: WizardOutcome | null;
};

export function initialWizardState(): OrgWizardState {
  return { position: 1, outcomes: {} };
}

export function stepMeta(id: WizardStepId): WizardStepMeta {
  const meta = WIZARD_STEPS.find((step) => step.id === id);
  if (!meta) throw new Error(`Unknown wizard step: ${id}`);
  return meta;
}

export function positionOf(id: WizardStepId): number {
  return stepMeta(id).position;
}

export function currentStepId(state: OrgWizardState): WizardStepId {
  const meta = WIZARD_STEPS.find((step) => step.position === state.position);
  return meta ? meta.id : "review";
}

export function stepStatus(
  state: OrgWizardState,
  id: WizardStepId,
): WizardStepStatus {
  const outcome = state.outcomes[id];
  const position = positionOf(id);
  if (state.position === position) return "active";
  if (outcome?.step === "skipped") return "skipped";
  if (outcome) return "complete";
  return state.position > position ? "skipped" : "pending";
}

export function isStepSkipped(
  state: OrgWizardState,
  id: WizardStepId,
): boolean {
  return state.outcomes[id]?.step === "skipped";
}

export function recordOutcome(
  state: OrgWizardState,
  id: WizardStepId,
  outcome: WizardOutcome,
): OrgWizardState {
  const nextPosition = Math.min(state.position + 1, WIZARD_STEPS.length);
  return {
    position: nextPosition,
    outcomes: { ...state.outcomes, [id]: outcome },
  };
}

/**
 * Skip a step (2–4 only). The root cannot be skipped: this returns the state
 * unchanged and the caller gates the button by SKIPPABLE_STEP_IDS. Skipping
 * still advances the position — the strip counts through the gap.
 */
export function skipStep(
  state: OrgWizardState,
  id: WizardStepId,
): OrgWizardState {
  if (!SKIPPABLE_STEP_IDS.has(id)) return state;
  return recordOutcome(state, id, {
    step: "skipped",
    skippedStep: id === "grant" ? "grant" : id === "budget" ? "budget" : "seat",
  });
}

/** Review reached means every prior step resolved; the root must exist. */
export function canFinish(state: OrgWizardState): boolean {
  return (
    state.position >= WIZARD_STEPS.length &&
    state.outcomes.root !== undefined &&
    state.outcomes.root.step !== "skipped"
  );
}

/** Steps 1–4 in strip order as review rows (skipped steps keep their row). */
export function reviewRows(state: OrgWizardState): WizardReviewRow[] {
  return WIZARD_STEPS.filter((step) => step.id !== "review").map((step) => ({
    position: step.position,
    title: step.title,
    outcome: state.outcomes[step.id] ?? null,
  }));
}
