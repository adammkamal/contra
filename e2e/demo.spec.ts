import { expect, test } from "@playwright/test";
import { presenterStep, shot, stepText, useWorkspace } from "./helpers.ts";

// The scripted demo (SPEC section 3), driven only through the presenter bar, against the API.
test("scripted demo: notice $15,500.00, credit $11,500.00, bill pays $36,500.00", async ({ page }) => {
  await page.goto("/");
  await useWorkspace(page, "demo");
  await page.getByTestId("resetDemo").click();
  await expect(stepText(page)).toHaveText("Ingest the PM's back-charge emails");
  await expect(page.getByTestId("sample-data").first()).toBeVisible(); // presenter badge and opener badge
  await expect(page.locator("main").getByTestId("sample-data")).toBeVisible();
  await shot(page, "demo-00-opener");

  const steps: string[] = [];
  for (let i = 0; i < 30; i++) {
    const step = await presenterStep(page);
    if (step === null) break;
    steps.push(step);

    if (step === "Ingest the PM's back-charge emails") {
      await page.goto("/inbox");
      for (const [ref, amount] of [["BC-4467", "$6,800.00"], ["BC-4468", "$4,700.00"], ["BC-4470", "$2,750.00"], ["BC-4471", "$4,000.00"]] as const) {
        await expect(page.getByTestId(`inbox-row-${ref}`)).toContainText(amount);
      }
      await expect(page.getByTestId("extraction-source")).toBeVisible();
      await shot(page, "demo-01-inbox");
    }
    if (step === "Send the notice") {
      await page.goto("/outbox");
      await expect(page.getByTestId("notice-total-N-1")).toHaveText("$15,500.00");
      await expect(page.getByTestId("notice-N-1")).not.toContainText("BC-4470");
      await shot(page, "demo-02-notice");
      await page.goto("/backcharge/BC-4470");
      await expect(page.locator("main")).toContainText("dispute noted in the PM's email");
      await expect(page.getByTestId("highlight")).toBeVisible();
      await shot(page, "demo-03-detail-BC-4470");
    }
    if (step === "Ridgeline replies") {
      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-row-BC-4471")).toContainText("disputed by the sub");
      await shot(page, "demo-04-sub-reply");
    }
    if (step === "Controller approves credit VC-1") {
      await page.goto("/credits");
      await expect(page.getByTestId("credit-amount-VC-1")).toHaveText("$11,500.00");
      await expect(page.getByTestId("simulated-ramp").first()).toBeVisible();
      await shot(page, "demo-05-credit");
    }
  }

  await expect(stepText(page)).toHaveText("Demo complete");
  expect(steps[0]).toBe("Ingest the PM's back-charge emails");
  expect(steps.at(-1)).toBe("Pay the bill (simulated)");
  await page.goto("/credits");
  await expect(page.getByTestId("credit-amount-VC-1")).toHaveText("$11,500.00");
  await expect(page.getByTestId("bill-paid-B-SUM-48K")).toHaveText("$36,500.00");
  await expect(page.getByTestId("simulated-ramp")).toHaveCount(2);
  await page.goto("/outbox");
  await expect(page.getByTestId("notice-total-N-1")).toHaveText("$15,500.00");
  await page.goto("/credits");
  await shot(page, "demo-06-paid");
});
