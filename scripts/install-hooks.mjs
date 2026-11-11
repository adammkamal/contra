// Cross-platform (Windows-safe) install of the protected-files pre-commit hook. Run: npm run hooks
import { copyFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
if (!existsSync(".git")) { console.error("Run `git init` first."); process.exit(1); }
const dest = join(".git", "hooks", "pre-commit");
copyFileSync(join("scripts", "protect.sh"), dest);
try { chmodSync(dest, 0o755); } catch { /* Windows: Git Bash runs it regardless */ }
console.log("Installed .git/hooks/pre-commit (protects INVARIANTS.md, demo/invariant tests, bench/labels, bench/heldout/labels, bench/fresh/labels).");
