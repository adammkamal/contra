import { expect, test } from "@playwright/test";
import { shot, signIn } from "./helpers.ts";

// POST /api/try against the harness: its model call is a fake fetcher (no real model call), and its daily
// cap is 1, so the second check shows the 429 daily-cap message exactly as the API words it.
test("try panel: outcome in words, checks as Passed/Failed sentences, highlighted source, note; then the daily cap", async ({ page }) => {
  const sentence = "BC-5521: ceiling tile and grid repair, level 3 corridor, Summit MOB, $1,840.00.";
  const body = `Hi,\n\nA condensate line from the level 3 fan coil was left uncapped and leaked onto the corridor ceiling.\n\n${sentence}\n\nThanks,\nNoor Haddad\nProject Manager`;
  await page.goto("/try");
  await signIn(page, "presenter");
  await expect(page.locator("main")).toContainText("This is a live model call. Nothing is saved");
  await page.getByTestId("try-subject").fill("Summit MOB - back-charge for ceiling repair");
  await page.getByTestId("try-body").fill(body);
  await page.getByTestId("try-check").click();

  const item = page.getByTestId("try-item-BC-5521");
  await expect(item.getByTestId("try-outcome")).toHaveText("Ready for a notice to the sub");
  await expect(item.getByTestId("try-note")).not.toBeEmpty();
  await expect(item.getByTestId("highlight")).toHaveText(sentence);
  const lines = item.getByTestId("try-check-line");
  expect(await lines.count()).toBeGreaterThanOrEqual(5);
  for (const line of await lines.all()) await expect(line).toHaveText(/^(Passed|Failed) /);
  await expect(lines.filter({ hasText: "Linked to one subcontract" })).toHaveText(/^Passed /);
  await expect(item).toContainText("$1,840.00");
  await shot(page, "try-01-result");

  await page.getByTestId("try-check").click();
  await expect(page.getByTestId("try-error")).toHaveText("the daily demo cap of 1 emails is reached for everyone; it resets at midnight UTC");
  await shot(page, "try-02-daily-cap");
});
