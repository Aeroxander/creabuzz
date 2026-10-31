/**
 * The one door for starting something: the steps in the order most projects take them, and where each one stands for
 * this person.
 *
 * It only says what the app can check: a project finished from a template in this browser, an idea or a sale the
 * person published. Nothing is ticked on a guess. The last step (running it together) is what happens after a raise, so
 * it is never "done" from here.
 *
 * A build that offers no raises (the contributor-only hosted image, `raisesOffered`) leaves out the raise steps (they
 * would open a sale that cannot be launched) and the place-to-work step (the pilot server makes no new communities, and
 * its helpers are not set up). What is left is an option beside the contributor project, not a numbered next step.
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
    body: "Pick a creative or a technical project. Channels, AI helpers and pages are set up for you.",
    action: "Set up your community",
    note: "Create one of your own, or open one you are in. Then press Start a project in its sidebar.",
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

/** The steps a build without raises leaves out: the raise itself, and the place to work it has no way to set up. */
const LEFT_OUT_WITHOUT_RAISES: ReadonlySet<StartStepKey> = new Set([
  "workspace",
  "raise",
  "run",
]);

/** The words a build without raises uses instead: nothing about backing. */
const WITHOUT_RAISES: Partial<
  Record<StartStepKey, Partial<Pick<StartStep, "body" | "note">>>
> = {
  idea: {
    body: "Say what you are making in a sentence. People can say they're interested, so you see who wants to help.",
  },
};

/**
 * Each step with whether it is done, and which one is next. `raises` is whether this build offers raises; without them
 * only the idea step is left, it does not talk about backing, and it is an option rather than a next step (the
 * contributor project above it is the way to start), so nothing is marked next.
 */
export function startSteps(
  progress: StartProgress,
  raises: boolean,
): StartStepView[] {
  const done: Record<StartStepKey, boolean> = {
    workspace: progress.madeProject,
    idea: progress.hasIdea || progress.hasSale,
    raise: progress.hasSale,
    run: false,
  };
  let nextFound = false;
  return START_STEPS.filter(
    (step) => raises || !LEFT_OUT_WITHOUT_RAISES.has(step.key),
  ).map((step) => {
    const isDone = done[step.key];
    // "Run it together" is what happens after a raise, never a task to tick off.
    const next = raises && !isDone && !nextFound && step.key !== "run";
    if (next) nextFound = true;
    const words = raises ? {} : (WITHOUT_RAISES[step.key] ?? {});
    return { ...step, ...words, done: isDone, next };
  });
}

/**
 * The `?start=` of the launchpad link, as the launchpad reads it: anything else opens nothing. The launchpad also opens
 * nothing for `sale` where the build offers no raises.
 */
export function parseStart(value: unknown): "idea" | "sale" | undefined {
  return value === "idea" || value === "sale" ? value : undefined;
}
