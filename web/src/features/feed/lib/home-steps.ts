/**
 * What Home's "Get started" list asks of someone who just signed up, which depends on why they came.
 *
 * A backer finds a project, reads its agreement, and backs or follows it. A founder publishes a project and sets up its
 * funding agreement. They are two different first hours, so each has its own list, and neither is asked to do the other's
 * work (a backer is not asked to start a project or run an AI helper). Every box is ticked only for something the app can
 * verify, so a ticked box never lies. Starting a workspace and running a helper stay available to founders as things for
 * later, never as part of the way in.
 *
 * Pure and alias-free: `home-steps.test.mjs` drives it under `node --test`.
 */

export type Role = "backer" | "founder";

/** Backing is the headline of the product, so it is where someone starts until they say otherwise. */
export const DEFAULT_ROLE: Role = "backer";

export function parseRole(raw: string | null | undefined): Role {
  return raw === "founder" || raw === "backer" ? raw : DEFAULT_ROLE;
}

/** What the app can tell about this person. */
export interface Signals {
  /** They have a name on their profile. */
  named: boolean;
  /** They opened a project's page in this browser. */
  lookedAtProject: boolean;
  /** They follow a project or a person. */
  follows: boolean;
  /** They bid on a project's sale. */
  backed: boolean;
  /** They published a project or an idea. */
  published: boolean;
  /** A project of theirs has milestones for its team's tokens. */
  setUpMilestones: boolean;
  /** They finished a ready-made team in this browser. */
  madeWorkspace: boolean;
  /** They ran an AI helper in this browser. */
  ranHelper: boolean;
}

export interface Step {
  id: string;
  done: boolean;
  label: string;
  hint: string;
  to: "/c" | "/discover" | "/launchpad" | null;
  /** For later: shown, but never holds the list open. */
  optional?: boolean;
}

export function stepsFor(role: Role, signals: Signals): Step[] {
  const name: Step = {
    id: "name",
    done: signals.named,
    label: "Add your name and a picture",
    hint: "Open your account menu, top right.",
    to: null,
  };
  if (role === "backer") {
    return [
      name,
      {
        id: "look",
        done: signals.lookedAtProject || signals.follows || signals.backed,
        label: "Look at a project",
        hint: "See its terms, its team and its milestones before you decide.",
        to: "/discover",
      },
      {
        id: "follow-or-back",
        done: signals.follows || signals.backed,
        label: "Follow a project, or back one",
        hint: "Follow it to see its updates. Backing is a bid in an open sale; if the sale misses its minimum, every bid is refunded.",
        to: "/discover",
      },
      {
        id: "back",
        done: signals.backed,
        label: "Back a project",
        hint: "Optional, for when you have read its terms and want to put money in.",
        to: "/discover",
        optional: true,
      },
    ];
  }
  return [
    name,
    {
      id: "publish",
      done: signals.published,
      label: "Publish your project",
      hint: "Say what you are building in a sentence. People can say they would back it.",
      to: "/launchpad",
    },
    {
      id: "milestones",
      done: signals.setUpMilestones,
      label: "Set up your funding agreement",
      hint: "Name the milestones, who judges them, and how much of the team's tokens each one unlocks.",
      to: "/launchpad",
    },
    {
      id: "workspace",
      done: signals.madeWorkspace,
      label: "Set up a place to work",
      hint: "Optional. A ready-made team gives you channels, helpers and pages.",
      to: "/c",
      optional: true,
    },
    {
      id: "helper",
      done: signals.ranHelper,
      label: "Put an AI helper to work",
      hint: "Optional. In your workspace, open AI helpers and run one in this tab.",
      to: "/c",
      optional: true,
    },
  ];
}

/** The way in is done when every step that is not marked for later is. */
export function wayInDone(steps: readonly Step[]): boolean {
  return steps.filter((step) => !step.optional).every((step) => step.done);
}
