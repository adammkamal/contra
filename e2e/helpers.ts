import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const SHOTS = join("e2e", "screenshots", ...(process.env.E2E_WIDTH ? [`w${process.env.E2E_WIDTH}`] : []));
mkdirSync(SHOTS, { recursive: true });

export async function shot(page: Page, name: string): Promise<string> {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

export const stepText = (page: Page) => page.getByTestId("next-step-text");

export async function useWorkspace(page: Page, ws: "demo" | "live") {
  const btn = page.getByTestId(`workspace-${ws}`);
  if ((await btn.getAttribute("aria-pressed")) !== "true") {
    await btn.click();
    await expect(btn).toHaveAttribute("aria-pressed", "true");
  }
}

/**
 * Clicks the presenter bar's highlighted button and waits for the next step to change. Returns the step's
 * text, or null when the bar offers no button.
 */
export async function presenterStep(page: Page): Promise<string | null> {
  const btn = page.locator('header button[data-testid^="presenter-"]');
  if ((await btn.count()) === 0) return null;
  const before = (await stepText(page).textContent()) ?? "";
  await btn.click();
  await expect(stepText(page)).not.toHaveText(before);
  return before;
}
