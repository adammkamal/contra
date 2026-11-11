import { expect, test } from "@playwright/test";
import { stepText, useWorkspace } from "./helpers.ts";

// Server-Sent Events: a second browser showing the demo updates by itself when the first one acts.
test("real time: another browser's action refreshes this one's screens without a reload", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await a.goto("/");
  await useWorkspace(a, "demo");
  await a.getByTestId("resetDemo").click();
  await expect(stepText(a)).toHaveText("Ingest the PM's back-charge emails");

  await b.goto("/");
  await useWorkspace(b, "demo");
  await expect(b.getByTestId("live-updates")).toHaveAttribute("data-connected", "yes");
  await expect(stepText(b)).toHaveText("Ingest the PM's back-charge emails");
  // A marker that a reload would wipe out.
  await b.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));

  await a.getByTestId("presenter-ingestPmEmails").click();
  await expect(stepText(a)).toHaveText("PM confirms the link for BC-4467");
  // b never reloaded: the screens-changed event made it re-fetch.
  await expect(stepText(b)).toHaveText("PM confirms the link for BC-4467");
  expect(await b.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
});
