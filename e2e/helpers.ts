import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNTS, E2E_PASSWORD, type Who } from "./accounts.ts";

export const SHOTS = join("e2e", "screenshots", ...(process.env.E2E_WIDTH ? [`w${process.env.E2E_WIDTH}`] : []));
mkdirSync(SHOTS, { recursive: true });

export async function shot(page: Page, name: string): Promise<string> {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

/** Only what's in the viewport (not the full page), e.g. a screen scrolled to its bottom. */
export async function viewShot(page: Page, name: string): Promise<string> {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

export const stepText = (page: Page) => page.getByTestId("next-step-text");

/**
 * Signs in through the real sign-in page (going there first if the page isn't on it) and waits until it
 * has left it (signed in: the rail names the account).
 */
export async function signIn(page: Page, who: Who): Promise<void> {
  if (!new URL(page.url(), "http://x").pathname.startsWith("/login")) await page.goto("/login");
  await page.getByTestId("sign-in-username").fill(ACCOUNTS[who].username);
  await page.getByTestId("sign-in-password").fill(E2E_PASSWORD);
  await page.getByTestId("sign-in-submit").click();
  await expect(page.getByTestId("signed-in-user")).toHaveText(ACCOUNTS[who].username);
}

/** "Sign out" in the rail; waits for the sign-in page. */
export async function signOut(page: Page): Promise<void> {
  await page.getByTestId("sign-out").click();
  await expect(page).toHaveURL(/\/login$/);
}

/** The API itself, for assertions on its JSON (the browser never calls it; tests may). */
export const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 4310}/api`;

/** A session of the test's own on the API (POST /api/login), as the Cookie header to send with direct calls. */
export async function apiSession(who: Who): Promise<string> {
  const r = await fetch(`${API}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: ACCOUNTS[who].username, password: E2E_PASSWORD }) });
  if (r.status !== 200) throw new Error(`API sign-in for ${who} failed: ${r.status} ${await r.text()}`);
  return r.headers.getSetCookie().find((c) => c.startsWith("contra_session="))!.split(";")[0]!;
}

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
