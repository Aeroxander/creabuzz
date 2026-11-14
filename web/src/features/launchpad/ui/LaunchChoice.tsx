/**
 * Shown when a project link names no author and more than one person has a project with that id. An id is only unique
 * per author, so the page does not guess: it lists whose projects the link could mean and lets the reader pick.
 */

import { Link } from "@tanstack/react-router";

import { useUserNames } from "@/features/profiles/use-profiles";

export function LaunchChoice({
  launchId,
  authors,
}: {
  launchId: string;
  authors: readonly string[];
}) {
  const names = useUserNames([...authors]);
  return (
    <section
      aria-labelledby="launch-choice-heading"
      className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-16"
      data-testid="launch-choice"
    >
      <h1 className="text-lg font-bold" id="launch-choice-heading">
        Which project?
      </h1>
      <p className="text-sm text-muted-foreground">
        This link fits more than one project, by different people. Pick the one
        you were sent, or ask whoever sent it.
      </p>
      <ul className="flex flex-col gap-2">
        {authors.map((author) => (
          <li key={author}>
            <Link
              className="font-semibold underline"
              params={{ launchId }}
              search={{ author, action: undefined }}
              to="/launchpad/$launchId"
            >
              The project by {names(author)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
