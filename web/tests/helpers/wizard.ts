// Shared e2e helper: the create-launch wizard gates "Publish launch" behind its
// steps (the footer shows "Continue" until the final step, and a step with
// issues disables it). Walk there once — supplying the token step's fields and
// adopting an unlock preset when the current step complains, so navigation
// never depends on test order. Tests that care about specific values fill them
// themselves before or after; their fills win.
import type { Page } from "@playwright/test";

export async function wizardToPublish(page: Page): Promise<void> {
  // Already there? (repeat calls in one test) — done before touching fields.
  const publish = page.getByRole("button", { name: /Publish launch/ });
  if (await publish.isVisible().catch(() => false)) return;
  const step = page.getByTestId("wizard-step-token");
  const name = step.getByRole("textbox", { name: "Name", exact: true });
  if ((await name.inputValue().catch(() => "")) === "") {
    await name.fill("Test Launch");
  }
  const symbol = step.getByLabel("Symbol");
  if ((await symbol.inputValue().catch(() => "")) === "") {
    await symbol.fill("TST");
  }
  const supply = step.getByLabel(/supply/i);
  if ((await supply.inputValue().catch(() => "")) === "") {
    await supply.fill("1000000");
  }
  const quick = page.getByRole("button", { name: "Quick start defaults" });
  if (await quick.isVisible().catch(() => false)) await quick.click();
  for (let i = 0; i < 8; i++) {
    const publish = page.getByRole("button", { name: /Publish launch/ });
    if (await publish.isVisible().catch(() => false)) return;
    const next = page.getByTestId("wizard-continue");
    if (await next.isDisabled().catch(() => true)) {
      // A step is complaining: adopt the unlock preset if its rows are empty.
      const preset = page.getByRole("button", { name: "Product project" });
      if (await preset.isVisible().catch(() => false)) {
        await preset.click();
        continue;
      }
      throw new Error("the wizard step stayed invalid and offers no preset");
    }
    await next.click();
  }
  throw new Error("the wizard never reached its Publish step");
}
