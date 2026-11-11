/**
 * Accounts and sessions for the API (server-side only; src/ knows nothing of them). node:sqlite and
 * node:crypto, no dependencies.
 *
 * - Users live in data/auth.db (gitignored): username, role (pm | controller | ap), live (may use the live
 *   workspace: real Gmail, real memo emails), and a scrypt hash with a per-user random salt. The cost
 *   parameters are stored with each hash.
 * - Sessions: a random 256-bit id, given to the browser once in an HttpOnly cookie. The table stores only
 *   its SHA-256, so the database never holds a usable session id. Each session expires (absolute, 12 h by
 *   default); an expired one is deleted when seen.
 * - Passwords and session ids are never logged, returned in a body or stored in the clear.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Role } from "../src/types.ts";

export const ROLES: readonly Role[] = ["pm", "controller", "ap"];
export const DEFAULT_AUTH_DB = "data/auth.db";
export const SESSION_COOKIE = "contra_session";
export const SESSION_TTL_MS = 12 * 3_600_000;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 1024;
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export interface User {
  username: string;
  role: Role;
  /** May use the live workspace (created with --live). */
  live: boolean;
}

export interface Session {
  user: User;
  expiresAt: Date;
}

/** scrypt cost. N=2^15 by default (OWASP's minimum for scrypt); tests pass a lower N to run fast. */
export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}
export const DEFAULT_COST: ScryptCost = { N: 2 ** 15, r: 8, p: 1 };
const KEYLEN = 64;

const scrypt = (password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const opts: ScryptOptions = { ...cost, maxmem: 256 * cost.N * cost.r };
    scryptCb(password.normalize("NFC"), salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });

/** "scrypt$N$r$p$<salt b64>$<hash b64>" */
async function hashPassword(password: string, cost: ScryptCost): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, cost);
  return ["scrypt", cost.N, cost.r, cost.p, salt.toString("base64"), key.toString("base64")].join("$");
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === want.length && timingSafeEqual(got, want);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Why a username can't be used, or null. */
export function usernameProblem(u: string): string | null {
  return USERNAME.test(u) ? null : "a username is 2-32 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit";
}

/** Why a password can't be used, or null. */
export function passwordProblem(p: string): string | null {
  if ([...p].length < PASSWORD_MIN) return `a password needs at least ${PASSWORD_MIN} characters`;
  if (p.length > PASSWORD_MAX) return `a password has at most ${PASSWORD_MAX} characters`;
  return null;
}

export class AuthStore {
  readonly #db: DatabaseSync;
  readonly #cost: ScryptCost;
  /** Verified against when the username doesn't exist, so a wrong name costs the same time as a wrong password. */
  #dummy: Promise<string> | null = null;

  constructor(path: string, opts: { cost?: ScryptCost } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#cost = opts.cost ?? DEFAULT_COST;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('pm', 'controller', 'ap')),
        live INTEGER NOT NULL CHECK (live IN (0, 1)),
        password TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id_sha256 TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  async addUser(username: string, role: Role, password: string, opts: { live?: boolean; now?: Date } = {}): Promise<User> {
    const bad = usernameProblem(username) ?? (ROLES.includes(role) ? null : `role must be one of: ${ROLES.join(", ")}`) ?? passwordProblem(password);
    if (bad) throw new Error(bad);
    if (this.user(username)) throw new Error(`user ${username} already exists`);
    const hash = await hashPassword(password, this.#cost);
    // `now` only stamps created_at; it never decides anything.
    this.#db.prepare("INSERT INTO users (username, role, live, password, created_at) VALUES (?, ?, ?, ?, ?)").run(username, role, opts.live ? 1 : 0, hash, (opts.now ?? new Date()).toISOString());
    return { username, role, live: !!opts.live };
  }

  user(username: string): User | null {
    const r = this.#db.prepare("SELECT username, role, live FROM users WHERE username = ?").get(username) as { username: string; role: Role; live: number } | undefined;
    return r ? { username: r.username, role: r.role, live: r.live === 1 } : null;
  }

  userCount(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  /** The user when the password matches, else null. Takes about the same time for an unknown username. */
  async verify(username: string, password: string): Promise<User | null> {
    if (password.length > PASSWORD_MAX) return null;
    const r = this.#db.prepare("SELECT password FROM users WHERE username = ?").get(username) as { password: string } | undefined;
    if (!r) {
      this.#dummy ??= hashPassword("not a real password", this.#cost);
      await checkPassword(password, await this.#dummy);
      return null;
    }
    return (await checkPassword(password, r.password)) ? this.user(username) : null;
  }

  /** Starts a session. Returns the raw id, which only the cookie ever carries. */
  createSession(username: string, nowMs: number, ttlMs = SESSION_TTL_MS): { id: string; expiresAt: Date } {
    this.#db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowMs);
    const id = randomBytes(32).toString("base64url");
    this.#db.prepare("INSERT INTO sessions (id_sha256, username, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(id), username, nowMs, nowMs + ttlMs);
    return { id, expiresAt: new Date(nowMs + ttlMs) };
  }

  /** The session for a raw id, or null when unknown or expired (an expired one is deleted). */
  session(id: string, nowMs: number): Session | null {
    if (!id || id.length > 100) return null;
    const key = sha256(id);
    const r = this.#db.prepare("SELECT username, expires_at FROM sessions WHERE id_sha256 = ?").get(key) as { username: string; expires_at: number } | undefined;
    if (!r) return null;
    if (r.expires_at <= nowMs) {
      this.#db.prepare("DELETE FROM sessions WHERE id_sha256 = ?").run(key);
      return null;
    }
    const user = this.user(r.username);
    return user ? { user, expiresAt: new Date(r.expires_at) } : null;
  }

  endSession(id: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE id_sha256 = ?").run(sha256(id));
  }

  close(): void {
    this.#db.close();
  }
}

/** CONTRA_AUTH_DB, else data/auth.db. */
export const authDbFromEnv = (env: Record<string, string | undefined>) => (env.CONTRA_AUTH_DB ?? "").trim() || DEFAULT_AUTH_DB;

/**
 * npm run user:add -- <username> <role> [--live]. Anything else is refused, and the refusal never repeats
 * the arguments (one of them could be a password typed by mistake).
 */
export function parseUserAddArgs(argv: readonly string[]): { username: string; role: Role; live: boolean } | string {
  const usage = "usage: npm run user:add -- <username> <pm|controller|ap> [--live]   (you are asked for the password; it is never an argument)";
  const flags = argv.filter((a) => a.startsWith("-"));
  const pos = argv.filter((a) => !a.startsWith("-"));
  if (flags.some((f) => f !== "--live")) return `unknown option. ${usage}`;
  if (pos.length !== 2) return `expected exactly a username and a role. ${usage}`;
  const [username, role] = pos as [string, string];
  const bad = usernameProblem(username);
  if (bad) return bad;
  if (!ROLES.includes(role as Role)) return `role must be one of: ${ROLES.join(", ")}`;
  return { username, role: role as Role, live: flags.includes("--live") };
}

/** The session cookie's value from a Cookie header, or "". */
export function sessionIdFrom(cookieHeader: string | undefined): string {
  for (const part of (cookieHeader ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return "";
}

/** Set-Cookie for a new session (or, with id "" and maxAgeS 0, one that clears it). */
export function sessionCookie(id: string, maxAgeS: number, secure: boolean): string {
  return [`${SESSION_COOKIE}=${id}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeS}`, ...(secure ? ["Secure"] : [])].join("; ");
}

const WINDOW_MS = 15 * 60_000;

export interface LoginLimits {
  /** Failures from one client IP (any usernames) before that IP is refused. Default 20. */
  perIp: number;
  /** Failures for one username from one client IP before that pair is refused. Default 5. */
  perUserIp: number;
  /** Failures for one username (any IPs) before its sign-ins are slowed down. Default 5. */
  backoffAfter: number;
  /** The first delay; it doubles with each further failure, up to backoffMaxMs. Default 500 ms / 8 s. */
  backoffBaseMs: number;
  backoffMaxMs: number;
}
export const DEFAULT_LOGIN_LIMITS: LoginLimits = { perIp: 20, perUserIp: 5, backoffAfter: 5, backoffBaseMs: 500, backoffMaxMs: 8000 };

/**
 * Failed-login limits on one injected clock, over a rolling 15 minutes. A restart resets the counts.
 * - Refused with 429 before the password is checked (right password or not): a client IP with `perIp`
 *   failures, and a username + client IP pair with `perUserIp` failures. So a stranger's guesses lock only
 *   the stranger's own address, never the account itself.
 * - A username alone is never locked. After `backoffAfter` failures from anywhere, each sign-in for it is
 *   answered only after a delay (doubling, capped): guessing slows down, and the real person still gets in.
 * - A successful sign-in clears that username's failures (its delay) and that pair's.
 */
export function loginLimiter(limits: LoginLimits, now: () => number) {
  const fails = { ip: new Map<string, number[]>(), user: new Map<string, number[]>(), pair: new Map<string, number[]>() };
  const pairKey = (ip: string, username: string) => JSON.stringify([ip, username]);
  const recent = (m: Map<string, number[]>, k: string) => {
    const t = now();
    const v = (m.get(k) ?? []).filter((s) => s > t - WINDOW_MS);
    if (v.length) m.set(k, v);
    else m.delete(k);
    return v;
  };
  const prune = (m: Map<string, number[]>) => {
    if (m.size > 10_000) for (const k of [...m.keys()]) recent(m, k);
  };
  return {
    /** Why this attempt is refused, or null. */
    blocked(ip: string, username: string): string | null {
      if (recent(fails.ip, ip).length >= limits.perIp) return "too many failed sign-ins from your address; try again in 15 minutes";
      if (recent(fails.pair, pairKey(ip, username)).length >= limits.perUserIp) return "too many failed sign-ins for this username from your address; try again in 15 minutes";
      return null;
    },
    /** How long to wait before checking a password for this username (0 until backoffAfter failures). */
    delayMs(username: string): number {
      const extra = recent(fails.user, username).length - limits.backoffAfter;
      return extra < 0 ? 0 : Math.min(limits.backoffBaseMs * 2 ** Math.min(extra, 30), limits.backoffMaxMs);
    },
    failed(ip: string, username: string): void {
      for (const m of Object.values(fails)) prune(m);
      fails.ip.set(ip, [...recent(fails.ip, ip), now()]);
      fails.user.set(username, [...recent(fails.user, username), now()]);
      fails.pair.set(pairKey(ip, username), [...recent(fails.pair, pairKey(ip, username)), now()]);
    },
    succeeded(ip: string, username: string): void {
      fails.user.delete(username);
      fails.pair.delete(pairKey(ip, username));
    },
  };
}
