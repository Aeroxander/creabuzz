/**
 * Starter wording for a project that is about AI work: an app, an agent or tool, a dataset or benchmark, or AI media.
 *
 * A founder picks a kind on Start and gets editable text, nothing more: goal hints, ways to say how we will know (each
 * with a number, so the goal can be checked), three first promises and a few starter tasks, each with its finish line.
 * It is wording only. The project's records have no new field and nothing here is sent anywhere until the founder
 * edits the text and presses a button.
 *
 * Plain words on purpose: no tool, company or product is named, so the lines stay true as tools change. Where a task
 * could be done by an agent, the person who set it still answers for it: an agent cannot sign a goal or a promise.
 *
 * Pure and alias-free: `aiProjectKinds.test.mjs` drives it under `node --test`.
 */

/** One starter task: what to do and what "done" means, before anyone starts. */
interface AiStarterTask {
  title: string;
  /** The finish line: what has to be true, and what is handed in as evidence. */
  done: string;
}

/** The text offered for one kind of AI project. Every field is an editable suggestion. */
interface AiProjectKind {
  id: "ai-app" | "agent-tool" | "dataset-benchmark" | "ai-media";
  /** The chip's words. */
  label: string;
  /** One line under the chips saying what the kind covers. */
  about: string;
  /** Example goals, in the founder's voice, to start from. */
  goalHints: readonly string[];
  /** Ways to say how we will know, each with a number and a way to check it. */
  howExamples: readonly string[];
  /** Exactly three first promises for the first weekly update. */
  promises: readonly [string, string, string];
  /** Three to five starter tasks. */
  tasks: readonly AiStarterTask[];
}

export const AI_PROJECT_KINDS: readonly AiProjectKind[] = [
  {
    id: "ai-app",
    label: "AI app",
    about: "A product people use that has AI inside it.",
    goalHints: [
      "A first version that ten people use for a real task.",
      "An app that answers customer questions correctly most of the time.",
      "A working demo that anyone can open without signing up.",
    ],
    howExamples: [
      "10 people use it in the same week, and at least 7 say it saved them time.",
      "It answers 80 of 100 test questions correctly, with the list of questions and results published.",
      "A link anyone can open, with 25 people having tried it by the end of the month.",
    ],
    promises: [
      "Put a first working version online that anyone can open.",
      "Ask five people to try it and write down what went wrong.",
      "Fix the three problems people hit most.",
    ],
    tasks: [
      {
        title: "Write 20 real questions the app must get right",
        done: "A shared list of 20 questions, each with the answer a person would accept.",
      },
      {
        title: "Put the first version online",
        done: "A link that opens without an account and answers one question end to end.",
      },
      {
        title: "Run the 20 questions and record the results",
        done: "A results file showing how many were right, and the ones that were wrong.",
      },
      {
        title: "Watch three people try it and write down what confused them",
        done: "Three short notes, each naming one thing the person got stuck on.",
      },
    ],
  },
  {
    id: "agent-tool",
    label: "Agent or tool",
    about:
      "A helper that does a job on its own, or a tool other people's helpers can use.",
    goalHints: [
      "A helper that finishes one routine job without being watched.",
      "A tool that people and their helpers can both use.",
      "An agent that does one task end to end and shows its work.",
    ],
    howExamples: [
      "It finishes 9 of 10 test jobs correctly without help, and each result is checked by a person.",
      "5 other projects use it for a month, and the list of who used it is public.",
      "It saves a person at least 2 hours a week, measured by 5 people over 4 weeks.",
    ],
    promises: [
      "Write down the one job it does, and what it will never do.",
      "Run it on ten real jobs and publish what it got right and wrong.",
      "Name the person who answers for its work and how to reach them.",
    ],
    tasks: [
      {
        title:
          "Write the job in one page: what goes in, what comes out, what is off limits",
        done: "A one-page description that someone else read and could repeat back.",
      },
      {
        title: "Collect ten real jobs to test it on",
        done: "Ten jobs, each with the result a person would accept.",
      },
      {
        title: "Run the ten jobs and keep every result",
        done: "A results file with the output for each job, marked right or wrong by a person other than the builder.",
      },
      {
        title: "Write how to stop it and undo what it did",
        done: "A short page with the steps, tried once by someone other than the builder.",
      },
    ],
  },
  {
    id: "dataset-benchmark",
    label: "Dataset or benchmark",
    about:
      "A collection of examples, or a fair test, that others can use and check.",
    goalHints: [
      "A public collection of 1,000 checked examples that anyone can download.",
      "A fair test that shows which approach works better.",
      "A cleaned-up version of an existing collection, with the changes listed.",
    ],
    howExamples: [
      "1,000 examples published, with a sample of 100 checked by two people who agree on at least 95 of them.",
      "3 other teams run the test and publish their scores by the end of the quarter.",
      "At least 100 downloads in the first month, from a link that needs no account, with a page saying where every example came from.",
    ],
    promises: [
      "Publish the first 100 examples with where each one came from.",
      "Write the rules for what counts as a correct example.",
      "Have a second person check a sample of 50 and publish how often they agreed.",
    ],
    tasks: [
      {
        title: "Write the rules for what makes an example correct",
        done: "A one-page guide with three good and three bad examples, read by someone who did not write it.",
      },
      {
        title: "Collect the first 100 examples with their sources",
        done: "A file of 100 examples, each with a link or note saying where it came from.",
      },
      {
        title: "Have a second person check 50 of them",
        done: "A sheet showing for each of the 50 whether the checker agreed, and the share that agreed.",
      },
      {
        title: "Say who may use it and how",
        done: "A short page with the allowed uses and the credit people must give.",
      },
      {
        title: "Publish the first version where anyone can download it",
        done: "A link that downloads the file without an account.",
      },
    ],
  },
  {
    id: "ai-media",
    label: "AI media",
    about: "Pictures, sound, video or writing made with AI help.",
    goalHints: [
      "A short film, album or picture set made with AI help and finished in the open.",
      "A series of 12 pieces, one a week, each with how it was made.",
      "A game or story world whose art was made with AI help.",
    ],
    howExamples: [
      "12 finished pieces published, one each week, each with a note on what was made by hand and what by AI.",
      "A film of at least five minutes that 50 people have watched by the end of the month.",
      "Ten pieces that three people outside the team rated at least 4 out of 5.",
    ],
    promises: [
      "Publish the first piece and say how it was made.",
      "Write down who owns what and what anyone may reuse.",
      "Ask three people outside the team what they think and publish their answers.",
    ],
    tasks: [
      {
        title:
          "Write a one-page plan: what the finished work is and how long it runs",
        done: "A page that names the pieces, the length or count, and the date the first one is due.",
      },
      {
        title: "Make and publish the first piece",
        done: "A link anyone can open, with a note saying what was made by hand and what with AI help.",
      },
      {
        title: "Write who owns the work and what others may reuse",
        done: "A short page with the owner, the allowed reuse and any source material used, read by someone else.",
      },
      {
        title:
          "Show the first piece to three people and write down what they said",
        done: "Three short notes, each with one thing the person liked and one they would change.",
      },
    ],
  },
] as const;

/** The kind with this id, or null for an id this build does not know. */
export function aiProjectKind(
  id: string | null | undefined,
): AiProjectKind | null {
  return AI_PROJECT_KINDS.find((kind) => kind.id === id) ?? null;
}

/**
 * The line Start shows for AI projects: who answers for agent work. An agent may offer, do work and hand in evidence;
 * a goal and a promise are signed by a person.
 */
export const AI_PROJECT_ACCOUNTABILITY =
  "An agent can do work for your project, but a named person answers for it. Goals and promises are signed by a person.";
