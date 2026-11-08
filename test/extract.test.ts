import assert from "node:assert/strict";
import { test } from "node:test";
import { callTool, normalizeApiKey, settingsFromEnv } from "../src/extract/anthropic.ts";
import { extractBackCharges, extractResponse } from "../src/extract/index.ts";
import { BACKCHARGE_TOOL } from "../src/extract/prompt.ts";
import { parseBackCharges, parseResponse } from "../src/extract/validate.ts";
import { demoSeed } from "../src/seed.ts";
import { verifyAmountEvidence } from "../src/span.ts";

const seed = demoSeed(new Date("2026-11-07T15:00:00Z"));
const E1 = seed.emails[0]!;
const S = { apiKey: "sk-test", model: "claude-test" };
const noSleep = { sleep: async () => {} };

const toolResponse = (input: unknown, name = "record_back_charges") =>
  new Response(JSON.stringify({ model: "claude-test-1", content: [{ type: "tool_use", name, input }] }), { status: 200 });

const E1_OUTPUT = {
  items: [
    { ref: "BC-4467", description: "Replace damaged ceiling grid, L2", amountText: "$6,800.00", amountSentence: "BC-4467: replace damaged ceiling grid, L2, $6,800.00 per the Apex Ceilings invoice.", vendorNameAsWritten: "Ridgeline Drywall", jobRef: "Summit", disputeNoted: false },
    { ref: "bc 4468", description: "Debris haul-off", amountText: "$4,700.00", amountSentence: "BC-4468: debris haul-off, $4,700.00.", vendorNameAsWritten: "Ridgeline Drywall", jobRef: "Summit", disputeNoted: false },
  ],
};

test("happy path: tool output becomes cents from the copied text, and spans verify", async () => {
  let sent: RequestInit | undefined;
  const fetcher = (async (_url: string, init: RequestInit) => { sent = init; return toolResponse(E1_OUTPUT); }) as unknown as typeof fetch;
  const r = await extractBackCharges(S, E1, { fetcher });
  assert.ok(r.ok);
  assert.deepEqual(r.items.map((x) => [x.ref, x.amountCents]), [["BC-4467", 680_000], ["BC-4468", 470_000]]);
  for (const x of r.items) assert.ok(verifyAmountEvidence(E1, x.amountEvidence, x.amountCents).ok);
  assert.deepEqual(r.actor, { kind: "llm", id: "extractor", model: "claude-test-1" });
  const body = JSON.parse(String(sent!.body));
  assert.equal(body.tool_choice.name, "record_back_charges");
  assert.equal(body.temperature, 0);
  assert.match(body.messages[0].content, /<email id="E-1">/);
  assert.equal((sent!.headers as Record<string, string>)["x-api-key"], "sk-test");
  assert.doesNotMatch(String(sent!.body), /sk-test/); // key only in the header
});

test("validation rejects numeric money, two amounts, invented refs, extra fields and duplicates", () => {
  const base = E1_OUTPUT.items[0]!;
  const out = parseBackCharges({ items: [
    { ...base, amountText: "6800" },
    { ...base, ref: "BC-1001", amountText: "$6,800.00 and $10.00" },
    { ...base, ref: "Item 7" },
    { ...base, ref: "BC-1002", amountCents: 680000 },
    { ...base, ref: "BC-1003", amountText: "$9,999.00" },
    base,
    base,
  ] }, E1);
  assert.equal(out.items.length, 1);
  assert.deepEqual(out.rejected.map((r) => r.index), [0, 1, 2, 3, 4, 6]);
  assert.match(out.rejected[4]!.reason, /not inside amountSentence/);
  assert.match(out.rejected[5]!.reason, /appears twice/);
  assert.deepEqual(parseBackCharges({ items: [], note: "x" }, E1).rejected[0]!.reason, "output is not {items: [...]}");
});

test("a dispute flagged without its sentence still counts as a dispute", () => {
  const out = parseBackCharges({ items: [{ ...E1_OUTPUT.items[0]!, disputeNoted: true }] }, E1);
  assert.equal(out.items[0]!.disputeNoted, true);
  assert.equal(out.items[0]!.disputeEvidence!.sentence, "");
});

test("reply parsing: refs must be in the notice; accepted+disputed contradiction counts as disputed", () => {
  const email = { ...E1, id: "E-4" };
  const ok = parseResponse({ disputedRefs: ["4471", "BC-4471"].slice(1), acceptedRefs: ["BC-4467", "bc-4471"], evidenceSentence: "Fine, except 4471." }, email, "N-1", ["BC-4467", "BC-4468", "BC-4471"]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.acceptedRefs, ["BC-4467"]);
  const bad = parseResponse({ disputedRefs: ["BC-9999"], acceptedRefs: [], evidenceSentence: "x y z" }, email, "N-1", ["BC-4467"]);
  assert.ok(!bad.ok);
});

test("transport: retries once on 529, never reads error bodies, maps statuses", async () => {
  let calls = 0;
  const flaky = (async () => (++calls === 1 ? new Response("overloaded", { status: 529 }) : toolResponse(E1_OUTPUT))) as unknown as typeof fetch;
  assert.equal((await callTool(S, { system: "s", user: "u", tool: BACKCHARGE_TOOL }, { fetcher: flaky, ...noSleep })).status, "OK");
  assert.equal(calls, 2);

  let read = false;
  const secretEcho = (async () => {
    const r = new Response("echo of the request with secrets", { status: 400 });
    const orig = r.text.bind(r);
    Object.defineProperty(r, "text", { value: async () => { read = true; return orig(); } });
    return r;
  }) as unknown as typeof fetch;
  const e = await callTool(S, { system: "s", user: "u", tool: BACKCHARGE_TOOL }, { fetcher: secretEcho, ...noSleep });
  assert.deepEqual([e.status, read], ["MODEL_ERROR", false]);

  const unauthorized = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
  assert.equal((await callTool(S, { system: "s", user: "u", tool: BACKCHARGE_TOOL }, { fetcher: unauthorized })).status, "INVALID_CREDENTIAL");
});

test("transport: timeout, network error, oversized and wrong-shape responses fail closed", async () => {
  const hang = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
  assert.equal((await callTool(S, { system: "s", user: "u", tool: BACKCHARGE_TOOL }, { fetcher: hang, timeoutMs: 20 })).status, "TIMEOUT");
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.equal((await callTool(S, { system: "s", user: "u", tool: BACKCHARGE_TOOL }, { fetcher: down })).status, "NETWORK_ERROR");
  const huge = (async () => new Response("x".repeat(300_000), { status: 200 })) as unknown as typeof fetch;
  assert.equal((await callTool(S, { system: "s", user: "u", tool: BACKCHARGE_TOOL }, { fetcher: huge })).status, "INVALID_OUTPUT");
  const twoCalls = (async () => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "record_back_charges", input: {} }, { type: "tool_use", name: "record_back_charges", input: {} }] }), { status: 200 })) as unknown as typeof fetch;
  assert.equal((await callTool(S, { system: "s", user: "u", tool: BACKCHARGE_TOOL }, { fetcher: twoCalls })).status, "INVALID_OUTPUT");
});

test("API key hygiene: trailing newline trimmed, control characters refused before any request", async () => {
  assert.deepEqual(normalizeApiKey("sk-abc\r\n"), { ok: true, key: "sk-abc" });
  assert.equal(normalizeApiKey("sk-a\u0000bc").ok, false);
  assert.equal(normalizeApiKey("   ").ok, false);
  let called = false;
  const f = (async () => { called = true; return toolResponse({}); }) as unknown as typeof fetch;
  const r = await callTool({ apiKey: "sk-\nbad", model: "m" }, { system: "s", user: "u", tool: BACKCHARGE_TOOL }, { fetcher: f });
  assert.deepEqual([r.status, called], ["INVALID_CREDENTIAL", false]);
  assert.equal(settingsFromEnv({}).ok, false);
  const s = settingsFromEnv({ ANTHROPIC_API_KEY: "sk-x\n" });
  assert.ok(s.ok && s.settings.apiKey === "sk-x" && s.settings.model === "claude-opus-5-5");
});

test("extractResponse wires the notice refs into the prompt and validates against them", async () => {
  let body = "";
  const f = (async (_u: string, init: RequestInit) => { body = String(init.body); return toolResponse({ disputedRefs: ["BC-4471"], acceptedRefs: ["BC-4467", "BC-4468"], evidenceSentence: "Fine, except 4471." }, "record_response"); }) as unknown as typeof fetch;
  const r = await extractResponse(S, { ...E1, id: "E-4" }, { id: "N-1", backChargeRefs: ["BC-4467", "BC-4468", "BC-4471"] }, { fetcher: f });
  assert.ok(r.ok);
  assert.match(JSON.parse(body).messages[0].content, /Notice N-1 listed: BC-4467, BC-4468, BC-4471/);
});

test("amountText with two dollar figures is rejected even when it is inside the sentence", () => {
  const email = { ...E1, id: "E-9", body: "BC-1001: $500.00 labor plus $200.00 disposal." };
  const out = parseBackCharges({ items: [{ ...E1_OUTPUT.items[0]!, ref: "BC-1001", amountText: "$500.00 labor plus $200.00", amountSentence: "BC-1001: $500.00 labor plus $200.00 disposal." }] }, email);
  assert.equal(out.items.length, 0);
  assert.match(out.rejected[0]!.reason, /not exactly one \$ amount/);
});
