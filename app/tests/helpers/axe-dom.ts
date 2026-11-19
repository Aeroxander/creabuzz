/**
 * axe-core against the DOM a unit test renders (jsdom): the colours and layout are not there to judge, so those rules are
 * off, and what is left (names, roles, labels, ids, headings, landmarks) must have no serious or critical violation.
 * axe-core is reached through the Playwright package that depends on it.
 */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

interface Violation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: { html: string }[];
}
interface Axe {
  run(
    context: Element,
    options: { rules: Record<string, { enabled: boolean }> },
  ): Promise<{ violations: Violation[] }>;
}

function loadAxe(): Axe {
  // The package's own folder (its `exports` hide package.json), where axe-core is installed beside it.
  const folder = realpathSync(
    resolve(__dirname, "../../node_modules/@axe-core/playwright"),
  );
  return createRequire(`${folder}/`)("axe-core") as Axe;
}

/** The serious and critical violations in `root` as readable lines; empty when there are none. */
export async function seriousViolations(
  root: Element = document.body,
): Promise<string[]> {
  const results = await loadAxe().run(root, {
    rules: {
      "color-contrast": { enabled: false },
      "link-in-text-block": { enabled: false },
      region: { enabled: false },
    },
  });
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id}: ${v.help} (${v.nodes.map((n) => n.html.slice(0, 120)).join(" | ")})`,
    );
}
