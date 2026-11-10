/** A fake Gmail + Google token endpoint for tests. Every message here is made up. No network. */
import { request } from "node:http";
import type { GmailConfig, Transport } from "../server/gmail.ts";
import { cents } from "../src/money.ts";
import type { Actor, Email, ExtractedBackCharge } from "../src/types.ts";

export const SECRETS = { refreshToken: "REFRESH-TOKEN-7d1e9f", clientSecret: "CLIENT-SECRET-4b2a8c", accessToken: "ACCESS-TOKEN-c03f55" };

export const CONFIG: GmailConfig = {
  address: "demo.tester@example.com",
  clientId: "client-id-123.apps.example",
  clientSecret: SECRETS.clientSecret,
  refreshToken: SECRETS.refreshToken,
  intake: "demo.tester+backcharges@example.com",
  apInbox: "demo.tester+ramp-ap@example.com",
  allowedSenders: ["@apexbuilders.example"],
};

export interface FakeMessage {
  id: string;
  /** The whole RFC 822 text. */
  raw: string;
  /** Overrides the size Gmail reports (sizeEstimate). */
  size?: number;
}

/** What Gmail writes above a message whose sender passed DKIM and SPF for `domain` (made-up values). */
export const gmailAuthPass = (domain: string, local = "dana.ortiz") =>
  `mx.google.com; dkim=pass header.i=@${domain} header.s=s1 header.b=AbCdEf12; spf=pass (google.com: domain of ${local}@${domain} designates 192.0.2.10 as permitted sender) smtp.mailfrom=${local}@${domain}; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=${domain}`;

/**
 * An RFC 822 message with CRLF line endings. By default it is from dana.ortiz@apexbuilders.example and Gmail's
 * Authentication-Results (first, as Gmail adds it) passes for that domain; `authResults: []` leaves it out.
 */
export function rfc822(o: { messageId: string; deliveredTo: string; subject: string; body: string; extraHeaders?: string[]; from?: string; authResults?: string[] }): string {
  const from = o.from ?? "Dana Ortiz <dana.ortiz@apexbuilders.example>";
  return [
    ...(o.authResults ?? [gmailAuthPass("apexbuilders.example")]).map((v) => `Authentication-Results: ${v}`),
    `Delivered-To: ${o.deliveredTo}`,
    `Message-ID: <${o.messageId}>`,
    "Date: Tue, 10 Nov 2026 15:00:00 +0000",
    `From: ${from}`,
    `To: ${o.deliveredTo}`,
    `Subject: ${o.subject}`,
    ...(o.extraHeaders ?? []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body,
  ].join("\r\n");
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function headersOf(raw: string): { name: string; value: string }[] {
  const block = raw.split(/\r?\n\r?\n/)[0]!;
  return block.split(/\r?\n/).map((l) => {
    const i = l.indexOf(":");
    return { name: l.slice(0, i), value: l.slice(i + 1).trim() };
  });
}

export type TokenMode = "ok" | "invalid_grant" | "server_error";

/**
 * The fake. Error responses deliberately echo the secrets in their bodies, so a test can prove they are
 * never passed on. `gate` (optional) is awaited before answering the list call (to hold a poll open).
 */
export function fakeGmail(o: { messages?: FakeMessage[]; token?: TokenMode; listStatus?: number; sendStatus?: number; gate?: Promise<void> } = {}) {
  const calls: { url: string; method: string; body: string }[] = [];
  const sent: string[] = [];
  const echo = JSON.stringify({ error: { code: 500, message: `boom ${SECRETS.refreshToken} ${SECRETS.clientSecret} ${SECRETS.accessToken}` } });
  const transport: Transport = async (url, init = {}) => {
    const body = init.body === undefined || init.body === null ? "" : String(init.body);
    calls.push({ url, method: init.method ?? "GET", body });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      if (o.token === "invalid_grant") return new Response(JSON.stringify({ error: "invalid_grant", error_description: `Token has been expired or revoked: ${SECRETS.refreshToken}` }), { status: 400 });
      if (o.token === "server_error") return new Response(echo, { status: 500 });
      return new Response(JSON.stringify({ access_token: SECRETS.accessToken, expires_in: 3599, token_type: "Bearer" }), { status: 200 });
    }
    const auth = (init.headers as Record<string, string> | undefined)?.authorization;
    if (auth !== `Bearer ${SECRETS.accessToken}`) return new Response(echo, { status: 401 });
    const u = new URL(url);
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/messages" && (init.method ?? "GET") === "GET") {
      if (o.gate) await o.gate;
      if (o.listStatus && o.listStatus !== 200) return new Response(echo, { status: o.listStatus });
      return Response.json({ messages: (o.messages ?? []).map((m) => ({ id: m.id, threadId: m.id })) });
    }
    if (path === "/messages/send") {
      if (o.sendStatus && o.sendStatus !== 200) return new Response(echo, { status: o.sendStatus });
      sent.push(JSON.parse(body).raw as string);
      return Response.json({ id: `sent-${sent.length}` });
    }
    const m = /^\/messages\/([A-Za-z0-9]+)$/.exec(path);
    const msg = m ? (o.messages ?? []).find((x) => x.id === m[1]) : undefined;
    if (!msg) return new Response(echo, { status: 404 });
    if (u.searchParams.get("format") === "metadata") {
      const wanted = new Set(u.searchParams.getAll("metadataHeaders").map((h) => h.toLowerCase()));
      return Response.json({ id: msg.id, sizeEstimate: msg.size ?? Buffer.byteLength(msg.raw), payload: { headers: headersOf(msg.raw).filter((h) => wanted.has(h.name.toLowerCase())) } });
    }
    if (u.searchParams.get("format") === "raw") return Response.json({ id: msg.id, raw: b64url(msg.raw) });
    return new Response(echo, { status: 400 });
  };
  return { transport, calls, sent, rawFetched: () => calls.filter((c) => c.url.includes("format=raw")).map((c) => /messages\/([A-Za-z0-9]+)\?/.exec(c.url)![1]!) };
}

/** A fake extractor: one back-charge per email, read from a "BC-nnnn: ... $n.nn." sentence in the body. */
export function fakeExtract(vendor = "Harbor Mechanical Co", jobRef = "Summit") {
  let calls = 0;
  const actor: Actor = { kind: "llm", id: "extractor", model: "claude-test-1" };
  const extract = async (email: Email) => {
    calls++;
    const m = /(BC-\d{4}:[^\n]*?\$([\d,]+)\.(\d\d)\.)/.exec(email.body);
    const items: ExtractedBackCharge[] = m
      ? [{ ref: m[1]!.slice(0, 7), description: "test item", amountCents: cents(Number(m[2]!.replaceAll(",", "")) * 100 + Number(m[3])), amountEvidence: { emailId: email.id, sentence: m[1]! }, vendorNameAsWritten: vendor, jobRef, disputeNoted: false }]
      : [];
    return { ok: true as const, items, actor };
  };
  return { extract, calls: () => calls };
}

/** Collects a Server-Sent Events stream from GET /api/events. */
export function sseClient(port: number, headers: Record<string, string> = {}): Promise<{ text: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    let text = "";
    const req = request({ host: "127.0.0.1", port, path: "/api/events", headers }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("error", () => {});
      resolve({ text: () => text, close: () => req.destroy() });
    });
    req.on("error", (e) => (text ? undefined : reject(e)));
    req.end();
  });
}

export const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};
