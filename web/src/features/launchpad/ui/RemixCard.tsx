import { Link } from "@tanstack/react-router";

import { Card } from "@/shared/ui/card";
import { offersLine, remixFit } from "../lib/remix";
import { remixesOffered } from "../lib/remixes-offered";
import type { Launch } from "../models";
import { useLaunches } from "../use-launches";
import { RemixBondPanel } from "./RemixBondPanel";

/**
 * Where a project comes from and what was built on it (N11): the project it is built on, whether its licence fits that
 * project's, the projects built on this one, and this project's own terms. No money moves; nothing here is enforced.
 * Shown only when there is something to say, and never in a contributor-only build (`remixesOffered`).
 */
export function RemixCard({ launch }: { launch: Launch }) {
  return remixesOffered() ? <RemixCardBody launch={launch} /> : null;
}

function RemixCardBody({ launch }: { launch: Launch }) {
  const { record } = launch;
  const launches = useLaunches();
  const all = launches.data ?? [];
  const parent = record.builtOn
    ? all.find(
        (l) =>
          l.record.author === record.builtOn?.author &&
          l.record.id === record.builtOn?.id,
      )
    : undefined;
  const children = all.filter(
    (l) =>
      l.record.builtOn?.author === record.author &&
      l.record.builtOn?.id === record.id,
  );
  const terms = record.remixTerms;
  // A project that is built on nothing, has nothing built on it and invites nobody has nothing to say here.
  if (!record.builtOn && children.length === 0 && !terms?.invited) return null;
  const fit = parent
    ? remixFit(
        parent.record.name,
        {
          ipRecord: parent.record.ipRecord,
          remixTerms: parent.record.remixTerms,
        },
        { ipRecord: record.ipRecord },
      )
    : null;
  const offers = terms?.invited ? offersLine(terms.offers) : null;
  return (
    <Card className="flex flex-col gap-2 p-4 text-sm" data-testid="remix-card">
      <h2 className="text-base font-semibold">Where it comes from</h2>
      {record.builtOn ? (
        parent ? (
          <>
            <p data-testid="remix-built-on">
              Built on{" "}
              <Link
                className="font-medium underline"
                params={{ launchId: parent.record.id }}
                search={{ action: undefined, author: parent.record.author }}
                to="/launchpad/$launchId"
              >
                {parent.record.name}
              </Link>
              .
            </p>
            {fit ? (
              <p
                className={
                  fit.kind === "fits"
                    ? "text-muted-foreground"
                    : "text-amber-700 dark:text-amber-300"
                }
                data-testid="remix-fit"
              >
                {fit.line}
              </p>
            ) : null}
            <RemixBondPanel parent={parent} remix={launch} />
          </>
        ) : (
          <p className="text-muted-foreground" data-testid="remix-built-on">
            Built on a project that isn't listed here.
          </p>
        )
      ) : null}
      {children.length > 0 ? (
        <p data-testid="remix-children">
          Built on this:{" "}
          {children.map((child, i) => (
            <span key={`${child.record.author}:${child.record.id}`}>
              {i > 0 ? ", " : ""}
              <Link
                className="underline"
                params={{ launchId: child.record.id }}
                search={{ action: undefined, author: child.record.author }}
                to="/launchpad/$launchId"
              >
                {child.record.name}
              </Link>
            </span>
          ))}
          .
        </p>
      ) : null}
      {terms ? (
        <p className="text-muted-foreground" data-testid="remix-terms">
          {terms.invited
            ? `Others may build on this project.${terms.asks ? ` It asks: ${terms.asks}` : ""}${offers ? ` ${offers}` : ""}`
            : "This project doesn't invite others to build on it."}
        </p>
      ) : null}
    </Card>
  );
}
