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

const freshDir = join(import.meta.dirname, "..", "bench", "fresh", "cases");
const freshFiles = readdirSync(freshDir).filter((f) => f.endsWith(".json")).sort();

test("fresh cases: exactly fh-01 ... fh-08, written outside the team", () => {
  assert.deepEqual(freshFiles, Array.from({ length: 8 }, (_, i) => `fh-0${i + 1}.json`));
});

for (const f of freshFiles) {
  const raw = JSON.parse(readFileSync(join(freshDir, f), "utf8")) as Record<string, unknown>;
  const id = f.replace(/\.json$/, "");

  test(`fresh case ${id}: id, the fixed description, a complete email and no answer fields`, () => {
    assert.deepEqual(Object.keys(raw).sort(), ["description", "email", "id"]);
    assert.equal(raw.id, id);
    assert.equal(raw.description, "independent held-out case");
    const email = raw.email as Record<string, unknown>;
    assert.deepEqual(Object.keys(email).sort(), [...EMAIL_FIELDS].sort());
    for (const k of EMAIL_FIELDS) assert.ok(typeof email[k] === "string" && (email[k] as string).trim().length > 0, `email.${k}`);
    assert.equal(email.id, id);
    assert.ok(!Number.isNaN(new Date(email.receivedAt as string).getTime()), "receivedAt parses");
    assert.deepEqual(keysDeep(raw).filter((k) => FORBIDDEN.has(k)), []);
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

const fresh2Dir = join(import.meta.dirname, "..", "bench", "fresh2", "cases");
const fresh2Files = readdirSync(fresh2Dir).filter((f) => f.endsWith(".json")).sort();

test("fresh2 cases: exactly fh-09 ... fh-16, written outside the team, one day apart in file order", () => {
  assert.deepEqual(fresh2Files, Array.from({ length: 8 }, (_, i) => `fh-${String(9 + i).padStart(2, "0")}.json`));
  const dates = fresh2Files.map((f) => new Date((JSON.parse(readFileSync(join(fresh2Dir, f), "utf8")) as { email: { receivedAt: string } }).email.receivedAt).getTime());
  dates.slice(1).forEach((d, i) => assert.equal(d - dates[i]!, 86_400_000, `${fresh2Files[i + 1]} is one day after ${fresh2Files[i]}`));
});

for (const f of fresh2Files) {
  const raw = JSON.parse(readFileSync(join(fresh2Dir, f), "utf8")) as Record<string, unknown>;
  const id = f.replace(/\.json$/, "");

  test(`fresh2 case ${id}: id, the fixed description, a complete email and no answer fields`, () => {
    assert.deepEqual(Object.keys(raw).sort(), ["description", "email", "id"]);
    assert.equal(raw.id, id);
    assert.equal(raw.description, "independent held-out case");
    const email = raw.email as Record<string, unknown>;
    assert.deepEqual(Object.keys(email).sort(), [...EMAIL_FIELDS].sort());
    for (const k of EMAIL_FIELDS) assert.ok(typeof email[k] === "string" && (email[k] as string).trim().length > 0, `email.${k}`);
    assert.equal(email.id, id);
    assert.equal(email.from, "dana.ortiz@apexbuilders.example");
    assert.equal(email.to, "contra.demo+backcharges@example.com");
    assert.deepEqual(keysDeep(raw).filter((k) => FORBIDDEN.has(k)), []);
  });
}
