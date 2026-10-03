import type { LaunchParamIssue } from "../../lib/launch-params";

/** The contract's rules a publish would break, warnings included. */
export function ParamIssueList({
  issues,
}: {
  issues: readonly LaunchParamIssue[];
}) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-2 space-y-0.5 text-xs" data-testid="launch-param-issues">
      {issues.map((issue) => (
        <li
          className={
            issue.severity === "error"
              ? "text-red-600 dark:text-red-400"
              : "text-amber-700 dark:text-amber-300"
          }
          key={`${issue.field}-${issue.message}`}
        >
          {issue.severity === "error" ? "✗ " : "! "}
          {issue.field}: {issue.message}
        </li>
      ))}
    </ul>
  );
}
