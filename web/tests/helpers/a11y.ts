import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Runs axe on whatever `page` is showing and fails on `serious` and `critical` violations, the ones a keyboard or
 * screen-reader user cannot work around. `moderate` and `minor` findings are not gated here, so this stays a signal
 * rather than noise.
 */
export async function expectAccessible(page: Page, surface: string) {
  // A colour that is still fading in is measured half way, and fails a contrast
  // check it would pass a moment later. Let every running animation and
  // transition finish before looking.
  await page.evaluate(() =>
    Promise.all(
      // A cancelled animation rejects; that is also "finished" for this purpose.
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    blocking.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
      // The element itself and the measured reason: a bare selector sends the
      // next reader hunting through the DOM for what axe actually objected to.
      html: v.nodes.slice(0, 2).map((n) => n.html.slice(0, 200)),
      why: v.nodes[0]?.failureSummary?.replace(/\s+/g, " ").slice(0, 300),
    })),
    `${surface}: serious/critical accessibility violations`,
  ).toEqual([]);
}
