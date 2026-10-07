import { expect, test } from "@playwright/test";

/**
 * Overlays must escape the header, not merely carry a big z-index.
 *
 * The header uses `backdrop-blur`, which makes it both a containing block and
 * a stacking context. An overlay rendered inside it is boxed into the nav's
 * rect and painted at the nav's level, so page content covers it — which is
 * exactly what happened to the passkey popup and the profile menu. Raising
 * their z-index cannot fix that; only rendering them outside the blur does.
 *
 * So the assertion is the mechanism, not a lucky pixel: an overlay that is not
 * a direct child of `document.body` is trapped again, whatever it looks like on
 * one screenshot. The paint-order check on top is the symptom it protects.
 */

const NSEC = "22".repeat(32);

async function assertFree(
  page: import("@playwright/test").Page,
  selector: string,
) {
  const el = page.locator(selector).first();
  await expect(el).toBeVisible();

  const verdict = await el.evaluate((node) => {
    const escaped = node.parentElement === document.body;
    // Sample the box, not one point: overlap happens at the edges, where the
    // card content the report named actually sits.
    const r = node.getBoundingClientRect();
    let covered = null;
    for (const fx of [0.02, 0.25, 0.5, 0.75, 0.98]) {
      for (const fy of [0.02, 0.25, 0.5, 0.75, 0.98]) {
        const hit = document.elementFromPoint(
          r.left + r.width * fx,
          r.top + r.height * fy,
        );
        if (hit && !node.contains(hit)) {
          covered = hit.className || hit.tagName;
          break;
        }
      }
      if (covered) break;
    }
    return { escaped, covered };
  });

  expect(
    verdict.escaped,
    "the overlay is still inside the page's stacking context",
  ).toBe(true);
  expect(
    verdict.covered,
    "page content is painted over the overlay",
  ).toBeNull();
}

test("the profile menu is free of the header and above the cards", async ({
  page,
}) => {
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [NSEC],
  );
  await page.goto("/launchpad");
  await page.getByTestId("user-chip").click();
  await assertFree(page, '[data-testid="profile-popover"]');
});

test("the create-identity popup is free of the header and above the cards", async ({
  page,
}) => {
  await page.goto("/launchpad");
  await page.getByTestId("create-identity-cta").click();
  await assertFree(page, '[data-testid="onboarding-dialog"]');
});
