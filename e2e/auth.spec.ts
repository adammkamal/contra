import { expect, test } from "@playwright/test";
import { ACCOUNTS } from "./accounts.ts";
import { API, shot, signIn, signOut } from "./helpers.ts";

// Signing in through the real sign-in page against the harness's accounts (e2e/accounts.ts). The browser
// only talks to the UI; the UI's server keeps the API session in an HttpOnly cookie on its own origin.

test("signed out, any screen opens the sign-in page; after signing in it returns to that screen", async ({ page }) => {
  await page.goto("/credits");
  await expect(page).toHaveURL(/\/login\?next=%2Fcredits$/);
  await expect(page.getByTestId("signed-in")).toHaveCount(0);
  await expect(page.getByTestId("session-ended")).toHaveCount(0); // never signed in: nothing "ended"
  await shot(page, "auth-01-sign-in");
  await signIn(page, "presenter");
  await expect(page).toHaveURL(/\/credits$/);
  await expect(page.getByTestId("signed-in-role")).toHaveText("PM");
  // The session cookie is the UI's own and HttpOnly: page scripts can't read it.
  const session = (await page.context().cookies()).find((c) => c.name === "contra_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.domain).toBe("localhost");
  expect(await page.evaluate(() => document.cookie)).not.toContain("contra_session");
});

test("a wrong password shows the API's words, keeps the username and clears the password", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("sign-in-username").fill(ACCOUNTS.presenter.username);
  await page.getByTestId("sign-in-password").fill("not the password at all");
  await page.getByTestId("sign-in-submit").click();
  await expect(page.getByTestId("sign-in-error")).toHaveText("wrong username or password");
  await expect(page.getByTestId("sign-in-username")).toHaveValue(ACCOUNTS.presenter.username);
  await expect(page.getByTestId("sign-in-password")).toHaveValue("");
  await expect(page).toHaveURL(/\/login$/);
  await shot(page, "auth-02-wrong-password");
});

test("sign out ends the session: the rail's button, then every screen asks to sign in again", async ({ page }) => {
  await page.goto("/inbox");
  await signIn(page, "presenter");
  await expect(page.getByTestId("signed-in")).toContainText("Signed in as");
  await signOut(page);
  expect((await page.context().cookies()).find((c) => c.name === "contra_session")).toBeUndefined();
  await page.goto("/inbox");
  await expect(page).toHaveURL(/\/login\?next=%2Finbox$/);
});

test("a session that ended on the server: the next screen opens the sign-in page, saying so, and comes back", async ({ page }) => {
  await page.goto("/outbox");
  await signIn(page, "presenter");
  // End this browser's session on the API directly (as an expiry would); the browser still has its cookie.
  const id = (await page.context().cookies()).find((c) => c.name === "contra_session")!.value;
  expect((await fetch(`${API}/logout`, { method: "POST", headers: { "content-type": "application/json", cookie: `contra_session=${id}` }, body: "{}" })).status).toBe(200);
  // The page's own link prefetches (fired just after sign-in) can meet the ended session at the same moment
  // and abort this navigation in Chrome; either way the browser must land on the sign-in page, saying so.
  await page.goto("/outbox").catch((e: unknown) => {
    if (!String(e).includes("net::ERR_ABORTED")) throw e;
  });
  await expect(page).toHaveURL(/\/login\?ended=1&next=%2Foutbox$/);
  await expect(page.getByTestId("session-ended")).toHaveText("Your session has ended; sign in again.");
  await shot(page, "auth-03-session-ended");
  await signIn(page, "presenter");
  await expect(page).toHaveURL(/\/outbox$/);
});

test("an account without live access: the switch is disabled with the API's reason, and its 403 is shown", async ({ page }) => {
  const reason = "the live workspace is only for accounts created with --live";
  await page.goto("/");
  await signIn(page, "presenter");
  await expect(page.getByTestId("workspace-live")).toBeDisabled();
  await expect(page.getByTestId("workspace-live")).toHaveAttribute("title", reason);
  await expect(page.getByTestId("workspace-live-refusal")).toHaveText(`Live inbox: ${reason}`);
  // A workspace cookie left at "live" (say, by a live account on this browser): the screens show the 403.
  await page.context().addCookies([{ name: "contra-workspace", value: "live", domain: "localhost", path: "/" }]);
  await page.goto("/inbox");
  await expect(page.getByTestId("screens-error")).toHaveText(reason);
  await expect(page.getByTestId("workspace-live")).toBeDisabled();
  await shot(page, "auth-04-live-refused");
  await page.getByTestId("workspace-demo").click();
  await expect(page.getByTestId("workspace-demo")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("screens-error")).toHaveCount(0);
});
