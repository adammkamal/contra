/**
 * The e2e accounts. Made-up names and a made-up password; e2e/api-harness.ts creates them in its temporary
 * auth database, and the tests sign in with them through the real sign-in page.
 */
export const E2E_PASSWORD = "e2e-only password 51d0c3";

export const ACCOUNTS = {
  /** Presents the scripted demo; no --live, so the live workspace is refused (403). */
  presenter: { username: "e2e.presenter", role: "pm", live: false },
  pm: { username: "e2e.pm", role: "pm", live: true },
  controller: { username: "e2e.controller", role: "controller", live: true },
  ap: { username: "e2e.ap", role: "ap", live: true },
} as const;

export type Who = keyof typeof ACCOUNTS;
