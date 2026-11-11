import type { AuthOptions } from "../server/api.ts";
import { AuthStore, type ScryptCost } from "../server/auth.ts";
import type { Role } from "../src/types.ts";

// Test accounts only: made-up names and a made-up password, in an in-memory database.

/** Cheap scrypt so tests run fast. The cost is stored with each hash, so verify uses the same. */
export const TEST_COST: ScryptCost = { N: 1024, r: 8, p: 1 };
export const TEST_PASSWORD = "test-only password 7c41e2";

/** An in-memory account store for one API server. */
export const testAuth = (extra: Partial<AuthOptions> = {}): AuthOptions => ({ store: new AuthStore(":memory:", { cost: TEST_COST }), ...extra });

/**
 * Adds the user to `auth` (once) and signs in over HTTP. Returns the Cookie header to send. Default: a
 * live PM named "tester", which can reach both workspaces.
 */
export async function signIn(base: string, authOrStore: AuthOptions | AuthStore, user: { username?: string; role?: Role; live?: boolean } = {}): Promise<string> {
  const auth = authOrStore instanceof AuthStore ? { store: authOrStore } : authOrStore;
  const username = user.username ?? "tester";
  if (!auth.store.user(username)) await auth.store.addUser(username, user.role ?? "pm", TEST_PASSWORD, { live: user.live ?? true });
  const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: TEST_PASSWORD }) });
  if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${await r.text()}`);
  const set = r.headers.get("set-cookie") ?? "";
  return set.split(";")[0]!;
}

/** fetch that sends `cookie` with every request (on top of the request's own headers). */
export const withCookie =
  (cookie: string): typeof fetch =>
  (input, init = {}) =>
    fetch(input, { ...init, headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), cookie } });

/**
 * A fetch that sends the current session cookie (once `use` is called) with every request. For test
 * files whose helpers predate sign-in: replace their `fetch(` with `http.fetch(` and sign in per server.
 */
export function sessionFetch() {
  let cookie = "";
  return {
    fetch: ((input, init = {}) => fetch(input, { ...init, headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), ...(cookie ? { cookie } : {}) } })) as typeof fetch,
    use: (c: string) => void (cookie = c),
    get cookie() {
      return cookie;
    },
  };
}

/** The role a step needs (src/roles.ts): controller decides credits, AP turns credits on, a PM the rest. */
export const roleFor = (command: string): Role => (command === "approveCredit" || command === "rejectCredit" ? "controller" : command === "turnOnCredits" ? "ap" : "pm");

/** Signs in one live account per role ("tester" is the PM). Returns each one's Cookie header. */
export async function signInRoles(base: string, store: AuthStore): Promise<Record<Role, string>> {
  return {
    pm: await signIn(base, store),
    controller: await signIn(base, store, { username: "ctl.tester", role: "controller" }),
    ap: await signIn(base, store, { username: "ap.tester", role: "ap" }),
  };
}
