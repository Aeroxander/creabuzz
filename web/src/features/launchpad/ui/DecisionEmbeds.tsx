/**
 * Live cards for the decisions linked to in some text, shown under it.
 *
 * This is the light part, safe to use anywhere text is shown (chat, boards,
 * posts): it only looks for this site's own decision links, and loads the card
 * (and with it the chain code) when there is one to show.
 */

import { lazy, Suspense, useMemo } from "react";

import { findDecisionLinks } from "../lib/decision-link";

const DecisionEmbed = lazy(() =>
  import("./DecisionEmbed").then((m) => ({ default: m.DecisionEmbed })),
);

export function DecisionEmbeds({ text }: { text: string }) {
  const links = useMemo(
    () => findDecisionLinks(text, window.location.origin),
    [text],
  );
  if (links.length === 0) return null;
  return (
    <div data-testid="decision-embeds">
      {links.map((link) => (
        <Suspense fallback={null} key={`${link.launchId}|${link.decisionId}`}>
          <DecisionEmbed link={link} />
        </Suspense>
      ))}
    </div>
  );
}
