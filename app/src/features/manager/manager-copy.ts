/**
 * The words of the manager's draft: what every refusal says and what to do next, and the fixed lines that go beside a
 * draft. The server writes its own plain sentence for each refusal (`api/manager`); these are the app's, used when the
 * server's is missing or is not a sentence, and for the kinds of failure the app itself sees.
 */

/** Said beside every draft: the draft can be wrong, and says what it read. */
export const CAN_BE_WRONG_FALLBACK =
  "This is a draft by an AI. It can be wrong. Read it, change it, and post only what is true.";

/** The notice that an AI wrote it (the server prints its own; this is the fallback). */
export const AI_SERVICE_FALLBACK = "AI service: a draft, not advice.";

/** What each refusal code means for the founder. */
const MANAGER_REFUSAL: Record<string, string> = {
  ai_manager_founder_only:
    "Only the person who started this project can ask for a draft.",
  ai_manager_post_weekly:
    "Post this week's update first, then ask for a draft again.",
  ai_manager_own_key:
    "This project has used this week's drafts. Write it yourself, or run the manager with your own AI key.",
  ai_manager_platform_cap:
    "The free drafts on this server are used up for now. Write it yourself, or run the manager with your own AI key.",
  ai_manager_unmetered:
    "Drafts are off on this server for now. Write it yourself.",
  ai_unavailable:
    "The AI service didn't answer. Write it yourself, or try again later.",
  ai_too_fast: "You asked a moment ago. Wait a minute, then try again.",
  ai_limit_account:
    "You have used today's AI allowance. Try again tomorrow, or write it yourself.",
  ai_limit_community:
    "This server has used today's AI allowance. Try again tomorrow, or write it yourself.",
};

export const MANAGER_PROBLEM = {
  /** The server is not set up for the AI service, or the route is not there. */
  notThere: "Drafts are not offered on this server. Write it yourself.",
  noAnswer:
    "The AI service didn't answer in time. Write it yourself, or try again later.",
  unreadable:
    "The draft came back in a shape the app could not read. Write it yourself, or try again.",
  notSigned: "Sign in to ask for a draft.",
} as const;

/** A server sentence is a line or two of plain words; anything else is not shown. */
const SENTENCE_MAX = 400;

/** The words for a refusal body `{ error, code }`: the server's own sentence when it is one, else the app's. */
export function refusalWords(
  status: number,
  body: unknown,
  fallback: string = MANAGER_PROBLEM.unreadable,
): string {
  const { error, code } = (body ?? {}) as { error?: unknown; code?: unknown };
  const sentence =
    typeof error === "string"
      ? [...error]
          .map((c) => (c < " " || c === "\u007f" ? " " : c))
          .join("")
          .replace(/ {2,}/g, " ")
          .trim()
      : "";
  if (sentence !== "" && sentence.length <= SENTENCE_MAX) return sentence;
  if (typeof code === "string" && MANAGER_REFUSAL[code])
    return MANAGER_REFUSAL[code];
  if (status === 404) return MANAGER_PROBLEM.notThere;
  return fallback;
}

/** What the draft sets aside, in words a founder reads. */
export function leftOutWords(counts: {
  dropped: number;
  blocked: number;
  setAside: number;
}): string | null {
  const parts: string[] = [];
  if (counts.dropped > 0)
    parts.push(
      `${counts.dropped} ${counts.dropped === 1 ? "line was" : "lines were"} left out because the record does not back ${counts.dropped === 1 ? "it" : "them"}`,
    );
  if (counts.blocked > 0)
    parts.push(
      `${counts.blocked} ${counts.blocked === 1 ? "line was" : "lines were"} left out because ${counts.blocked === 1 ? "it" : "they"} talked about returns, price or moving money`,
    );
  if (counts.setAside > 0)
    parts.push(
      `${counts.setAside} ${counts.setAside === 1 ? "input was" : "inputs were"} not read because ${counts.setAside === 1 ? "it" : "they"} looked like instructions to an AI`,
    );
  return parts.length > 0 ? `${parts.join("; ")}.` : null;
}
