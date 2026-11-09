/**
 * Writes contract/samples/: the exact JSON the frontend receives at every demo step, so the frontend
 * can be built and styled without running the backend.  npm run contract:samples
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "../src/app.ts";
import * as cmd from "../src/commands.ts";
import { backChargeDetail, buildScreens, nextStep } from "../src/view.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "contract", "samples");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const write = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 2) + "\n");

const tmp = mkdtempSync(join(tmpdir(), "contra-samples-"));
const app = new App(join(tmp, "s.db"), { start: new Date("2026-11-07T15:00:00Z") });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);

let i = 0;
write(`${String(i).padStart(2, "0")}-${slug(nextStep(app).text)}.screens.json`, buildScreens(app));
for (;;) {
  const step = nextStep(app);
  if (!step.action) break;
  if (step.action.command === "ingestPmEmails") cmd.ingestPmEmails(app, { fixturesDir: null });
  else cmd.runAction(app, step.action);
  i++;
  write(`${String(i).padStart(2, "0")}-after-${slug(step.text)}.screens.json`, buildScreens(app));
  if (i > 40) throw new Error("demo did not finish");
}
for (const ref of ["BC-4467", "BC-4470", "BC-4471"]) write(`detail-${ref}.json`, backChargeDetail(app, ref));
write("memo-VC-1.json", app.ctx.contra.creditMemo("VC-1"));
app.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${i + 1} screen states + 3 details + 1 memo to contract/samples/`);
