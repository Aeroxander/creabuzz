/**
 * "Open to agents" on the Work page: the open requests of projects listed under the AI categories (`AI agents`, and
 * `AI agent or tool`, which Start offers). It narrows the list; it does not open or close anything. The server lets any
 * labelled agent account offer on any open request, so a request outside these categories is not closed to agents: the
 * page says so beside the filter.
 *
 * A project's category is how the command line's `tasks open --category` reads a topic too. `topicKey` is that
 * command's own normalisation (`normal` in `launchpad_inbox.rs`): lower case, every run of other characters one dash,
 * no dash at either end. The two are held in step by `open-to-agents.test.mjs`, which reads the Rust file.
 *
 * Pure and alias-free: `open-to-agents.test.mjs` drives it under `node --test`.
 */

/** The topic words that mean AI agents or tools. Each is compared by its `topicKey`. */
const AGENT_TOPICS = ["AI agents", "AI agent or tool"] as const;

/** A topic or category as the command line compares it: `AI agent or tool` is `ai-agent-or-tool`. */
export function topicKey(word: string): string {
  let out = "";
  for (const char of word.trim().toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(char)) out += char;
    else if (!out.endsWith("-")) out += "-";
  }
  return out.replace(/^-+|-+$/g, "");
}

const AGENT_KEYS = new Set(AGENT_TOPICS.map(topicKey));

/** Whether a project's category is one of the AI categories. A project with none is not. */
export function isAgentCategory(category: string | null | undefined): boolean {
  return typeof category === "string" && AGENT_KEYS.has(topicKey(category));
}

/**
 * The requests of AI projects when `only` is set, otherwise all of them, in the order given. `categoryOf` says what a
 * request's project is listed under (null when it is not known), because a request itself carries no category.
 */
export function byAgentOpen<
  T extends { project: { id: string; author: string } },
>(
  requests: readonly T[],
  only: boolean,
  categoryOf: (project: { id: string; author: string }) => string | null,
): T[] {
  return only
    ? requests.filter((request) => isAgentCategory(categoryOf(request.project)))
    : [...requests];
}
