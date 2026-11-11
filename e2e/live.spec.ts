import { expect, test } from "@playwright/test";
import { presenterStep, shot, stepText, useWorkspace } from "./helpers.ts";

// The live workspace against the harness: made-up Gmail messages, a fake extractor and a memo sender that
// fails once. Nothing here touches the network.
test("live inbox: status in words, choose a subcontract, notice, credit, memo failed then sent again", async ({ page }) => {
  await page.goto("/inbox");
  await useWorkspace(page, "live");
  await expect(page.getByTestId("live-badge")).toHaveText("Live inbox");
  await expect(page.getByTestId("intake-address")).toHaveText("demo.tester+backcharges@example.com");
  await expect(page.getByTestId("inbox-word")).toHaveText("Inbox OK");
  await expect(page.locator("main").getByTestId("sample-data")).toHaveCount(0); // the demo's badge isn't on live screens
  await expect(page.getByTestId("inbox-row-BC-7401")).toContainText("$900.00");
  await expect(page.getByTestId("inbox-row-BC-7402")).toContainText("PM must choose the subcontract");
  await shot(page, "live-01-inbox");

  // "Ridgeline" alone is ambiguous on Summit: the PM picks the subcontract in the row.
  await page.getByTestId("chooseSubcontract-BC-7402-choice").selectOption("SC-SUM-0912");
  await page.getByTestId("chooseSubcontract-BC-7402").click();
  await expect(page.getByTestId("inbox-row-BC-7402")).toContainText("Linked");

  const steps: string[] = [];
  for (let i = 0; i < 20; i++) {
    const step = await presenterStep(page);
    if (step === null) break;
    steps.push(step);
    if (step.startsWith("Send notice")) {
      await page.goto("/outbox");
      await expect(page.locator('[data-testid^="notice-total-"]')).toHaveText("$1,550.00");
      await shot(page, "live-02-notice");
    }
  }
  expect(steps).toContain("Wait for the response window: advance a week (moves this workspace 7 days ahead of real time)");
  expect(steps.at(-1)).toBe("Send the credit memo for VC-1 to the AP inbox");
  await expect(stepText(page)).toHaveText("Waiting for back-charge emails from the live inbox");

  // The first send failed (the harness's sender fails once): the status says so, and the row offers it again.
  await page.goto("/credits");
  await expect(page.getByTestId("credit-amount-VC-1")).toHaveText("$1,550.00");
  await expect(page.getByTestId("memo-status-VC-1")).toHaveText("Memo not sent: Gmail API error (HTTP 500). You can send it again.");
  await shot(page, "live-03-memo-failed");
  await page.getByTestId("sendCreditMemo-VC-1").click();
  await expect(page.getByTestId("memo-status-VC-1")).toHaveText("Memo sent to demo.tester+ramp-ap@example.com");
  await expect(page.getByTestId("sendCreditMemo-VC-1")).toHaveCount(0);
  await shot(page, "live-04-memo-sent");

  // The scripted demo is a separate workspace: switching back shows its own state, untouched.
  await useWorkspace(page, "demo");
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-row-BC-7401")).toHaveCount(0);
});
