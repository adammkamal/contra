import { expect, test } from "@playwright/test";
import { API, apiSession, presenterStep, shot, signIn, signOut, stepText, useWorkspace } from "./helpers.ts";

// The live workspace against the harness: made-up Gmail messages, a fake extractor and a memo sender that
// fails once. Nothing here touches the network. A PM does the PM's steps; a controller approves the credit.
test("live inbox: status in words, choose a subcontract, notice, credit, memo failed then sent again", async ({ page }) => {
  await page.goto("/inbox");
  await signIn(page, "pm");
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
  // The verified PDF sentence has the plain quote style; nothing from a photo does.
  await expect(pdfRow.locator(".quote")).toContainText("BC-7611: corridor wall repair, Summit, $1,250.00.");
  await expect(pdfRow.getByTestId("image-reading-BC-7611")).toHaveCount(0);

  // Before the PM confirms, the API withholds the model's reading of the photo ($604.00): amount and
  // sourceSentence are "" and photoAmount is null, on the row and on the detail. The UI renders that as is.
  // (Read straight from the API with the test's own session; the browser only ever talks to the UI.)
  const headers = { cookie: await apiSession("pm") };
  type Row = { ref: string; amount: string; sourceSentence: string; photoAmount: { pmEntered: string; modelRead: string } | null };
  const inboxRow = async (ref: string) => ((await (await page.request.get(`${API}/screens?workspace=live`, { headers })).json()) as { inbox: Row[] }).inbox.find((r) => r.ref === ref)!;
  const detailOf = async (ref: string) => (await (await page.request.get(`${API}/backcharge/${ref}?workspace=live`, { headers })).json()) as Row;
  for (const r of [await inboxRow("BC-7612"), await detailOf("BC-7612")]) {
    expect(r.amount).toBe("");
    expect(r.sourceSentence).toBe("");
    expect(r.photoAmount).toBeNull();
  }
  const main = page.locator("main");
  await expect(photoRow.getByTestId("hidden-reading-BC-7612")).toBeVisible();
  await expect(photoRow.locator(".quote")).toHaveCount(0);
  await expect(photoRow.getByTestId("image-reading-BC-7612")).toHaveCount(0);
  await expect(main).not.toContainText("604.00");
  await expect(main).not.toContainText("640.00");
  await shot(page, "live-01b-attachments");
  for (const path of ["/backcharge/BC-7612", "/audit", "/pm-queue"]) {
    await page.goto(path);
    await expect(main).not.toContainText("604.00");
    await expect(main).not.toContainText("640.00");
  }
  await page.goto("/backcharge/BC-7612");
  await expect(page.getByTestId("hidden-reading")).toBeVisible();
  await expect(page.getByTestId("highlight")).toHaveCount(0);
  await expect(page.getByTestId("image-source-note")).toContainText("Check it against attachment IMG_2041.png in the original email");
  await shot(page, "live-01e-detail-photo-before-confirm");
  await page.goto("/inbox");

  // Items not taken in: a row of its own kind. The reason in words, subject, sender and attachments; no amount,
  // no button, no detail link.
  const rejected = page.getByTestId("rejected-row-0");
  await expect(rejected).toContainText("Not taken in");
  await expect(rejected).toContainText("Held: not taken in: the model said the amount is on page 3 of estimate.pdf, which has only 2 pages; a person must read the email");
  await expect(rejected).toContainText("Summit - estimate and ticket photo attached");
  await expect(rejected).toContainText("Dana Ortiz");
  await expect(page.getByTestId("rejected-attachments-0")).toContainText("attachment IMG_2042.heic skipped");
  await expect(rejected.getByRole("link")).toHaveCount(0);
  await expect(rejected.getByRole("button")).toHaveCount(0);
  await expect(rejected).not.toContainText("$");
  await shot(page, "live-01f-rejected-row");

  // The form: an amount field (empty, never prefilled with the model's reading) and the subcontract (one
  // option here, preselected). Confirm waits for an amount; an amount of zero is refused in words (409) and
  // the item stays held.
  const amount = page.getByTestId("confirmImageAmount-BC-7612-amount");
  await expect(amount).toHaveValue("");
  await expect(page.getByTestId("confirmImageAmount-BC-7612")).toBeDisabled();
  await amount.fill("$0.00");
  await page.getByTestId("confirmImageAmount-BC-7612").click();
  await expect(photoRow.getByRole("alert")).toContainText("the amount must be more than $0.00; nothing changed and BC-7612 stays held");
  await expect(photoRow).toContainText("Held: amount read from a photo");
  await shot(page, "live-01c-image-amount-refused");
  // The PM types what the photo says ($640.00); the model read $604.00. Both are shown afterwards.
  await amount.fill("640.00");
  await page.getByTestId("confirmImageAmount-BC-7612").click();
  await expect(photoRow).not.toContainText("Held:");
  await expect(page.getByTestId("confirmImageAmount-BC-7612")).toHaveCount(0);
  await expect(page.getByTestId("amount-BC-7612")).toHaveText("$640.00");
  await expect(page.getByTestId("amount-difference-BC-7612")).toHaveText("PM entered $640.00 (model read $604.00 from the photo)");
  const reading = page.getByTestId("image-reading-BC-7612");
  await expect(reading).toContainText("Model's reading of the photo, not checked word for word");
  await expect(reading).toContainText("BC-7612 FLOOR PROTECTION $604.00");
  await expect(photoRow.locator(".quote")).toHaveCount(0); // not the verified-quote style
  // Server side: the PM's amount is the item's amount, with both readings in photoAmount.
  for (const r of [await inboxRow("BC-7612"), await detailOf("BC-7612")]) {
    expect(r.amount).toBe("$640.00");
    expect(r.sourceSentence).toBe("BC-7612 FLOOR PROTECTION $604.00");
    expect(r.photoAmount).toEqual({ pmEntered: "$640.00", modelRead: "$604.00" });
  }
  // A text item is untouched: its amount and sentence are there, and photoAmount is null.
  expect(await inboxRow("BC-7611")).toMatchObject({ amount: "$1,250.00", photoAmount: null });
  await shot(page, "live-01g-photo-confirmed");

  // The detail screens: the PDF's page is shown with the sentence highlighted; the photo's reading is labelled,
  // styled apart and never highlighted.
  await page.goto("/backcharge/BC-7611");
  await expect(page.getByTestId("source-location")).toHaveText("Source: attachment estimate.pdf, page 2");
  await expect(page.getByTestId("highlight")).toContainText("BC-7611: corridor wall repair, Summit, $1,250.00.");
  await expect(page.getByTestId("detail-attachments")).toContainText("attachment IMG_2042.heic skipped");
  await shot(page, "live-01d-detail-pdf");
  await page.goto("/backcharge/BC-7612");
  await expect(page.getByTestId("detail-amount")).toHaveText("$640.00");
  await expect(page.getByTestId("amount-difference")).toHaveText("PM entered $640.00 (model read $604.00 from the photo)");
  await expect(page.getByTestId("image-reading")).toContainText("Model's reading of the photo, not checked word for word");
  await expect(page.getByTestId("highlight")).toHaveCount(0);
  await shot(page, "live-01h-detail-photo-confirmed");

  // The PM queue lists the item not taken in without a link to a detail screen.
  await page.goto("/pm-queue");
  await expect(page.getByTestId("pm-queue-rejected-0")).toContainText("Held: not taken in:");
  await expect(page.getByTestId("pm-queue-rejected-0").getByRole("link")).toHaveCount(0);
  await page.goto("/inbox");

  const steps: string[] = [];
  for (let i = 0; i < 20; i++) {
    // The controller sees, above Approve, the amount the PM typed and what the model read.
    if ((await stepText(page).textContent())?.startsWith("Controller approves credit")) {
      await page.goto("/credits");
      await expect(page.getByTestId("amount-notes-VC-1")).toContainText("BC-7612: amount confirmed by");
      await expect(page.getByTestId("amount-notes-VC-1")).toContainText("from attachment IMG_2041.png (PM entered $640.00; model read $604.00)");
      await expect(page.getByTestId("approveCredit-VC-1")).toBeVisible();
      await shot(page, "live-02b-credit-amount-notes");
      // The PM may not approve it: the API refuses (409) in words, and nothing changes.
      await page.getByTestId("approveCredit-VC-1").click();
      await expect(page.getByRole("alert").filter({ hasText: "approving credit VC-1" })).toHaveText("approving credit VC-1 needs the Controller role; e2e.pm is a PM");
      await expect(page.getByTestId("approveCredit-VC-1")).toBeVisible();
      await shot(page, "live-02c-pm-may-not-approve");
      // A controller, who neither raised nor linked any of its back-charges, approves it.
      await signOut(page);
      await signIn(page, "controller");
      await expect(page.getByTestId("signed-in-role")).toHaveText("Controller");
      await useWorkspace(page, "live");
    }
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
