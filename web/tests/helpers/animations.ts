import type { Page } from "@playwright/test";

/** Finish finite UI transitions before a screenshot; ambient animations never block capture. */
export async function waitForAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    );
  });
}
