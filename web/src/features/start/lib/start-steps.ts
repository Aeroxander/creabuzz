/**
 * The one door for starting something: the steps in the order most projects take them, and where each one stands for
 * this person.
 *
 * It only says what the app can check: a project finished from a template in this browser, an idea or a sale the
 * person published. Nothing is ticked on a guess. The last step (running it together) is what happens after a raise, so
 * it is never "done" from here.
 *
 * Alias-free for `node --test`.
 */

export type StartStepKey = "workspace" | "idea" | "raise" | "run";

/** Where a step's button goes. `start` is the `?start=` that opens a dialog on the launchpad. */
export type StartTarget =
  | { to: "/c" }
  | { to: "/launchpad"; start?: "idea" | "sale" }
  | { to: "/launchpad/$launchId"; launchId: string };

export interface StartStep {
  key: StartStepKey;
  title: string;
  body: string;
  /** The label of the one button. */
  action: string;
  /** A line under the button when the step needs a word of explanation. */
  note?: string;
  target: StartTarget;
}

export const START_STEPS: readonly StartStep[] = [
  {
    key: "workspace",
    title: "Set up a place to work",
    body: "Pick a ready-made team, such as a film crew, an app team or a startup crew. Channels, AI helpers and pages are set up for you.",
    action: "Open your community",
    note: "Then press Start a project in its sidebar.",
    target: { to: "/c" },
  },
  {
    key: "idea",
    title: "Share your idea",
    body: "Say what you are making in a sentence. People can say they would back it, so you see real interest before you raise anything.",
    action: "Share an idea",
    target: { to: "/launchpad", start: "idea" },
  },
  {
    key: "raise",
    title: "Raise money",
    body: "Open a sale when people are interested. Pick a size, and the people who back it become owners who vote on how the money is used.",
    action: "Set up a sale",
    note: "Best after you have shared your idea. You can also start here.",
    target: { to: "/launchpad", start: "sale" },
  },
  {
    key: "run",
    title: "Run it together",
    body: "After a raise the project becomes a DAO: owners vote on decisions, work is paid when reviewers approve it, and a public track record shows what happened.",
    action: "Try it with pretend money",
    target: { to: "/launchpad/$launchId", launchId: "nebula-sandbox" },
  },
];

export interface StartProgress {
  /** A project was finished from a template in this browser. */
  madeProject: boolean;
  /** The person has published an idea or a sale. */
  hasIdea: boolean;
  /** The person has published a sale (an idea that opened one counts). */
  hasSale: boolean;
}

export interface StartStepView extends StartStep {
  done: boolean;
  /** The first step not yet done: the one to do next. At most one. */
  next: boolean;
}

/** Each step with whether it is done, and which one is next. */
export function startSteps(progress: StartProgress): StartStepView[] {
  const done: Record<StartStepKey, boolean> = {
    workspace: progress.madeProject,
    idea: progress.hasIdea || progress.hasSale,
    raise: progress.hasSale,
    run: false,
  };
  let nextFound = false;
  return START_STEPS.map((step) => {
    const isDone = done[step.key];
    // "Run it together" is what happens after a raise, never a task to tick off.
    const next = !isDone && !nextFound && step.key !== "run";
    if (next) nextFound = true;
    return { ...step, done: isDone, next };
  });
}

/** The `?start=` of the launchpad link, as the launchpad reads it: anything else opens nothing. */
export function parseStart(value: unknown): "idea" | "sale" | undefined {
  return value === "idea" || value === "sale" ? value : undefined;
}
