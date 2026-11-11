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

  // An email with a text PDF and a photo (fakes). The PDF's sentence is checked word for word and says where
  // it is; the photo's amount can't be checked, so its row is held until the PM types what they see.
  const pdfRow = page.getByTestId("inbox-row-BC-7611");
  await expect(pdfRow).toContainText("$1,250.00");
  await expect(page.getByTestId("source-location-BC-7611")).toHaveText("Source: attachment estimate.pdf, page 2");
  const attachments = page.getByTestId("attachments-BC-7611");
  await expect(attachments).toContainText("attachment estimate.pdf: PDF, 2 pages, text read");
  await expect(attachments).toContainText("attachment IMG_2041.png: photo, read by the model as an image (not verifiable word for word)");
  await expect(attachments).toContainText("attachment IMG_2042.heic skipped: ");
  const photoRow = page.getByTestId("inbox-row-BC-7612");
  await expect(page.getByTestId("source-location-BC-7612")).toHaveText("Source: attachment IMG_2041.png");
  await expect(photoRow).toContainText("Held: amount read from a photo or scanned page, which can't be checked word for word; a person must confirm it");
  await shot(page, "live-01b-attachments");

  // The form: an amount field and the subcontract (one option here, preselected). A wrong amount is refused
  // in words (409) and the item stays held; the field starts empty and Confirm waits for an amount.
  const amount = page.getByTestId("confirmImageAmount-BC-7612-amount");
  await expect(amount).toHaveValue("");
  await expect(page.getByTestId("confirmImageAmount-BC-7612")).toBeDisabled();
  await amount.fill("$600.00");
  await page.getByTestId("confirmImageAmount-BC-7612").click();
  await expect(photoRow.getByRole("alert")).toContainText("you typed $600.00, but the amount read from the image is $640.00; nothing changed and BC-7612 stays held");
  await expect(photoRow).toContainText("Held: amount read from a photo");
  await shot(page, "live-01c-image-amount-refused");
  await amount.fill("640.00");
  await page.getByTestId("confirmImageAmount-BC-7612").click();
  await expect(photoRow).not.toContainText("Held:");
  await expect(page.getByTestId("confirmImageAmount-BC-7612")).toHaveCount(0);

  // The detail screens: the PDF's page is shown with the sentence highlighted; the photo says it can't be checked.
  await page.goto("/backcharge/BC-7611");
  await expect(page.getByTestId("source-location")).toHaveText("Source: attachment estimate.pdf, page 2");
  await expect(page.getByTestId("highlight")).toContainText("BC-7611: corridor wall repair, Summit, $1,250.00.");
  await expect(page.getByTestId("detail-attachments")).toContainText("attachment IMG_2042.heic skipped");
  await shot(page, "live-01d-detail-pdf");
  await page.goto("/backcharge/BC-7612");
  await expect(page.getByTestId("image-source-note")).toContainText("Check it against attachment IMG_2041.png in the original email");
  await shot(page, "live-01e-detail-photo");
  await page.goto("/inbox");

  const steps: string[] = [];
  for (let i = 0; i < 20; i++) {
    const step = await presenterStep(page);
    if (step === null) break;
    steps.push(step);
    if (step.startsWith("Send notice")) {
      await page.goto("/outbox");
      await expect(page.locator('[data-testid^="notice-total-"]')).toHaveText("$3,440.00");
      await shot(page, "live-02-notice");
    }
  }
  expect(steps).toContain("Wait for the response window: advance a week (moves this workspace 7 days ahead of real time)");
  expect(steps.at(-1)).toBe("Send the credit memo for VC-1 to the AP inbox");
  await expect(stepText(page)).toHaveText("Waiting for back-charge emails from the live inbox");

  // The first send failed (the harness's sender fails once): the status says so, and the row offers it again.
  await page.goto("/credits");
  await expect(page.getByTestId("credit-amount-VC-1")).toHaveText("$3,440.00");
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
