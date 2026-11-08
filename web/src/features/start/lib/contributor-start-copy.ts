/**
 * The words on the contributor Start page that explain how the project works, in one place so a test can read what the
 * page renders (not its source) and so one idea keeps one word:
 *
 * - Shares are defined once, in the header, as votes in the project. Nothing else on the page defines them again.
 * - A Share can be "sold" (never "transferred" or taken to "a market" in these lines); the weekly sale only says when.
 * - The work flow (submit, accept, review, vote on the award) is said in the card, and the success text adds only the
 *   founder's own step, which the form's hints no longer show once the project exists.
 *
 * Alias-free on purpose: `ui/contributorStartCopy.test.mjs` drives it under `node --test`.
 */

/** The page's header line; the one place Shares are said to be votes. A build that offers raises says "can earn". */
export function startHeaderDescription(raises: boolean): string {
  return `Set up a project where reviewed work ${raises ? "can earn" : "earns"} Shares, which are votes in the project.`;
}

/** The card's heading: with raises on offer it is set against one; a contributor-only build has no sale to compare. */
export function whatItIsTitle(raises: boolean): string {
  return raises ? "Starts without a token sale" : "How Shares work";
}

/** The card's lines, in order. */
export const WHAT_IT_IS_POINTS: readonly string[] = [
  "You start with Shares of your own, and at first may hold all of them.",
  "New Shares come only from awards: someone submits work, the reviewers you name check it, then the project votes on an award. Approval alone gives no Shares.",
  "Shares can't be sold at first. Selling opens only after two project votes, at least 30 days apart.",
  "The project can still receive money into its funds.",
];

/** Under "What it is": says what the sentence is about, since the label is all a reader may see beside it. */
export const PITCH_HINT =
  "One sentence about the project, including who it is for.";

/** Under "How many reviewers must agree": the empty-box rule and the smallest number the project accepts. */
export const QUORUM_HINT =
  "Leave empty for more than half of them. At least two must agree.";

/** Under "Reviewers": who to pick. What a reviewer does is the card's to say. */
export const REVIEWERS_HINT =
  "Name at least three people other than the ones who will do the work. Reviewing does not itself give them Shares.";

/** The first work area's line: the founder's own step in the flow the card describes. */
export const WORK_AREAS_HINT =
  "What people can work on from the first day. You accept each submission into a work area.";

/** Once the project exists the form and its hints are gone, so this keeps the founder's step and the next action. */
export const DONE_TEXT =
  "The project is made and people can submit work now. You accept each submission into a work area, then the reviewers you named check it. Share the Work page so people can see what needs doing.";

/** Weekly sale intro: who can sell, when, what buyers pay with, and why the founder's own Shares are held back. */
export const SALE_INTRO =
  "Holders can offer Shares and buyers can bid for them each week, once selling is open. Buyers pay with a free test token that is worth nothing, so a price here proves nothing. Your own Shares can be offered only on the schedule below; this limits you, not other holders.";

/** Under "Days before you can sell any of your Shares". */
export const SALE_CLIFF_HINT = "0 means no wait.";

/** Under "Days over which your Shares unlock": readable without the field above it. */
export const SALE_DAYS_HINT =
  "These days start when the wait before your first sale ends.";
