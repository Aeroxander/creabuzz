/** Shared with the desktop app: the implementation lives in `@creaton/core`. */
export * from "@creaton/core/launchpad/decisionDescribe.ts";

import type {
  ActionDescription,
  DescribeContext,
} from "@creaton/core/launchpad/daoActions.ts";
import { describeDecision as describeCore } from "@creaton/core/launchpad/decisionDescribe.ts";

import { readableQuotes } from "./work-titles.ts";

/** Whose end an "Open until" line is, so it is never read as the vote's own deadline. */
const OPEN_UNTIL: Partial<Record<ActionDescription["kind"], string>> = {
  project: "Work area",
  "work-budget": "Budget",
};

/**
 * The shared description, as this app shows it: work named by its title rather than its code-style short name, and a
 * work area's own end told apart from the vote's ("Work area open until …").
 */
export function describeDecision(
  action: { to: string; data: string },
  ctx: DescribeContext = {},
): ActionDescription {
  const described = describeCore(action, ctx);
  return {
    ...described,
    title: readableQuotes(described.title),
    lines: described.lines.map((line) => {
      const readable = readableQuotes(line);
      const whose = OPEN_UNTIL[described.kind];
      return whose && readable.startsWith("Open until ")
        ? `${whose} open until ${readable.slice("Open until ".length)}`
        : readable;
    }),
  };
}
