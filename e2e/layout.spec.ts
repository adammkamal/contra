import { expect, test, type Page } from "@playwright/test";
import { signIn, viewShot } from "./helpers.ts";

// The next-step bar stays on screen while the page scrolls. Scrolled to the bottom, the last row of every
// screen must be fully in view and not under the bar. Run at the default width and at 390 px (E2E_WIDTH=390).

const SCREENS = ["/", "/inbox", "/outbox", "/pm-queue", "/credits", "/audit", "/try", "/backcharge/BC-4470"];
const ROWS = "main article, main .card, main .item, main tr, main li, main .story-cell, main form, main p";

/** The last visible row of main, and the bar, after scrolling to the very bottom. */
async function bottomOf(page: Page) {
  // Table rows use content-visibility: auto, so a row only takes its real height once it has been painted on
  // screen, and the page grows as they are. Scroll down with the wheel, as a person would, until it stops moving.
  let last = -1;
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(150);
    const y = await page.evaluate(() => window.scrollY);
    if (y === last) break;
    last = y;
  }
  return page.evaluate((sel) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((e) => e.offsetParent !== null && e.getBoundingClientRect().height > 0);
    const last = rows.at(-1)!;
    const r = last.getBoundingClientRect();
    const b = document.querySelector("header.presenter")!.getBoundingClientRect();
    return { row: { top: r.top, bottom: r.bottom, text: (last.textContent ?? "").slice(0, 60) }, bar: { top: b.top, bottom: b.bottom }, viewport: window.innerHeight };
  }, ROWS);
}

test("scrolled to the bottom, the last row of every screen is in view and clear of the next-step bar", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); // no entrance animation while measuring
  await page.goto("/inbox");
  await signIn(page, "presenter");
  await page.getByTestId("workspace-demo").click();
  // The demo has rows once its emails are in (demo.spec usually ran first; if not, ingest them).
  if ((await page.locator('[data-testid^="inbox-row-"]').count()) === 0) await page.getByTestId("presenter-ingestPmEmails").click();
  await expect(page.locator('[data-testid^="inbox-row-"]').first()).toBeVisible();

  for (const path of SCREENS) {
    await page.goto(path);
    await expect(page.getByTestId("next-step")).toBeVisible();
    const { row, bar, viewport } = await bottomOf(page);
    const where = `${path}: last row "${row.text}" at ${Math.round(row.top)}-${Math.round(row.bottom)}, bar at ${Math.round(bar.top)}-${Math.round(bar.bottom)}, viewport ${viewport}`;
    expect(row.bottom, where).toBeLessThanOrEqual(viewport);
    // The bar sits at the top while scrolling. A row that fits in the room below it must be wholly below it; a
    // row taller than that room (a notice body) must at least end below it, so its last part is readable.
    const room = viewport - bar.bottom;
    if (row.bottom - row.top <= room) expect(row.top, where).toBeGreaterThanOrEqual(bar.bottom);
    else expect(row.bottom - bar.bottom, where).toBeGreaterThanOrEqual(Math.min(room, 200));
    if (path === "/inbox") await viewShot(page, "layout-inbox-bottom");
  }
});
