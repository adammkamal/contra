/**
 * Adds an account to data/auth.db (or CONTRA_AUTH_DB).
 *   npm run user:add -- <username> <pm|controller|ap> [--live]
 * The password is asked for, never taken as an argument, never echoed and never printed. On a terminal it
 * is typed twice, hidden; from a pipe, the first line is read (for scripts and tests).
 * --live: the account may open the live workspace (real Gmail, real memo emails). Without it, only the
 * scripted demo.
 */
import { AuthStore, authDbFromEnv, parseUserAddArgs, passwordProblem } from "../server/auth.ts";
import { ROLE_WORDS } from "../src/types.ts";

/** Reads one line from a terminal with echo off. Ctrl+C cancels. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let chars: string[] = [];
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return resolve(chars.join(""));
        }
        if (ch === "\u0003") {
          finish();
          return reject(new Error("cancelled; nothing was added"));
        }
        if (ch === "\u007f" || ch === "\b") chars = chars.slice(0, -1);
        else chars.push(ch);
      }
    };
    stdin.on("data", onData);
  });
}

/** The first line of a piped stdin. */
async function readPipedLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
}

async function main(): Promise<number> {
  const args = parseUserAddArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(args);
    return 2;
  }
  const path = authDbFromEnv(process.env);
  const store = new AuthStore(path);
  try {
    if (store.user(args.username)) {
      console.error(`user ${args.username} already exists in ${path}; nothing changed`);
      return 1;
    }
    const tty = !!process.stdin.isTTY;
    const password = tty ? await readHidden(`Password for ${args.username}: `) : await readPipedLine();
    const bad = passwordProblem(password);
    if (bad) {
      console.error(`${bad}; nothing was added`);
      return 1;
    }
    if (tty && (await readHidden("Type it again: ")) !== password) {
      console.error("the two passwords differ; nothing was added");
      return 1;
    }
    await store.addUser(args.username, args.role, password, { live: args.live });
    console.log(`added ${args.username} (${ROLE_WORDS[args.role]}, ${args.live ? "demo and live workspaces" : "demo workspace only"}) to ${path}`);
    return 0;
  } finally {
    store.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : "failed; nothing was added");
    process.exit(1);
  },
);
