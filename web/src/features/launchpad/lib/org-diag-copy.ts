/**
 * Plain words for the team health check. The figures come from
 * `@creaton/core/launchpad/org-diag.ts`, which the command line shares, so its
 * raw mode names, status words and reading sentences are mapped here rather
 * than changed there. Unknown values fall back to the original text, never to
 * a guess.
 */

const MODE_COPY: Record<string, { label: string; meaning: string }> = {
  "orchestration-drift": {
    label: "Waiting for permission",
    meaning: "Actions that had to wait for someone to approve them.",
  },
  "semantic-misalignment": {
    label: "Work taken back",
    meaning: "Posts or drafts that were withdrawn after the fact.",
  },
  "security-trust-gaps": {
    label: "Access removed",
    meaning: "Moments when someone's access or standing was taken away.",
  },
  "cascading-effects": {
    label: "Knock-on activity",
    meaning: "A burst of activity right after something was withdrawn.",
  },
  "systemic-complexity": {
    label: "Repeated rewrites",
    meaning: "The same item changed again and again.",
  },
};

const STATUS_WORDS: Record<string, string> = {
  calm: "no concern",
  watch: "worth watching",
  flag: "needs a look",
  saturated: "overloaded",
};

/** A health-check name in words a newcomer can read. */
export function modeCopy(mode: string): { label: string; meaning: string } {
  return MODE_COPY[mode] ?? { label: mode, meaning: "" };
}

/** A status word in plain words. */
export function statusWord(status: string): string {
  return STATUS_WORDS[status] ?? status;
}

const READINGS: readonly (readonly [string, string])[] = [
  [
    "coordination-consistent timing",
    "Activity comes in rushes, and people often act soon after one another. That is a pattern in the timing, not proof the team is working together.",
  ],
  [
    "bursty timing without",
    "Activity comes in rushes, but people rarely act soon after one another. Shared deadlines also look like this.",
  ],
  [
    "no timing coordination pattern",
    "No pattern in the timing of activity in this period.",
  ],
  [
    "talk without decisions",
    "There is talk but no decisions in this period. A busy channel is not the same as a team that decides.",
  ],
  [
    "institutions exist but",
    "Decisions are being made, but talk makes up most of the activity. What binds future action matters more than what is said.",
  ],
  [
    "institutionalization present",
    "Proposals, votes and approvals are shaping what the team does next.",
  ],
  [
    "churning:",
    "Most edits rework the same items. That is effort without much progress.",
  ],
  ["settled:", "Most items were written once and left alone."],
  [
    "mixed:",
    "A mix of rework and finished items. The counts above are the honest read.",
  ],
];

/** One reading sentence from the shared report, in plain words. */
export function readingCopy(reading: string): string {
  for (const [prefix, plain] of READINGS) {
    if (reading.startsWith(prefix)) return plain;
  }
  return reading;
}
