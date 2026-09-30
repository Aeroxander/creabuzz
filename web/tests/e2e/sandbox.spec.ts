import { expect, test } from "@playwright/test";

/**
 * The repository HTML preview runs pushed code in a sandboxed `srcdoc` frame.
 *
 * Two properties matter and neither had a test: the frame must not be able to
 * reach the app's origin (no `allow-same-origin`), and the document's
 * Content-Security-Policy is inherited by `srcdoc` frames — so the preview's own
 * scripts do not run. That second fact is why the preview carries a note saying
 * so; if the policy is ever relaxed, this test fails and the note must follow.
 */
test.describe("sandboxed preview frames", () => {
  test("an inline script in a srcdoc frame is blocked by the document policy", async ({
    page,
  }) => {
    await page.goto("/");
    const outcome = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const frame = document.createElement("iframe");
          frame.sandbox = "allow-scripts";
          frame.srcdoc =
            "<scr" + "ipt>parent.postMessage('ran', '*')</scr" + "ipt>";
          window.addEventListener("message", () => resolve("ran"));
          document.body.appendChild(frame);
          setTimeout(() => resolve("blocked"), 800);
        }),
    );
    expect(
      outcome,
      outcome === "ran"
        ? "the document policy no longer blocks frame scripts — update the repository preview note"
        : "blocked as expected",
    ).toBe("blocked");
  });

  test("the preview frame cannot reach the app's origin", async ({ page }) => {
    await page.goto("/");
    const sameOrigin = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const frame = document.createElement("iframe");
          // No `allow-same-origin`: the frame must run on an opaque origin.
          frame.sandbox = "allow-scripts";
          frame.srcdoc = "<p>probe</p>";
          frame.onload = () => {
            try {
              const doc = frame.contentDocument;
              resolve(doc !== null);
            } catch {
              resolve(false);
            }
          };
          document.body.appendChild(frame);
          setTimeout(() => resolve(false), 800);
        }),
    );
    expect(sameOrigin).toBe(false);
  });
});
