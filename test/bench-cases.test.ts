import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const dir = join(import.meta.dirname, "..", "bench", "cases");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const EXPECTED_IDS = Array.from({ length: 20 }, (_, i) => `bc-${String(i + 1).padStart(2, "0")}`);
const FORBIDDEN = new Set(["link", "expected", "label", "answer", "disputed", "amountCents"]);
const EMAIL_FIELDS = ["id", "from", "to", "subject", "receivedAt", "body"];

const keysDeep = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysDeep(x, out); }
  return out;
};

test("bench cases: exactly bc-01 ... bc-20", () => {
  assert.deepEqual(files, EXPECTED_IDS.map((id) => `${id}.json`));
});

for (const f of files) {
  const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
  const id = f.replace(/\.json$/, "");

  test(`bench case ${id}: id, description and a complete email`, () => {
    assert.deepEqual(Object.keys(raw).sort(), ["description", "email", "id"]);
    assert.equal(raw.id, id);
    assert.ok(typeof raw.description === "string" && raw.description.trim().length > 0);
    const email = raw.email as Record<string, unknown>;
    assert.deepEqual(Object.keys(email).sort(), [...EMAIL_FIELDS].sort());
    for (const k of EMAIL_FIELDS) assert.ok(typeof email[k] === "string" && (email[k] as string).trim().length > 0, `email.${k}`);
    assert.equal(email.id, id);
    assert.ok(!Number.isNaN(new Date(email.receivedAt as string).getTime()), "receivedAt parses");
  });

  test(`bench case ${id}: no answer fields anywhere`, () => {
    const bad = keysDeep(raw).filter((k) => FORBIDDEN.has(k));
    assert.deepEqual(bad, []);
  });
}

const heldoutDir = join(import.meta.dirname, "..", "bench", "heldout", "cases");
for (const f of readdirSync(heldoutDir).filter((f) => f.endsWith(".json")).sort()) {
  const raw = JSON.parse(readFileSync(join(heldoutDir, f), "utf8")) as Record<string, unknown>;
  const id = f.replace(/\.json$/, "");

  test(`held-out case ${id}: id, description, a complete email and no answer fields`, () => {
    assert.match(id, /^ho-\d\d$/);
    assert.deepEqual(Object.keys(raw).sort(), ["description", "email", "id"]);
    assert.equal(raw.id, id);
    const email = raw.email as Record<string, unknown>;
    assert.deepEqual(Object.keys(email).sort(), [...EMAIL_FIELDS].sort());
    for (const k of EMAIL_FIELDS) assert.ok(typeof email[k] === "string" && (email[k] as string).trim().length > 0, `email.${k}`);
    assert.equal(email.id, id);
    assert.ok(!Number.isNaN(new Date(email.receivedAt as string).getTime()), "receivedAt parses");
    assert.deepEqual(keysDeep(raw).filter((k) => FORBIDDEN.has(k)), []);
  });
}
