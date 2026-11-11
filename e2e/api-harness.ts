/**
 * The API the Playwright suite runs against: the real server (createApiServer from server/api.ts, the same
 * code `npm run api` runs) on temp databases, with three things faked so no test touches the network:
 *  - the model call behind POST /api/try, through ApiOptions.try.callOptions.fetcher (the API's own
 *    injection point for a fake extractor); with dailyCap 1, so the second try shows the 429 daily cap;
 *  - Gmail, with the fake from test/gmail-fakes.ts (made-up messages) and a fake live extractor;
 *  - the memo sender: it fails once, then succeeds, so the UI shows failed and the retry.
 * The scripted demo uses its real .eml files and recorded extractions, as `npm run api` does.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../server/api.ts";
import { GmailClient, InboxPoller, type Extract } from "../server/gmail.ts";
import type { MemoSender } from "../src/memo.ts";
import { cents } from "../src/money.ts";
import type { Actor } from "../src/types.ts";
import { eml, png, textPdf } from "../test/attachment-fakes.ts";
import { CONFIG, fakeGmail, gmailAuthPass, rfc822 } from "../test/gmail-fakes.ts";

const PORT = Number(process.env.E2E_API_PORT ?? 4310);
const UI_ORIGIN = process.env.E2E_UI_ORIGIN ?? "http://localhost:3310";

/** "$1,240.00" -> 124000 cents, from the digits (no float arithmetic). */
const centsOf = (dollars: string, cc: string) => cents(Number(dollars.replaceAll(",", "") + cc));
const SENTENCE = /(BC-\d{4}:[^\n]*?\$([\d,]+)\.(\d\d)\.)/;

// ---- Live inbox: two made-up PM emails. "Ridgeline Drywall" links; "Ridgeline" alone is ambiguous on Summit.
const live = (id: string, sub: string, line: string) => ({
  id,
  raw: rfc822({ messageId: `${id}@pm.example`, deliveredTo: CONFIG.intake, subject: `Summit MOB back-charge ${id}`, body: `Hi,\r\n\r\nSub: ${sub}\r\n\r\n${line}\r\n\r\nDana` }),
});

// A third made-up email carries a text PDF (page 2 states BC-7611) and a photo (BC-7612, which a fake model
// "reads" from the image). Both files are generated here; nothing real.
const PDF_SENTENCE = "BC-7611: corridor wall repair, Summit, $1,250.00.";
const PHOTO_TEXT = "BC-7612 FLOOR PROTECTION $640.00";
const attachmentRaw = eml({
  id: "e2e03",
  subject: "Summit - estimate and ticket photo attached",
  body: "Hi,\n\nEstimate and a photo of the floor protection ticket attached.\n\nDana",
  parts: [
    { filename: "estimate.pdf", contentType: "application/pdf", data: await textPdf([["APEX BUILDERS - REPAIR ESTIMATE", "Subcontractor: Ridgeline Drywall"], ["Scope: patch corridor wall.", PDF_SENTENCE]]) },
    { filename: "IMG_2041.png", contentType: "image/png", data: png(40, 20) },
    { filename: "IMG_2042.heic", contentType: "image/heic", data: Buffer.from("not really a heic") },
  ],
}).toString("utf8");
const withGmailHeaders = (m: string) => [`Authentication-Results: ${gmailAuthPass("apexbuilders.example")}`, `Delivered-To: ${CONFIG.intake}`, m].join("\r\n");
const gmail = fakeGmail({
  messages: [
    { id: "e2e03", raw: withGmailHeaders(attachmentRaw) },
    live("e2e02", "Ridgeline", "BC-7402: clear framing debris from the level 2 corridor, Summit, $650.00."),
    live("e2e01", "Ridgeline Drywall", "BC-7401: patch the stair core drywall, Summit, $900.00."),
  ],
});
const LIVE_EXTRACTOR: Actor = { kind: "llm", id: "extractor", model: "e2e-fake-extractor" };
const extract: Extract = async (email, media) => {
  if (email.attachments?.length) {
    // Text PDF: cite the sentence from its page. Photo: the fake model "reads" the amount from the image.
    const items = [];
    for (const a of email.attachments) {
      if (a.read === "text") {
        const page = a.pages?.findIndex((p) => SENTENCE.test(p)) ?? -1;
        const m = page >= 0 ? SENTENCE.exec(a.pages![page]!) : null;
        if (m) items.push({ ref: m[1]!.slice(0, 7), description: "Corridor wall repair", amountCents: centsOf(m[2]!, m[3]!), amountEvidence: { emailId: email.id, sentence: m[1]!, at: { attachment: a.n, page: page + 1 } }, vendorNameAsWritten: "Ridgeline Drywall", jobRef: "Summit", disputeNoted: false });
      } else if (a.read === "image" && media.some((x) => x.n === a.n)) {
        items.push({ ref: "BC-7612", description: "Floor protection", amountCents: cents(64_000), amountEvidence: { emailId: email.id, sentence: PHOTO_TEXT, at: { attachment: a.n, page: 1 } }, vendorNameAsWritten: "Ridgeline Drywall", jobRef: "Summit", disputeNoted: false });
      }
    }
    return { ok: true, items, actor: LIVE_EXTRACTOR };
  }
  const m = SENTENCE.exec(email.body);
  const sub = /^Sub: (.+)$/m.exec(email.body)?.[1]?.trim() ?? "Unknown";
  if (!m) return { ok: true, items: [], actor: LIVE_EXTRACTOR };
  return {
    ok: true,
    actor: LIVE_EXTRACTOR,
    items: [{ ref: m[1]!.slice(0, 7), description: m[1]!.slice(9, m[1]!.indexOf(",")), amountCents: centsOf(m[2]!, m[3]!), amountEvidence: { emailId: email.id, sentence: m[1]! }, vendorNameAsWritten: sub, jobRef: "Summit", disputeNoted: false }],
  };
};
const poller = new InboxPoller({ client: new GmailClient(CONFIG, gmail.transport, Date.now), extract, now: Date.now });

// ---- Memo sender: the first send fails, every later one succeeds.
let sends = 0;
const memoSender: MemoSender = {
  destination: CONFIG.apInbox,
  send: async () => {
    sends++;
    if (sends === 1) throw new Error("Gmail API error (HTTP 500)");
    return { messageId: `e2e-memo-${sends}` };
  },
};

// ---- POST /api/try: a fake model answer built from the email's own BC sentence (never a real call).
const TRY_MODEL = "e2e-fake-model (no model call)";
const fetcher = (async (_url: string, init?: RequestInit) => {
  const req = JSON.parse(String(init?.body)) as { messages: { content: string }[]; tools: { name: string }[] };
  const text = req.messages[0]!.content;
  const m = SENTENCE.exec(text);
  const items = m
    ? [{ ref: m[1]!.slice(0, 7), description: "Ceiling tile and grid repair", amountText: `$${m[2]}.${m[3]}`, amountSentence: m[1]!, vendorNameAsWritten: "Harbor Mechanical Co", jobRef: "Summit MOB", disputeNoted: false }]
    : [];
  return new Response(JSON.stringify({ model: TRY_MODEL, content: [{ type: "tool_use", name: req.tools[0]!.name, input: { items } }] }), { status: 200 });
}) as unknown as typeof fetch;

const dir = mkdtempSync(join(tmpdir(), "contra-e2e-"));
const api = createApiServer({
  dbPath: join(dir, "demo.db"),
  liveDbPath: join(dir, "live.db"),
  start: new Date("2026-11-07T15:00:00Z"),
  allowedOrigins: [UI_ORIGIN],
  memoSender,
  inbox: { poller, intervalMs: 500 },
  try: { settings: () => ({ ok: true, settings: { apiKey: "e2e-fake-key", model: TRY_MODEL } }), dailyCap: 1, callOptions: { fetcher, maxRetries: 0 } },
});
api.server.listen(PORT, "127.0.0.1", () => {
  console.log(`e2e API harness on http://127.0.0.1:${PORT} (CORS for ${UI_ORIGIN}); data in ${dir}`);
  void api.pollNow();
});
