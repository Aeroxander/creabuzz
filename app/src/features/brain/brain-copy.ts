/** Every word the brain screens say, in one place, and how a failed read is told. */
import { isServerTimeout } from "@creaton/core/client/timed-fetch.ts";
import { brainRepoId } from "./brain-repo";

export const BRAIN_WORDS = {
  /** The one line on the project and in Start. */
  name: "Project brain",
  readLead:
    "A few plain notes the founder keeps for the project and its AI helper: what is true, how it is written, what was decided.",
  read: "Read the project's notes",
  readTitle: "The project's notes",
  loading: "Reading the notes…",
  empty: "The notes are not written yet.",
  readOn: "Read on",
  hide: "Close",
  tooBig: "This file is too long to show here.",
  notText: "This file is not plain text, so it is not shown.",
  readOnly:
    "You can read these notes here. They are changed from the founder's computer.",
  tryAgain: "Try again",
  unbound:
    "Nobody can read the notes yet: the repository is not attached to a room. Attach it to one, and the people in it can read the notes here.",
  /** The founder's own line. */
  setUpRow: "Keep a project brain",
  setUpLead:
    "A few plain notes that your AI helper reads before it drafts anything. Optional, and you can add it any time.",
  setUpOpen: "How to set it up",
  setUpTitle: "Keep a project brain",
  setUpWhat:
    "The brain is a folder of plain files: what is true about the project, how you write, what you decided and the jobs you repeat. Your AI helper reads them before it drafts, so what it says stays true.",
  setUpWho:
    "Anything in the folder can be read by people you let into the project's room. Never put a password or anything private in it.",
  setUpWhere:
    "Setting it up is done once, from your computer, with the command line:",
  setUpAfter:
    "When the folder is in the repository, anyone you let in can read it here, under the project.",
  copy: "Copy the steps",
  copied: "Steps copied.",
  copyFailed: "Your browser would not copy them. Select them and copy.",
  /** The Start line. */
  offerLabel: "Also keep a project brain",
  offerHint:
    "Optional. A few plain notes your AI helper reads before it drafts anything. You will see how to set it up on the project.",
} as const;

/** The words a failed read of the notes is told in. */
export function brainFailureWords(error: unknown): string {
  if (isServerTimeout(error))
    return "The server did not answer in time. Check your connection and try again.";
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "BrainTooBigError")
    return "The project's files are too big to read here.";
  const status = (error as { data?: { statusCode?: unknown } } | null)?.data
    ?.statusCode;
  if (status === 401) return "Sign in to read the notes, then try again.";
  if (status === 403 || status === 404)
    return "These notes are not open to you. Only people the founder let in can read them.";
  return "The notes could not be read. Try again.";
}

/** The steps a founder runs once (the same ids the reader looks for), as the text copied and shown. */
export function setUpSteps(projectId: string): string {
  const repo = brainRepoId(projectId);
  return [
    "# 1. write the five starting files into a folder",
    "buzz launchpad brain init --dir ./brain",
    "# 2. make the repository, in a room of people you trust to read it",
    `buzz repos create --id ${repo} --name "Project brain" --channel <ROOM_ID>`,
    "# 3. put the folder in the repository with git, then check it holds no key",
    "buzz launchpad brain check --dir ./brain",
  ].join("\n");
}
